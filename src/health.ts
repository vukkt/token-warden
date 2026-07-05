/**
 * Rule health — a declarative governance flag for stale rules, plus the
 * per-task variance ranking of the golden suite.
 *
 * CLI: npx tsx src/health.ts [--agent <name>] [--stale-after <days>] [--gate]
 *
 * An active rule's measured savings can drift as the codebase and the agent's
 * prompt change. A rule that has not been re-audited in a while is a candidate
 * for re-validation. This flags those rules and recommends a controlled re-audit;
 * consistent with governance, it never auto-evicts — the frozen-fixture
 * `/warden-select` benchmark stays the only authority that removes a rule.
 * Protected (human-authored) rules are exempt: they are deliberately never
 * re-measured. `--gate` exits non-zero when anything is stale, for CI.
 *
 * The variance section ranks golden tasks by run-to-run noise (coefficient of
 * variation over recent active-set runs). A noisy task buries modest savings
 * under its own variance; the fix is splitting it into quieter tasks — by
 * ADDING task files, never editing frozen ones (invariant #4). Informational
 * only; it never affects --gate.
 */
import { pathToFileURL } from "node:url";
import { VARIANCE_WARN_RATIO } from "./bench.js";
import {
	type GoldenTaskTotal,
	getActiveRules,
	goldenTaskTotals,
	openDb,
	type RuleRow,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

const DEFAULT_STALE_AFTER_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export interface StaleRule {
	id: number;
	body: string;
	ageDays: number;
	decidedAt: string;
}

/** Active, non-protected rules not re-decided within `staleAfterDays`. */
export function staleRules(
	rules: RuleRow[],
	nowMs: number,
	staleAfterDays: number,
): StaleRule[] {
	const stale: StaleRule[] = [];
	for (const rule of rules) {
		if (rule.protected) continue; // never re-audited by design
		const stamp = rule.decided_at ?? rule.created_at;
		const t = Date.parse(stamp);
		if (Number.isNaN(t)) continue;
		const ageDays = (nowMs - t) / MS_PER_DAY;
		if (ageDays >= staleAfterDays) {
			stale.push({ id: rule.id, body: rule.body, ageDays, decidedAt: stamp });
		}
	}
	return stale.sort((a, b) => b.ageDays - a.ageDays);
}

export function renderHealth(
	agent: string,
	stale: StaleRule[],
	staleAfterDays: number,
): string {
	if (stale.length === 0) {
		return `${agent}: all active rules re-audited within ${staleAfterDays} days.`;
	}
	const lines = stale.map(
		(s) =>
			`  rule ${s.id}: last decided ${Math.floor(s.ageDays)} days ago — "${s.body}"`,
	);
	return [
		`${agent}: ${stale.length} rule(s) not re-audited in ${staleAfterDays}+ days (re-audit recommended — not auto-evicted):`,
		...lines,
		"  → run /warden-select to re-measure them.",
	].join("\n");
}

/** Most recent active-set runs per task considered for the variance ranking:
 * enough for a stable estimate, recent enough to reflect today's suite. */
const VARIANCE_WINDOW = 10;
/** Below this many runs a task's variance estimate is meaningless. */
const MIN_VARIANCE_RUNS = 3;

export interface TaskVariance {
	taskId: string;
	/** Runs the estimate is based on (most recent, capped at the window). */
	n: number;
	mean: number;
	/** Coefficient of variation: stddev/mean over those runs. */
	cv: number;
}

/** Rank golden tasks by run-to-run noise, noisiest first. Input rows must be
 * newest-first within each task (goldenTaskTotals' order). */
export function rankTaskVariance(
	rows: GoldenTaskTotal[],
	minRuns = MIN_VARIANCE_RUNS,
	window = VARIANCE_WINDOW,
): TaskVariance[] {
	const byTask = new Map<string, number[]>();
	for (const row of rows) {
		const bucket = byTask.get(row.taskHash) ?? [];
		if (bucket.length < window) bucket.push(row.total);
		byTask.set(row.taskHash, bucket);
	}
	const ranked: TaskVariance[] = [];
	for (const [taskId, totals] of byTask) {
		if (totals.length < minRuns) continue;
		const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
		if (mean <= 0) continue;
		const variance =
			totals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (totals.length - 1);
		ranked.push({
			taskId,
			n: totals.length,
			mean: Math.round(mean),
			cv: Math.sqrt(variance) / mean,
		});
	}
	return ranked.sort((a, b) => b.cv - a.cv);
}

export function renderVariance(agent: string, ranked: TaskVariance[]): string {
	const noisy = ranked.filter((t) => t.cv > VARIANCE_WARN_RATIO);
	if (noisy.length === 0) {
		const suffix =
			ranked.length === 0 ? " (no measurable active-set history yet)" : "";
		return `${agent}: no golden task exceeds the ${Math.round(VARIANCE_WARN_RATIO * 100)}% run-to-run variance warning level${suffix}.`;
	}
	const lines = noisy.map(
		(t) =>
			`  ${t.taskId}: ±${Math.round(t.cv * 100)}% over ${t.n} run(s), mean ${t.mean.toLocaleString("en-US")} tok`,
	);
	return [
		`${agent}: ${noisy.length} noisy golden task(s) — variance this size buries modest savings; split them by ADDING quieter task files (frozen tasks are never edited):`,
		...lines,
	].join("\n");
}

interface HealthArgs {
	agent: string | null;
	staleAfterDays: number;
	gate: boolean;
	json: boolean;
}

export function parseHealthArgs(argv: string[]): HealthArgs {
	const args: HealthArgs = {
		agent: null,
		staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
		gate: false,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") args.agent = argv[++i] ?? null;
		else if (flag === "--stale-after") {
			const n = Number(argv[++i]);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error("--stale-after must be a positive number of days");
			}
			args.staleAfterDays = n;
		} else if (flag === "--gate") args.gate = true;
		else if (flag === "--json") args.json = true;
		else throw new Error(`unknown flag: ${flag}`);
	}
	if (
		args.agent &&
		!(DOMAIN_AGENTS as readonly string[]).includes(args.agent)
	) {
		throw new Error(`--agent must be one of: ${DOMAIN_AGENTS.join(", ")}`);
	}
	return args;
}

export function main(argv: string[], nowMs = Date.now()): number {
	const args = parseHealthArgs(argv);
	const agents = args.agent ? [args.agent] : [...DOMAIN_AGENTS];
	const db = openDb();
	try {
		let anyStale = false;
		const results = agents.map((agent) => {
			const stale = staleRules(
				getActiveRules(db, agent),
				nowMs,
				args.staleAfterDays,
			);
			if (stale.length > 0) anyStale = true;
			// Informational suite-noise ranking; never a gate input.
			const variance = rankTaskVariance(goldenTaskTotals(db, agent));
			return { agent, stale, variance };
		});
		console.log(
			args.json
				? JSON.stringify(results, null, 2)
				: results
						.map(
							(r) =>
								`${renderHealth(r.agent, r.stale, args.staleAfterDays)}\n${renderVariance(r.agent, r.variance)}`,
						)
						.join("\n\n"),
		);
		return args.gate && anyStale ? 1 : 0;
	} finally {
		db.close();
	}
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
