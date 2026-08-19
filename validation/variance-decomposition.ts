/**
 * VARIANCE DECOMPOSITION — where does the golden suite's noise actually live?
 *
 * FINDINGS.md names golden-suite variance as the binding constraint on every
 * future burn: the rule-body compression A/B is closed as unconfirmable, a
 * genuinely-positive 2% rule is falsely evicted most of the time, and the
 * Neyman retention budget backfired because a 2-run variance estimate is
 * itself mostly noise. Every one of those is downstream of one number, and
 * nothing had ever attributed that number to a cause.
 *
 * This tool attributes it, from the runs already in the ledger. ZERO TOKENS:
 * no model is invoked at any point, and the database is opened READ-ONLY.
 *
 * What it reports, in the order the argument runs:
 *
 * 1. REPLICATE GROUPS. Runs that executed the identical configuration are the
 *    only ones whose spread is measurement noise. `goldenReplicateRuns` (used
 *    by the power planner) keys those groups on (task, ruleset version, model)
 *    and restricts to `config='active'`, which is correct but leaves the
 *    deepest pools in the ledger unusable: an A/B burn records BOTH sides
 *    under `config='candidate'` at the SAME ruleset version, so grouping by
 *    that key alone pools the two arms and reports the treatment effect as
 *    noise. Here a group is additionally a CONTIGUOUS BLOCK of runs of one
 *    task — `runSuite` executes a task's runs back to back within a pass, so a
 *    task reappearing after other tasks is a new pass, i.e. a new
 *    configuration. That recovers the 7-task x 8-runs-per-side compression
 *    burn as 14 clean single-configuration groups.
 *
 * 2. PER-TASK NOISE, on three metrics. `total` is what the gate consumes
 *    (input + output + cache-creation + cache-read). `processing` is what
 *    `compare.ts` already scores (total minus cache-read). `costEquivalent`
 *    prices each class through `priceFor` and expresses the run in
 *    input-token equivalents — the honest economic unit. The three disagree by
 *    an order of magnitude, and which one the gate reads turns out to matter
 *    more than any property of any task.
 *
 * 3. SHARE OF THE SUITE STANDARD ERROR. The gate consumes
 *    SE = sqrt((1/K^2) x Sum_i 2 s_i^2 / n), so task i's contribution to the
 *    VARIANCE is proportional to s_i^2. Percentile bootstrap CIs on those
 *    shares, because a share estimated from 16 runs is itself an estimate and
 *    this project has been fooled by an unreplicated reading before.
 *
 * 4. THE MECHANISM. Within-task-centred regression of cost on `tool_calls`,
 *    plus the turn count's own per-task CV. If one number explains the spread,
 *    and its CV is flat across tasks of very different sizes, then the spread
 *    is a property of the AGENT and no task redesign can move it.
 *
 * 5. THE PRIZE. Minimum detectable saving and required runs per side, through
 *    the REAL planner (`minDetectableSaving`, `requiredRunsPerSide` from
 *    src/power.ts), for each metric — priced in tokens against the quota
 *    windows this environment actually delivers. Then the same question for
 *    task SUBSETS at a fixed token budget, which is the only honest way to ask
 *    whether removing the noisiest tasks would help.
 *
 * 6. THE RECORDED ARMS, DIFFERENCED on each metric. A quieter metric is only
 *    worth switching to if the SIGNAL survives it; this is the check that
 *    stops a smaller error bar being mistaken for better detectability.
 *
 *   npx tsx validation/variance-decomposition.ts [--agent <name>] [--db <path>]
 *     [--config <name>] [--ruleset N] [--rent N] [--effect FRACTION]
 *     [--runs N] [--budget N] [--trials N] [--seed N]
 */
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { ENV_FAILURE_TOKEN_FLOOR } from "../src/bench.js";
import { defaultDbPath } from "../src/db.js";
import {
	minDetectableSaving,
	requiredRunsPerSide,
	seAt,
	type TaskNoise,
	Z_POWER_80,
	Z_POWER_90,
} from "../src/power.js";
import { priceFor } from "../src/pricing.js";
import { assertKnownAgent } from "../src/registry.js";
import { confidenceZ, keepBar, mean } from "../src/stats.js";
import { mulberry32 } from "./rng.js";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface AnalysisRun {
	id: number;
	taskId: string;
	config: string;
	rulesetVersion: number;
	model: string;
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
	toolCalls: number;
	completed: boolean;
}

export type MetricName =
	| "total"
	| "processing"
	| "costEquivalent"
	| "toolCalls";

/**
 * The three COST metrics, in tokens — the ones a burn budget and an MDS are
 * meaningful for. `toolCalls` is deliberately not among them: it is measured
 * the same way, but a "minimum detectable saving" denominated in tool calls
 * would be reported against a token-denominated rent bar.
 */
export const METRIC_NAMES: readonly MetricName[] = [
	"total",
	"processing",
	"costEquivalent",
];

/**
 * The ways to price a run.
 *
 * `costEquivalent` divides through by the input rate so the result is
 * "input-equivalent tokens" — comparable in magnitude to the other two rather
 * than a dollar figure four decimal places wide. `priceFor` is the shipped
 * price path, so TOKEN_WARDEN_PRICE_* overrides apply here too.
 *
 * `toolCalls` is the run's agentic turn count. It is here so the same pooled
 * variance estimator can be pointed at it: if the suite's token noise is
 * really turn-count noise, then the turn count's OWN coefficient of variation
 * is the number that has to move, and it is a property of the agent rather
 * than of any task.
 */
export function metricValue(run: AnalysisRun, metric: MetricName): number {
	if (metric === "total") {
		return run.input + run.output + run.cacheCreation + run.cacheRead;
	}
	if (metric === "processing") {
		return run.input + run.output + run.cacheCreation;
	}
	if (metric === "toolCalls") return run.toolCalls;
	const p = priceFor(run.model === "" ? null : run.model);
	return (
		(run.input * p.input +
			run.output * p.output +
			run.cacheCreation * p.cacheWrite +
			run.cacheRead * p.cacheRead) /
		p.input
	);
}

/**
 * One measurement pass of one configuration on one task — the only set of
 * runs whose spread is measurement noise rather than a mixture of noise and
 * treatment effect. See the header: the CONTIGUOUS-BLOCK rule is what
 * separates the two arms of an A/B burn, which share a ruleset version.
 */
export interface PassGroup {
	taskId: string;
	config: string;
	rulesetVersion: number;
	model: string;
	/** 1-based index of this contiguous block among that key's blocks. */
	pass: number;
	runs: AnalysisRun[];
}

export function groupIntoPasses(runs: readonly AnalysisRun[]): PassGroup[] {
	const groups: PassGroup[] = [];
	const blockCount = new Map<string, number>();
	const byBlock = new Map<string, PassGroup>();
	let openKey: string | null = null;
	for (const run of runs) {
		const key = `${run.taskId}\u0000${run.config}\u0000${run.rulesetVersion}\u0000${run.model}`;
		if (key !== openKey) {
			blockCount.set(key, (blockCount.get(key) ?? 0) + 1);
			openKey = key;
		}
		const pass = blockCount.get(key) as number;
		const blockKey = `${key}\u0000${pass}`;
		let group = byBlock.get(blockKey);
		if (group === undefined) {
			group = {
				taskId: run.taskId,
				config: run.config,
				rulesetVersion: run.rulesetVersion,
				model: run.model,
				pass,
				runs: [],
			};
			byBlock.set(blockKey, group);
			groups.push(group);
		}
		group.runs.push(run);
	}
	return groups;
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

export interface TaskNoiseDetail extends TaskNoise {
	/** Mean of the metric over every run pooled into the estimate. */
	metricMean: number;
	/** sqrt(variance) / metricMean. */
	cv: number;
	/** Passes the variance was pooled over. */
	passes: number;
}

/**
 * Per-task run-to-run variance, pooled across passes by degrees of freedom.
 *
 * Pooling across passes rather than picking the largest one (the power
 * planner's rule) is right here because every pass of a task is a draw from
 * the same run-to-run noise process even when the configurations differ: the
 * treatment shifts the MEAN, and a within-pass deviation is measured from that
 * pass's own mean. It also spends every recorded run instead of discarding the
 * smaller groups, which is what makes a CI on the result worth printing.
 */
export function taskNoise(groups: readonly PassGroup[], metric: MetricName) {
	const byTask = new Map<
		string,
		{ ss: number; dof: number; values: number[]; passes: number }
	>();
	for (const group of groups) {
		const values = group.runs.map((r) => metricValue(r, metric));
		if (values.length < 2) continue;
		const m = mean(values);
		let acc = byTask.get(group.taskId);
		if (acc === undefined) {
			acc = { ss: 0, dof: 0, values: [], passes: 0 };
			byTask.set(group.taskId, acc);
		}
		acc.ss += values.reduce((a, x) => a + (x - m) ** 2, 0);
		acc.dof += values.length - 1;
		acc.values.push(...values);
		acc.passes += 1;
	}
	const out: TaskNoiseDetail[] = [];
	for (const [taskId, acc] of byTask) {
		if (acc.dof < 1) continue;
		const variance = acc.ss / acc.dof;
		const metricMean = mean(acc.values);
		out.push({
			taskId,
			n: acc.values.length,
			variance,
			metricMean,
			cv: metricMean === 0 ? 0 : Math.sqrt(variance) / metricMean,
			passes: acc.passes,
		});
	}
	return out.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** Task i's share of Var(delta): the gate's SE is built from Sum_i s_i^2, so
 * the share is s_i^2 / Sum s_i^2. Returns fractions, not percentages. */
export function varianceShares(noises: readonly TaskNoise[]): number[] {
	const total = noises.reduce((a, t) => a + t.variance, 0);
	if (total === 0) return noises.map(() => 0);
	return noises.map((t) => t.variance / total);
}

export interface ShareInterval {
	taskId: string;
	share: number;
	lo: number;
	hi: number;
}

/**
 * Percentile-bootstrap CI on each task's variance share, resampling WITHIN
 * each pass so the resample respects the same configuration boundaries the
 * point estimate does. The interval covers resampling error in the recorded
 * pool only — it says nothing about whether a different week would have drawn
 * a different pool.
 */
export function bootstrapShares(
	groups: readonly PassGroup[],
	metric: MetricName,
	trials: number,
	seed: number,
): ShareInterval[] {
	const point = taskNoise(groups, metric);
	const ids = point.map((t) => t.taskId);
	const rng = mulberry32(seed);
	const samples = new Map<string, number[]>(ids.map((id) => [id, []]));
	const usable = groups.filter((g) => g.runs.length >= 2);
	for (let trial = 0; trial < trials; trial++) {
		// Draw n runs WITH replacement from within the same pass, n unchanged, so
		// the resample respects the configuration boundaries the point estimate
		// does. One rng() call per run, in order — the same consumption the old
		// `runs.map((_, __, all) => ...)` form had, written so it reads as a draw.
		const resampled: PassGroup[] = usable.map((g) => ({
			...g,
			runs: Array.from(
				{ length: g.runs.length },
				() => g.runs[Math.floor(rng() * g.runs.length)] as AnalysisRun,
			),
		}));
		const noises = taskNoise(resampled, metric);
		const shares = varianceShares(noises);
		noises.forEach((t, i) => {
			samples.get(t.taskId)?.push(shares[i] as number);
		});
	}
	const quantile = (xs: number[], p: number): number => {
		if (xs.length === 0) return Number.NaN;
		const sorted = [...xs].sort((a, b) => a - b);
		return sorted[Math.floor(p * (sorted.length - 1))] as number;
	};
	const pointShares = varianceShares(point);
	return point
		.map((t, i) => {
			const drawn = samples.get(t.taskId) ?? [];
			return {
				taskId: t.taskId,
				share: pointShares[i] as number,
				lo: quantile(drawn, 0.025),
				hi: quantile(drawn, 0.975),
			};
		})
		.sort((a, b) => b.share - a.share);
}

export interface TurnCostFit {
	/** Runs entering the fit. */
	n: number;
	/** Extra cost of one more tool call, in the metric's units. */
	slope: number;
	/** Fraction of the within-task spread the tool-call count explains. */
	r2: number;
}

/**
 * Within-task-centred least-squares fit of cost on `tool_calls`.
 *
 * Centring per task removes the between-task level differences, so the fit
 * answers exactly one question: given the task, how much of a run's departure
 * from that task's mean is explained by how many tool calls it took? A high
 * r2 means the suite's noise is the agent's turn-count noise, which is a
 * property of the AGENT and not of any task — and therefore not fixable by
 * rewriting, splitting or adding tasks.
 */
export function turnCostFit(
	groups: readonly PassGroup[],
	metric: MetricName,
): TurnCostFit | null {
	const xs: number[] = [];
	const ys: number[] = [];
	const byTask = new Map<string, AnalysisRun[]>();
	for (const group of groups) {
		const list = byTask.get(group.taskId) ?? [];
		list.push(...group.runs);
		byTask.set(group.taskId, list);
	}
	for (const runs of byTask.values()) {
		if (runs.length < 2) continue;
		const mx = mean(runs.map((r) => r.toolCalls));
		const my = mean(runs.map((r) => metricValue(r, metric)));
		for (const r of runs) {
			xs.push(r.toolCalls - mx);
			ys.push(metricValue(r, metric) - my);
		}
	}
	if (xs.length < 3) return null;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (let i = 0; i < xs.length; i++) {
		sxx += (xs[i] as number) ** 2;
		sxy += (xs[i] as number) * (ys[i] as number);
		syy += (ys[i] as number) ** 2;
	}
	if (sxx === 0 || syy === 0) return null;
	return { n: xs.length, slope: sxy / sxx, r2: sxy ** 2 / (sxx * syy) };
}

export interface BurnPlan {
	metric: MetricName;
	taskCount: number;
	/** Mean per-run TOTAL token cost — what the burn is billed in, whatever
	 * metric the verdict is scored on. */
	tokensPerRun: number;
	/** The saving being planned for, in the metric's units. */
	targetSaving: number;
	seAtDefaultRuns: number;
	mds80: number;
	mds90: number;
	runsPerSide: number | null;
	/** Total tokens the burn would spend: runs x tasks x 2 sides x cost/run. */
	burnTokens: number | null;
}

/**
 * What a burn for `effectFraction` of a run would cost, through the shipped
 * planner. `tokensPerRun` is always the TOTAL-token mean regardless of metric:
 * changing the scoring metric does not make a run cheaper to execute, only
 * cheaper to resolve.
 */
export function burnPlan(
	groups: readonly PassGroup[],
	metric: MetricName,
	rent: number,
	effectFraction: number,
	defaultRuns: number,
): BurnPlan | null {
	const noises = taskNoise(groups, metric);
	if (noises.length === 0) return null;
	const totals = taskNoise(groups, "total");
	const tokensPerRun = mean(totals.map((t) => t.metricMean));
	const targetSaving = effectFraction * mean(noises.map((t) => t.metricMean));
	const runsPerSide = requiredRunsPerSide(
		targetSaving,
		noises,
		rent,
		Z_POWER_80,
	);
	return {
		metric,
		taskCount: noises.length,
		tokensPerRun,
		targetSaving,
		seAtDefaultRuns: seAt(defaultRuns, noises),
		mds80: minDetectableSaving(defaultRuns, noises, rent, Z_POWER_80),
		mds90: minDetectableSaving(defaultRuns, noises, rent, Z_POWER_90),
		runsPerSide,
		burnTokens:
			runsPerSide === null
				? null
				: runsPerSide * noises.length * 2 * tokensPerRun,
	};
}

export interface ArmDelta {
	metric: MetricName;
	/** Mean over tasks of (pass 2 mean - pass 1 mean). */
	delta: number;
	/** Propagated WITHIN-task standard error, the fixed-suite estimand
	 * `assessDelta` uses: sqrt((1/K^2) x Sum_i [s_1i^2/n_1i + s_2i^2/n_2i]). */
	standardError: number;
	perTask: Array<{ taskId: string; delta: number }>;
}

/**
 * The two arms of a recorded A/B, differenced on each metric.
 *
 * Scope the pool to one burn first (`--config candidate --ruleset N`); this
 * then reads pass 1 as one arm and pass 2 as the other, which is the order
 * `runSuite` executed them. Tasks without both passes are skipped, and null
 * comes back if fewer than two tasks survive.
 *
 * Why it belongs in a variance tool: the decomposition says where the NOISE
 * is, and that alone cannot tell you whether a quieter metric would also have
 * a smaller SIGNAL. Differencing the same recorded arms on all three metrics
 * answers that directly, and it is the check that stops "just score the gate
 * on processing tokens" being adopted on the strength of its error bar alone.
 */
export function armDelta(
	groups: readonly PassGroup[],
	metric: MetricName,
): ArmDelta | null {
	const byTask = new Map<string, Map<number, number[]>>();
	for (const group of groups) {
		if (group.runs.length < 2) continue;
		const passes = byTask.get(group.taskId) ?? new Map<number, number[]>();
		passes.set(
			group.pass,
			group.runs.map((r) => metricValue(r, metric)),
		);
		byTask.set(group.taskId, passes);
	}
	const variance = (xs: number[]): number => {
		const m = mean(xs);
		return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
	};
	const perTask: Array<{ taskId: string; delta: number }> = [];
	let varSum = 0;
	// Sorted by taskId so `perTask` renders in a stable order. This used to be
	// `[...byTask].sort()`, which sorts ENTRIES by their default string form —
	// it happened to work only because every entry stringifies to
	// "<taskId>,[object Map]" and so compares on the id.
	const byTaskId = [...byTask.entries()].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	for (const [taskId, passes] of byTaskId) {
		const first = passes.get(1);
		const second = passes.get(2);
		if (first === undefined || second === undefined) continue;
		perTask.push({ taskId, delta: mean(second) - mean(first) });
		varSum += variance(first) / first.length + variance(second) / second.length;
	}
	if (perTask.length < 2) return null;
	const k = perTask.length;
	return {
		metric,
		delta: mean(perTask.map((t) => t.delta)),
		standardError: Math.sqrt(varSum / (k * k)),
		perTask,
	};
}

export interface SubsetOutcome {
	label: string;
	taskIds: string[];
	/** Runs per side the budget buys on this subset. */
	runsPerSide: number;
	/** Mean saving the rule produces on THIS subset, under a proportional
	 * effect: a task that costs half as much saves half as much. */
	targetSaving: number;
	standardError: number;
	/** (targetSaving - bar) / SE. Needs z + z_80 = 2.84 for 80% power. */
	detectionRatio: number;
	powered80: boolean;
}

/**
 * What a FIXED TOKEN BUDGET buys on a given subset of the suite.
 *
 * This is the question "would fixing/removing the worst tasks help?" asked
 * properly. Comparing standard errors alone answers it wrongly: dropping a
 * noisy task always shrinks the SE, which looks like progress. But the gate's
 * statistic is (delta - bar) / SE, and under a PROPORTIONAL effect — a rule
 * that saves a percentage of a run, which is what every rule this project has
 * measured looks like — dropping an expensive task removes signal in the same
 * proportion as it removes noise. The only thing a cheaper subset genuinely
 * buys is more runs for the same tokens, so the budget has to be held fixed
 * for the comparison to mean anything.
 *
 * Returns null when the budget cannot buy the two runs per side that any
 * within-task variance estimate requires.
 */
export function subsetAtBudget(
	groups: readonly PassGroup[],
	metric: MetricName,
	rent: number,
	effectFraction: number,
	budgetTokens: number,
	taskIds: readonly string[],
	label: string,
): SubsetOutcome | null {
	const keep = new Set(taskIds);
	const subset = groups.filter((g) => keep.has(g.taskId));
	const noises = taskNoise(subset, metric);
	if (noises.length === 0) return null;
	const totals = taskNoise(subset, "total");
	const tokensPerRun = mean(totals.map((t) => t.metricMean));
	// One run per side across the subset costs this much; the budget divides.
	const runsPerSide = Math.floor(
		budgetTokens / (noises.length * 2 * tokensPerRun),
	);
	if (runsPerSide < 2) return null;
	const targetSaving = effectFraction * mean(noises.map((t) => t.metricMean));
	const standardError = seAt(runsPerSide, noises);
	const bar = keepBar(rent);
	const detectionRatio = (targetSaving - bar) / standardError;
	return {
		label,
		taskIds: noises.map((t) => t.taskId),
		runsPerSide,
		targetSaving,
		standardError,
		detectionRatio,
		powered80: detectionRatio >= confidenceZ() + Z_POWER_80,
	};
}

/**
 * The subsets worth comparing: the whole suite, then the whole suite minus its
 * 1/2/3 largest variance contributors, then the three quietest tasks alone.
 * Built from the data rather than hard-coded task ids so it works for any
 * agent and survives the suite growing.
 */
export function candidateSubsets(
	groups: readonly PassGroup[],
	metric: MetricName,
): Array<{ label: string; taskIds: string[] }> {
	const noises = taskNoise(groups, metric);
	const byVariance = [...noises].sort((a, b) => b.variance - a.variance);
	const all = noises.map((t) => t.taskId);
	const out = [{ label: "whole suite", taskIds: all }];
	for (const drop of [1, 2, 3]) {
		if (byVariance.length - drop < 2) break;
		const dropped = byVariance.slice(0, drop).map((t) => t.taskId);
		out.push({
			label: `drop noisiest ${drop} (${dropped.join(",")})`,
			taskIds: all.filter((id) => !dropped.includes(id)),
		});
	}
	const quietest = byVariance.slice(-3).map((t) => t.taskId);
	if (quietest.length === 3) {
		out.push({
			label: `quietest 3 only (${quietest.join(",")})`,
			taskIds: quietest,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface VarianceArgs {
	agent: string;
	dbPath: string | null;
	config: string | null;
	/** Restrict to one ruleset version. Scoping to a single A/B burn is what
	 * makes the arm-delta section meaningful — across burns, "pass 2" is not
	 * one configuration. */
	ruleset: number | null;
	rent: number;
	effect: number;
	trials: number;
	seed: number;
	runs: number;
	budget: number;
}

const DEFAULTS = {
	rent: 14,
	effect: 0.108,
	trials: 5000,
	seed: 20260813,
	runs: 5,
	/** The largest quota window this environment has actually delivered. The
	 * three compression burns observed capacities of roughly 81 runs, then 30,
	 * at a ~100k-token mean run; 6M is the generous end of that. Planning
	 * against a window the environment does not have is how three burns died. */
	budget: 6_000_000,
} as const;

export function parseVarianceArgs(argv: readonly string[]): VarianceArgs {
	const args: VarianceArgs = {
		agent: "sql",
		dbPath: null,
		config: null,
		ruleset: null,
		rent: DEFAULTS.rent,
		effect: DEFAULTS.effect,
		trials: DEFAULTS.trials,
		seed: DEFAULTS.seed,
		runs: DEFAULTS.runs,
		budget: DEFAULTS.budget,
	};
	const num = (raw: string | undefined, flag: string): number => {
		const n = Number(raw);
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error(`${flag} must be a positive number (got ${raw})`);
		}
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") {
			const agent = argv[++i] ?? "";
			assertKnownAgent(agent);
			args.agent = agent;
		} else if (flag === "--db") {
			args.dbPath = argv[++i] ?? null;
		} else if (flag === "--config") {
			args.config = argv[++i] ?? null;
		} else if (flag === "--ruleset") {
			const raw = argv[++i];
			const n = Number(raw);
			// Ruleset version 0 is the unruled baseline and a legitimate scope,
			// so this one cannot go through `num` (which rejects zero).
			if (!Number.isInteger(n) || n < 0) {
				throw new Error(
					`--ruleset must be a non-negative integer (got ${raw})`,
				);
			}
			args.ruleset = n;
		} else if (flag === "--rent") {
			args.rent = num(argv[++i], "--rent");
		} else if (flag === "--effect") {
			args.effect = num(argv[++i], "--effect");
		} else if (flag === "--trials") {
			args.trials = num(argv[++i], "--trials");
		} else if (flag === "--seed") {
			args.seed = num(argv[++i], "--seed");
		} else if (flag === "--runs") {
			args.runs = num(argv[++i], "--runs");
		} else if (flag === "--budget") {
			args.budget = num(argv[++i], "--budget");
		} else {
			throw new Error(`unknown flag ${flag}`);
		}
	}
	return args;
}

/**
 * Golden runs for one agent, in insertion order — the order `runSuite`
 * executed them, which is what makes the contiguous-block pass rule work.
 *
 * READ-ONLY. Unlike `openDb`, this deliberately does not run migrations: an
 * analysis of the user's production ledger must not write to it. Sub-floor
 * runs are excluded here rather than downstream, because a zero-token quota
 * death is not a measurement and pooling one inflates the variance it is
 * being used to estimate.
 */
export function loadRuns(
	dbPath: string,
	agent: string,
	config: string | null,
	ruleset: number | null = null,
): { runs: AnalysisRun[]; excluded: number } {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const rows = db
			.prepare<
				unknown[],
				{
					id: number;
					taskId: string;
					config: string;
					rulesetVersion: number;
					model: string;
					input: number;
					output: number;
					cacheCreation: number;
					cacheRead: number;
					toolCalls: number;
					completed: number;
				}
			>(
				`SELECT id, task_hash AS taskId, config, ruleset_version AS rulesetVersion,
				  COALESCE(model, '') AS model, input_tokens AS input,
				  output_tokens AS output, cache_creation AS cacheCreation,
				  cache_read AS cacheRead, tool_calls AS toolCalls, completed
				 FROM runs
				 WHERE agent = ? AND task_hash IS NOT NULL
				   AND (? IS NULL OR config = ?)
				   AND (? IS NULL OR ruleset_version = ?)
				 ORDER BY id ASC`,
			)
			.all(agent, config, config, ruleset, ruleset);
		const runs: AnalysisRun[] = [];
		let excluded = 0;
		for (const row of rows) {
			const run: AnalysisRun = { ...row, completed: row.completed === 1 };
			if (metricValue(run, "total") < ENV_FAILURE_TOKEN_FLOOR) {
				excluded++;
				continue;
			}
			runs.push(run);
		}
		return { runs, excluded };
	} finally {
		db.close();
	}
}

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

export function renderReport(
	args: VarianceArgs,
	runs: readonly AnalysisRun[],
	excluded: number,
): string[] {
	const out: string[] = [];
	const groups = groupIntoPasses(runs).filter((g) => g.runs.length >= 2);
	out.push(
		"=== token-warden variance decomposition (recorded runs, zero tokens) ===",
	);
	out.push(
		`agent ${args.agent} · ${runs.length} usable golden runs · ${groups.length} single-configuration passes` +
			` · rent ${args.rent} (2x cache-aware bar ~${Math.ceil(keepBar(args.rent))} tok) · z=${confidenceZ()}`,
	);
	if (excluded > 0) {
		out.push(
			`NOTE: ${excluded} recorded run(s) excluded below the ${fmt(ENV_FAILURE_TOKEN_FLOOR)}-token environment-failure floor — a quota death is not a measurement.`,
		);
	}
	if (groups.length === 0) {
		out.push(
			"NO: no configuration has 2+ contiguous runs; nothing to decompose.",
		);
		return out;
	}

	out.push("\n--- 1. per-task run-to-run noise, by metric ---");
	out.push(
		"task           n  passes |      total   CV |  processing   CV | costEquiv   CV",
	);
	const detail = new Map(
		METRIC_NAMES.map((m) => [
			m,
			new Map(taskNoise(groups, m).map((t) => [t.taskId, t])),
		]),
	);
	const taskIds = [
		...(detail.get("total") as Map<string, TaskNoiseDetail>).keys(),
	].sort();
	for (const id of taskIds) {
		const cells = METRIC_NAMES.map((m) => {
			const t = detail.get(m)?.get(id);
			if (t === undefined) return "        -    - ";
			return `${fmt(Math.sqrt(t.variance)).padStart(9)} ${pct(t.cv).padStart(6)}`;
		});
		const base = detail.get("total")?.get(id) as TaskNoiseDetail;
		out.push(
			`${id.padEnd(12)} ${String(base.n).padStart(3)} ${String(base.passes).padStart(6)}  | ${cells.join(" | ")}`,
		);
	}
	out.push("(figures are the within-pass standard deviation and its CV)");

	out.push(
		`\n--- 2. share of the suite standard error (${fmt(args.trials)} bootstrap resamples) ---`,
	);
	for (const metric of ["total", "processing"] as const) {
		const shares = bootstrapShares(groups, metric, args.trials, args.seed);
		out.push(
			`${metric}: ${shares
				.map((s) => `${s.taskId} ${pct(s.share)} [${pct(s.lo)}, ${pct(s.hi)}]`)
				.join("  ")}`,
		);
		const top3 = shares.slice(0, 3).reduce((a, s) => a + s.share, 0);
		out.push(`  top-3 tasks carry ${pct(top3)} of the variance`);
	}

	out.push("\n--- 3. mechanism: is the noise a property of the tasks? ---");
	for (const metric of METRIC_NAMES) {
		const fit = turnCostFit(groups, metric);
		if (fit === null) continue;
		out.push(
			`${metric.padEnd(14)} one extra tool call costs ${fmt(fit.slope).padStart(7)}` +
				`  ·  explains ${pct(fit.r2)} of the within-task spread (n=${fit.n})`,
		);
	}
	const turns = taskNoise(groups, "toolCalls");
	if (turns.length > 0) {
		out.push(
			`tool calls per run: ${turns
				.map(
					(t) =>
						`${t.taskId} ${t.metricMean.toFixed(1)}+-${Math.sqrt(t.variance).toFixed(2)} (${pct(t.cv)})`,
				)
				.join("  ")}`,
		);
		const cvs = turns.map((t) => t.cv).sort((a, b) => a - b);
		out.push(
			`turn-count CV spans ${pct(cvs[0] as number)}-${pct(cvs[cvs.length - 1] as number)} across tasks whose means span` +
				` ${Math.min(...turns.map((t) => t.metricMean)).toFixed(1)}-${Math.max(...turns.map((t) => t.metricMean)).toFixed(1)} calls.`,
		);
		out.push(
			"A turn-count CV that is flat across tasks of very different sizes is the finding: the spread is the",
		);
		out.push(
			"AGENT's run-to-run variability, not a defect in any task, and no task rewrite or split can move it.",
		);
	}

	out.push(
		`\n--- 4. the prize: burn size for a rule saving ${pct(args.effect)} of a run ---`,
	);
	out.push(
		`metric          SE@${args.runs}    MDS80@${args.runs}    MDS90@${args.runs}   target   runs/side   burn tokens`,
	);
	for (const metric of METRIC_NAMES) {
		const plan = burnPlan(groups, metric, args.rent, args.effect, args.runs);
		if (plan === null) continue;
		out.push(
			`${metric.padEnd(14)} ${fmt(plan.seAtDefaultRuns).padStart(7)} ${fmt(plan.mds80).padStart(9)} ${fmt(plan.mds90).padStart(9)} ${fmt(plan.targetSaving).padStart(8)} ${String(plan.runsPerSide ?? "none").padStart(11)}   ${plan.burnTokens === null ? "-" : `${(plan.burnTokens / 1e6).toFixed(1)}M`}`,
		);
	}
	out.push(
		"burn tokens are TOTAL tokens spent executing the runs — the scoring metric changes what a burn can RESOLVE, never what it COSTS.",
	);

	out.push(
		`\n--- 5. does removing the noisiest tasks help? (fixed ${(args.budget / 1e6).toFixed(1)}M-token budget) ---`,
	);
	out.push(
		"suite                                   runs/side    delta       SE   delta/SE   80% power?",
	);
	// Total tokens only, deliberately: this section asks whether a cheaper SUITE
	// is worth buying, and the burn is billed in total tokens whatever metric
	// scores the verdict. Running it per metric would print three tables that
	// differ only in a column the budget does not depend on.
	const subsetMetric = "total";
	for (const { label, taskIds } of candidateSubsets(groups, subsetMetric)) {
		const outcome = subsetAtBudget(
			groups,
			subsetMetric,
			args.rent,
			args.effect,
			args.budget,
			taskIds,
			label,
		);
		if (outcome === null) {
			out.push(`${label.padEnd(38)} (budget buys fewer than 2 runs/side)`);
			continue;
		}
		out.push(
			`${label.padEnd(38)} ${String(outcome.runsPerSide).padStart(9)} ${fmt(outcome.targetSaving).padStart(8)} ${fmt(outcome.standardError).padStart(8)} ${outcome.detectionRatio.toFixed(2).padStart(10)}   ${outcome.powered80 ? "YES" : "no"}`,
		);
	}
	out.push(
		`80% power needs delta/SE >= ${(confidenceZ() + Z_POWER_80).toFixed(2)}. The delta column SHRINKS with the suite because a`,
	);
	out.push(
		"proportional saving on a cheaper task is a smaller saving — which is the whole point: removing a",
	);
	out.push(
		"noisy task removes its signal too, and only the extra runs its tokens buy are a real gain.",
	);

	const arms = METRIC_NAMES.map((m) => armDelta(groups, m)).filter(
		(a): a is ArmDelta => a !== null,
	);
	if (arms.length > 0) {
		out.push(
			"\n--- 6. the recorded arms, differenced (scope with --config/--ruleset) ---",
		);
		out.push("metric            delta       SE   delta/SE");
		for (const arm of arms) {
			out.push(
				`${arm.metric.padEnd(14)} ${fmt(arm.delta).padStart(8)} ${fmt(arm.standardError).padStart(8)} ${(arm.delta / arm.standardError).toFixed(2).padStart(10)}`,
			);
		}
		const total = arms.find((a) => a.metric === "total");
		if (total) {
			out.push(
				`per task (total): ${total.perTask.map((t) => `${t.taskId} ${fmt(t.delta)}`).join("  ")}`,
			);
		}
		out.push(
			"A quieter metric is only useful if the SIGNAL survives it. Compare delta/SE across the rows:",
		);
		out.push(
			"if a metric's ratio does not improve, its smaller error bar bought nothing.",
		);
	}
	return out;
}

export function main(argv: string[]): number {
	const args = parseVarianceArgs(argv);
	const { runs, excluded } = loadRuns(
		args.dbPath ?? defaultDbPath(),
		args.agent,
		args.config,
		args.ruleset,
	);
	if (runs.length === 0) {
		console.log(`NO: no golden runs recorded for agent ${args.agent}.`);
		return 1;
	}
	for (const line of renderReport(args, runs, excluded)) console.log(line);
	return 0;
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
