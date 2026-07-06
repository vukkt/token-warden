/**
 * Zero-token power planner: is a verification burn adequately powered
 * BEFORE it starts?
 *
 * CLI: npx tsx src/power.ts [--agent <name>] [--target-saving N] [--rent N]
 *      [--runs N] [--json]
 *
 * The selector promotes a candidate iff delta_hat >= bar AND the estimate is
 * not uncertain, where bar = 2 x effectiveRent(rent) and "uncertain" means
 * |delta_hat - bar| < z x SE (z = confidenceZ(), default 2). Effectively:
 * keep iff delta_hat >= bar + z x SE. Modelling delta_hat ~ Normal(d, SE^2):
 *
 *   power(d, n)  = Phi((d - bar)/SE(n) - z)
 *   MDS at power 1-beta:  d_min(n) = bar + (z + z_beta) x SE(n)
 *                         z_beta = 0.8416 (80%), 1.2816 (90%)
 *   SE(n) for a K-task suite with per-task run variances s_i^2, n runs per
 *   side, uniform allocation:  SE(n) = sqrt((1/K^2) x Sum_i (2 x s_i^2 / n))
 *
 * The SE formula is deliberately conservative: it assumes uniform run
 * allocation, and the real selector's Neyman variance-proportional top-up
 * can only tighten it. The per-task variances come from the agent's OWN
 * recorded golden replicates (identical task + ruleset version + model), so
 * the plan is grounded in measured run-to-run noise, not a guess.
 */
import { pathToFileURL } from "node:url";
import {
	type GoldenReplicateRun,
	getActiveRules,
	goldenReplicateRuns,
	openDb,
	type WardenDb,
} from "./db.js";
import { confidenceZ, effectiveRent, sampleVariance } from "./select.js";
import { DOMAIN_AGENTS } from "./types.js";

/** One-sided normal quantiles for the planner's two power targets. */
export const Z_POWER_80 = 0.8416;
export const Z_POWER_90 = 1.2816;

/** Run counts the report tabulates — the realistic budget range. */
const PLAN_RUNS = [2, 3, 5, 8, 12] as const;

/** Search ceiling for requiredRunsPerSide; past this the burn is absurd. */
const MAX_RUNS = 500;

/** Rent fallback when an agent has no active rules to take a median over. */
const FALLBACK_RENT = 25;

/**
 * Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation
 * (|error| < 1.5e-7 on erf, so < 7.5e-8 on Phi). Rational polynomial in
 * t = 1/(1 + p|x|) with the odd symmetry erf(-x) = -erf(x) applied exactly,
 * so normalCdf(-x) = 1 - normalCdf(x) holds to floating-point precision.
 */
export function normalCdf(x: number): number {
	const z = x / Math.SQRT2;
	const t = 1 / (1 + 0.3275911 * Math.abs(z));
	const poly =
		t *
		(0.254829592 +
			t *
				(-0.284496736 +
					t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
	const erfAbs = 1 - poly * Math.exp(-z * z);
	return 0.5 * (1 + (z >= 0 ? erfAbs : -erfAbs));
}

export interface TaskNoise {
	taskId: string;
	/** Replicates in the group the variance was estimated from. */
	n: number;
	/** Unbiased run-to-run variance of total tokens on this task. */
	variance: number;
}

/**
 * Per-task run-to-run variance from recorded golden replicates. Rows are
 * grouped by (taskHash, rulesetVersion, model) — only runs of the identical
 * configuration are repeated draws from one distribution. Per task the
 * largest such group wins (the best-estimated noise for that task); groups
 * with fewer than 2 runs carry no variance information and are dropped.
 */
export function taskNoiseFromReplicates(
	rows: GoldenReplicateRun[],
): TaskNoise[] {
	const groups = new Map<string, { taskId: string; totals: number[] }>();
	for (const row of rows) {
		const key = `${row.taskHash}|${row.rulesetVersion}|${row.model}`;
		let group = groups.get(key);
		if (group === undefined) {
			group = { taskId: row.taskHash, totals: [] };
			groups.set(key, group);
		}
		group.totals.push(row.total);
	}
	const bestPerTask = new Map<string, TaskNoise>();
	for (const { taskId, totals } of groups.values()) {
		if (totals.length < 2) continue;
		const variance = sampleVariance(totals);
		if (variance === null) continue;
		const prev = bestPerTask.get(taskId);
		if (prev === undefined || totals.length > prev.n) {
			bestPerTask.set(taskId, { taskId, n: totals.length, variance });
		}
	}
	return [...bestPerTask.values()].sort((a, b) =>
		a.taskId.localeCompare(b.taskId),
	);
}

/**
 * Standard error of the mean-over-tasks A/B delta at `runsPerSide` runs per
 * side under uniform allocation: SE = sqrt((1/K^2) x Sum_i (2 x s_i^2 / n)).
 * The factor 2 is the two independent sides (with/without) of each task.
 */
export function seAt(runsPerSide: number, noises: TaskNoise[]): number {
	if (noises.length < 1) {
		throw new Error("seAt: need at least one task variance");
	}
	if (runsPerSide < 1) {
		throw new Error("seAt: runsPerSide must be >= 1");
	}
	const k = noises.length;
	const sum = noises.reduce(
		(acc, t) => acc + (2 * t.variance) / runsPerSide,
		0,
	);
	return Math.sqrt(sum / (k * k));
}

/**
 * Smallest true saving the gate detects at power 1-beta with `runsPerSide`
 * runs per side: d_min = bar + (z + zPower) x SE(n).
 */
export function minDetectableSaving(
	runsPerSide: number,
	noises: TaskNoise[],
	rent: number,
	zPower: number,
): number {
	const bar = 2 * effectiveRent(rent);
	return bar + (confidenceZ() + zPower) * seAt(runsPerSide, noises);
}

/**
 * Smallest n in [2, MAX_RUNS] whose MDS at power 1-beta is <= targetSaving.
 * Null when the target does not even clear the bar (no run count can ever
 * detect it — the gate itself rejects it) or when it needs > MAX_RUNS.
 */
export function requiredRunsPerSide(
	targetSaving: number,
	noises: TaskNoise[],
	rent: number,
	zPower: number,
): number | null {
	const bar = 2 * effectiveRent(rent);
	if (targetSaving <= bar + 1e-9) return null;
	const spread = confidenceZ() + zPower;
	for (let n = 2; n <= MAX_RUNS; n++) {
		if (targetSaving >= bar + spread * seAt(n, noises)) return n;
	}
	return null;
}

/** Probability the gate promotes a rule whose true saving is `trueSaving`
 * when measured with `runsPerSide` runs per side. */
export function powerAt(
	runsPerSide: number,
	trueSaving: number,
	noises: TaskNoise[],
	rent: number,
): number {
	const bar = 2 * effectiveRent(rent);
	const se = seAt(runsPerSide, noises);
	return normalCdf((trueSaving - bar) / se - confidenceZ());
}

/**
 * Representative rent for the planner. Rent varies per rule, but a plan
 * needs one figure: the median context_cost of the agent's ACTIVE rules is
 * what deployment actually looks like, which beats any constant. Falls back
 * to FALLBACK_RENT when nothing is deployed yet.
 */
export function defaultRent(db: WardenDb, agent: string): number {
	const costs = getActiveRules(db, agent)
		.map((r) => r.context_cost)
		.sort((a, b) => a - b);
	if (costs.length === 0) return FALLBACK_RENT;
	const mid = Math.floor(costs.length / 2);
	const hi = costs[mid] ?? FALLBACK_RENT;
	if (costs.length % 2 === 1) return hi;
	const lo = costs[mid - 1] ?? hi;
	return (lo + hi) / 2;
}

export interface PowerArgs {
	agent: string | null;
	targetSaving: number | null;
	rent: number | null;
	runs: number | null;
	json: boolean;
}

export function parsePowerArgs(argv: string[]): PowerArgs {
	const args: PowerArgs = {
		agent: null,
		targetSaving: null,
		rent: null,
		runs: null,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") {
			const agent = argv[++i] ?? "";
			if (!(DOMAIN_AGENTS as readonly string[]).includes(agent)) {
				throw new Error(
					`--agent must be one of: ${DOMAIN_AGENTS.join(", ")} (got "${agent}")`,
				);
			}
			args.agent = agent;
		} else if (flag === "--target-saving") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n <= 0) {
				throw new Error("--target-saving must be a positive integer");
			}
			args.targetSaving = n;
		} else if (flag === "--rent") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n <= 0) {
				throw new Error("--rent must be a positive integer");
			}
			args.rent = n;
		} else if (flag === "--runs") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n < 2) {
				throw new Error("--runs must be an integer >= 2");
			}
			args.runs = n;
		} else if (flag === "--json") args.json = true;
		else throw new Error(`unknown flag: ${flag}`);
	}
	return args;
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

export interface RenderOpts {
	targetSaving: number | null;
	runs: number | null;
}

export function renderPower(
	agent: string,
	noises: TaskNoise[],
	rent: number,
	opts: RenderOpts,
): string {
	if (noises.length < 2) {
		return `insufficient replicate history for ${agent} (need >= 2 tasks with >= 2 completed active-set runs at one ruleset version) — run /warden-bench --agent ${agent} first`;
	}
	const bar = 2 * effectiveRent(rent);
	const z = confidenceZ();
	const totalRuns = noises.reduce((acc, t) => acc + t.n, 0);
	const lines = [`power plan — ${agent}`];
	lines.push(
		`  tasks: ${noises.length} (replicate runs: ${totalRuns})   rent: ${fmt(rent)} tok/session   bar (2x effective rent): ${fmt(bar)} tok/run   z: ${z}`,
	);
	lines.push(
		`  ${"runs/side".padEnd(10)}${"SE".padStart(10)}${"MDS@80%".padStart(12)}${"MDS@90%".padStart(12)}`,
	);
	for (const n of PLAN_RUNS) {
		lines.push(
			`  ${String(n).padEnd(10)}${fmt(seAt(n, noises)).padStart(10)}${fmt(
				minDetectableSaving(n, noises, rent, Z_POWER_80),
			).padStart(12)}${fmt(
				minDetectableSaving(n, noises, rent, Z_POWER_90),
			).padStart(12)}`,
		);
	}
	if (opts.targetSaving !== null) {
		const need80 = requiredRunsPerSide(
			opts.targetSaving,
			noises,
			rent,
			Z_POWER_80,
		);
		const need90 = requiredRunsPerSide(
			opts.targetSaving,
			noises,
			rent,
			Z_POWER_90,
		);
		if (need80 === null && need90 === null && opts.targetSaving <= bar) {
			lines.push(
				`  target ${fmt(opts.targetSaving)} tok/run: target does not clear the 2x-rent bar — no run count can detect it`,
			);
		} else {
			const at = (n: number | null): string =>
				n === null ? `> ${MAX_RUNS} runs/side` : `${n} runs/side`;
			lines.push(
				`  target ${fmt(opts.targetSaving)} tok/run: needs ${at(need80)} at 80% power, ${at(need90)} at 90%`,
			);
		}
	}
	if (opts.runs !== null) {
		lines.push(
			`  at n=${opts.runs} runs/side: MDS@80% = ${fmt(
				minDetectableSaving(opts.runs, noises, rent, Z_POWER_80),
			)}, MDS@90% = ${fmt(minDetectableSaving(opts.runs, noises, rent, Z_POWER_90))}`,
		);
		if (opts.targetSaving !== null) {
			const p = powerAt(opts.runs, opts.targetSaving, noises, rent);
			lines.push(
				`  achieved power at target ${fmt(opts.targetSaving)}: ${(100 * p).toFixed(1)}%`,
			);
		}
	}
	lines.push(
		"  Conservative: assumes uniform run allocation; the selector's Neyman top-up only tightens the SE.",
	);
	return lines.join("\n");
}

interface PowerJson {
	agent: string;
	tasks: number;
	rent: number;
	bar: number;
	rows: Array<{ runs: number; se: number; mds80: number; mds90: number }>;
	target?: number;
	requiredRuns80?: number | null;
	requiredRuns90?: number | null;
	powerAtRuns?: number;
}

export function main(argv: string[]): number {
	const args = parsePowerArgs(argv);
	const agents = args.agent ? [args.agent] : [...DOMAIN_AGENTS];
	const db = openDb();
	try {
		const reports: string[] = [];
		const json: PowerJson[] = [];
		for (const agent of agents) {
			const noises = taskNoiseFromReplicates(goldenReplicateRuns(db, agent));
			const rent = args.rent ?? defaultRent(db, agent);
			if (args.json) {
				const entry: PowerJson = {
					agent,
					tasks: noises.length,
					rent,
					bar: 2 * effectiveRent(rent),
					// Insufficient history renders as an empty table rather than an
					// error: --json is for tooling, and "no rows" is the honest answer.
					rows:
						noises.length < 2
							? []
							: PLAN_RUNS.map((n) => ({
									runs: n,
									se: seAt(n, noises),
									mds80: minDetectableSaving(n, noises, rent, Z_POWER_80),
									mds90: minDetectableSaving(n, noises, rent, Z_POWER_90),
								})),
				};
				if (args.targetSaving !== null && noises.length >= 2) {
					entry.target = args.targetSaving;
					entry.requiredRuns80 = requiredRunsPerSide(
						args.targetSaving,
						noises,
						rent,
						Z_POWER_80,
					);
					entry.requiredRuns90 = requiredRunsPerSide(
						args.targetSaving,
						noises,
						rent,
						Z_POWER_90,
					);
					if (args.runs !== null) {
						entry.powerAtRuns = powerAt(
							args.runs,
							args.targetSaving,
							noises,
							rent,
						);
					}
				}
				json.push(entry);
			} else {
				reports.push(
					renderPower(agent, noises, rent, {
						targetSaving: args.targetSaving,
						runs: args.runs,
					}),
				);
			}
		}
		if (args.json) console.log(JSON.stringify(json, null, 2));
		else console.log(reports.join("\n\n"));
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
