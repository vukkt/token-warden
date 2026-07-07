/**
 * Production-cohort validation: did rules make REAL work cheaper?
 *
 * CLI: npx tsx src/cohort.ts [--agent <name>] [--project <p>] [--min-n N] [--json]
 *
 * The frozen-fixture benchmark proves a rule saves tokens on a fixed, repeatable
 * workload. This is the complementary, out-of-fixture signal: compare the agent's
 * own completed real-work sessions BEFORE rules (the earliest ruleset version)
 * against AFTER (the latest), using the per-session token totals so we can put a
 * standard error on the difference — not just eyeball two means.
 *
 * It is deliberately OBSERVATIONAL. Real sessions are not task-controlled the way
 * golden tasks are, so the comparison assumes a roughly stable task mix across
 * cohorts; `--project` narrows the scope to reduce that confound. The verdict is
 * a production *signal* meant to feed rule governance (e.g. re-audit/eviction),
 * not a replacement for the controlled benchmark.
 */
import { pathToFileURL } from "node:url";
import {
	openDb,
	realWorkTotalsByVersion,
	type VersionedTotal,
	type WardenDb,
} from "./db.js";
import { knownAgents } from "./registry.js";

/** Minimum completed sessions per cohort before a verdict is trustworthy. */
const DEFAULT_MIN_N = 5;
/** Confidence multiple on the pooled standard error (~95%). */
const CONFIDENCE_Z = 2;

export interface CohortStat {
	rulesetVersion: number;
	n: number;
	mean: number;
	/** Sample standard deviation; 0 when n < 2. */
	stdDev: number;
	/** Standard error of the mean; null when n < 2 (undefined for one sample). */
	stdErr: number | null;
}

export type CohortVerdict =
	| "improved"
	| "regressed"
	| "no-change"
	| "insufficient-data";

export interface CohortAssessment {
	baseline: CohortStat | null;
	latest: CohortStat | null;
	/** baseline.mean - latest.mean: positive means real work got cheaper. */
	delta: number | null;
	pctDelta: number | null;
	pooledStdErr: number | null;
	confident: boolean;
	verdict: CohortVerdict;
	reason: string;
}

/** Group raw per-session totals by ruleset version and compute n/mean/sd/se. */
export function cohortStats(totals: VersionedTotal[]): CohortStat[] {
	const byVersion = new Map<number, number[]>();
	for (const { rulesetVersion, total } of totals) {
		const bucket = byVersion.get(rulesetVersion);
		if (bucket) bucket.push(total);
		else byVersion.set(rulesetVersion, [total]);
	}
	return [...byVersion.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([rulesetVersion, values]) => {
			const n = values.length;
			const mean = values.reduce((a, b) => a + b, 0) / n;
			let stdDev = 0;
			let stdErr: number | null = null;
			if (n >= 2) {
				const variance =
					values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
				stdDev = Math.sqrt(variance);
				stdErr = stdDev / Math.sqrt(n);
			}
			return { rulesetVersion, n, mean, stdDev, stdErr };
		});
}

/**
 * Compare the earliest cohort (pre-rules baseline) against the latest cohort.
 * A confident drop is "improved"; a confident rise is "regressed"; otherwise
 * "no-change". Too few sessions on either side is "insufficient-data".
 */
export function assessCohorts(
	stats: CohortStat[],
	minN: number = DEFAULT_MIN_N,
): CohortAssessment {
	if (stats.length < 2) {
		return {
			baseline: stats[0] ?? null,
			latest: stats[0] ?? null,
			delta: null,
			pctDelta: null,
			pooledStdErr: null,
			confident: false,
			verdict: "insufficient-data",
			reason:
				stats.length === 0
					? "no completed real-work sessions for this agent"
					: "only one ruleset version seen — no before/after to compare",
		};
	}
	const baseline = stats[0] as CohortStat;
	const latest = stats[stats.length - 1] as CohortStat;
	if (baseline.n < minN || latest.n < minN) {
		return {
			baseline,
			latest,
			delta: null,
			pctDelta: null,
			pooledStdErr: null,
			confident: false,
			verdict: "insufficient-data",
			reason: `need >= ${minN} sessions per cohort (have v${baseline.rulesetVersion}=${baseline.n}, v${latest.rulesetVersion}=${latest.n})`,
		};
	}
	const delta = baseline.mean - latest.mean;
	const pctDelta = baseline.mean > 0 ? (delta / baseline.mean) * 100 : 0;
	const pooledStdErr =
		baseline.stdErr !== null && latest.stdErr !== null
			? Math.sqrt(baseline.stdErr ** 2 + latest.stdErr ** 2)
			: null;
	const confident =
		pooledStdErr !== null && Math.abs(delta) > CONFIDENCE_Z * pooledStdErr;
	let verdict: CohortVerdict;
	if (confident && delta > 0) verdict = "improved";
	else if (confident && delta < 0) verdict = "regressed";
	else verdict = "no-change";
	const reason = confident
		? `|${Math.round(delta)}| > ${CONFIDENCE_Z}x pooled stderr ${Math.round(pooledStdErr ?? 0)}`
		: `within noise (pooled stderr ${pooledStdErr === null ? "n/a" : Math.round(pooledStdErr)})`;
	return {
		baseline,
		latest,
		delta,
		pctDelta,
		pooledStdErr,
		confident,
		verdict,
		reason,
	};
}

export type GovernanceAction =
	| "re-audit"
	| "corroborated"
	| "no-signal"
	| "insufficient-data";

export interface Governance {
	action: GovernanceAction;
	reason: string;
}

/**
 * Map a cohort verdict to a governance action. The cohort signal is
 * observational (confounded by task mix), so a regression FLAGS the agent for
 * a controlled fixture re-audit (`/warden-select`) — it never auto-evicts a
 * rule. The fixture benchmark stays the only authority that removes a rule.
 */
export function cohortGovernance(a: CohortAssessment): Governance {
	switch (a.verdict) {
		case "regressed":
			return {
				action: "re-audit",
				reason:
					"real-work cost rose after rules — re-audit this agent's rules on the fixture (/warden-select). Observational signal: it flags, it does not auto-evict.",
			};
		case "improved":
			return {
				action: "corroborated",
				reason:
					"real-work cost dropped after rules — the fixture verdict is corroborated in production.",
			};
		case "no-change":
			return {
				action: "no-signal",
				reason: "no confident production change — keep collecting sessions.",
			};
		default:
			return { action: "insufficient-data", reason: a.reason };
	}
}

/** Full assessment for one agent, reading its real-work sessions from the db. */
export function assessAgentCohorts(
	db: WardenDb,
	agent: string,
	minN: number = DEFAULT_MIN_N,
	project?: string,
): { agent: string; project: string | null; assessment: CohortAssessment } {
	const stats = cohortStats(realWorkTotalsByVersion(db, agent, project));
	return {
		agent,
		project: project ?? null,
		assessment: assessCohorts(stats, minN),
	};
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

export function renderCohort(
	agent: string,
	project: string | null,
	a: CohortAssessment,
): string {
	const scope = project ? ` (project: ${project})` : "";
	const lines = [`cohort validation — ${agent}${scope}`];
	const stats = [a.baseline, a.latest].filter(
		(s): s is CohortStat => s !== null,
	);
	const seen = new Set<number>();
	for (const s of stats) {
		if (seen.has(s.rulesetVersion)) continue;
		seen.add(s.rulesetVersion);
		const se = s.stdErr === null ? "" : ` ±${fmt(s.stdErr)}`;
		lines.push(`  v${s.rulesetVersion}: n=${s.n}  mean=${fmt(s.mean)}${se}`);
	}
	if (a.delta !== null && a.baseline && a.latest) {
		lines.push(
			`  v${a.baseline.rulesetVersion} -> v${a.latest.rulesetVersion}: ${a.delta >= 0 ? "+" : ""}${fmt(a.delta)} tok/session (${a.pctDelta === null ? "n/a" : `${a.pctDelta >= 0 ? "-" : "+"}${Math.abs(a.pctDelta).toFixed(1)}%`})`,
		);
	}
	lines.push(`  verdict: ${a.verdict.toUpperCase()} — ${a.reason}`);
	const gov = cohortGovernance(a);
	lines.push(`  governance: ${gov.action.toUpperCase()} — ${gov.reason}`);
	lines.push(
		"  NOTE: observational — real sessions are not task-controlled; assumes a stable task mix.",
	);
	return lines.join("\n");
}

interface CohortArgs {
	agent: string | null;
	project: string | null;
	minN: number;
	json: boolean;
	gate: boolean;
}

export function parseCohortArgs(argv: string[]): CohortArgs {
	const args: CohortArgs = {
		agent: null,
		project: null,
		minN: DEFAULT_MIN_N,
		json: false,
		gate: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") args.agent = argv[++i] ?? null;
		else if (flag === "--project") args.project = argv[++i] ?? null;
		else if (flag === "--min-n") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n < 2) {
				throw new Error("--min-n must be an integer >= 2");
			}
			args.minN = n;
		} else if (flag === "--json") args.json = true;
		else if (flag === "--gate") args.gate = true;
		else throw new Error(`unknown flag: ${flag}`);
	}
	return args;
}

export function main(argv: string[]): number {
	const args = parseCohortArgs(argv);
	const agents = args.agent ? [args.agent] : knownAgents();
	const db = openDb();
	try {
		const results = agents.map((agent) =>
			assessAgentCohorts(db, agent, args.minN, args.project ?? undefined),
		);
		if (args.json) {
			console.log(JSON.stringify(results, null, 2));
		} else {
			console.log(
				results
					.map((r) => renderCohort(r.agent, r.project, r.assessment))
					.join("\n\n"),
			);
		}
		// --gate: non-zero exit if any agent regressed in production, so CI can
		// fail and prompt a fixture re-audit. Other verdicts never gate.
		if (
			args.gate &&
			results.some((r) => cohortGovernance(r.assessment).action === "re-audit")
		) {
			return 1;
		}
		return 0;
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
