/**
 * Rule health — a declarative governance flag for stale rules.
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
 */
import { pathToFileURL } from "node:url";
import { getActiveRules, openDb, type RuleRow } from "./db.js";
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
			`  ⚠ rule ${s.id}: last decided ${Math.floor(s.ageDays)} days ago — "${s.body}"`,
	);
	return [
		`${agent}: ${stale.length} rule(s) not re-audited in ${staleAfterDays}+ days (re-audit recommended — not auto-evicted):`,
		...lines,
		"  → run /warden-select to re-measure them.",
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
			return { agent, stale };
		});
		console.log(
			args.json
				? JSON.stringify(results, null, 2)
				: results
						.map((r) => renderHealth(r.agent, r.stale, args.staleAfterDays))
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
