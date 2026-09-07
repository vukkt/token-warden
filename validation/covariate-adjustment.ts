/**
 * COVARIATE ADJUSTMENT — can CUPED/ANCOVA buy the gate a smaller error bar?
 *
 * FINDINGS.md (2026-08-13) established that ONE integer explains 94.6% of the
 * golden suite's within-task spread: `tool_calls`, at ~14,018 total tokens per
 * agentic turn. It closed with the observation that "reducing the agent's
 * turn-count variability is the only quantity that would actually move the
 * floor" and that nothing in this repository controls it.
 *
 * There is a statistical version of that sentence, and this tool tests it. You
 * cannot reduce turn-count variability, but you can CONDITION ON IT. That is
 * CUPED (Deng et al. 2013) / regression adjustment / ANCOVA: subtract from each
 * run's cost the part a pre-recorded covariate predicts, so the remaining
 * variance is smaller while the treatment contrast stays unbiased. With a
 * covariate explaining 94.6% of the variance, textbook CUPED cuts the standard
 * error by sqrt(1 - 0.946) = 4.3x, which is exactly the order of magnitude the
 * compression A/B and the "is there real-work headroom" question both need.
 *
 * The catch is the word PRE-RECORDED. CUPED is unbiased only when the covariate
 * is unaffected by the treatment. `tool_calls` is not a nuisance variable that
 * happens to correlate with cost — it is the CHANNEL a memory rule saves
 * through. "Grep before reading" saves tokens by taking fewer turns. Adjusting
 * it away removes the effect along with the noise. This is the textbook
 * bad-control / post-treatment-bias failure, and this tool measures how bad it
 * is here rather than asserting it.
 *
 * ZERO TOKENS. No model is invoked; the ledger is opened READ-ONLY through
 * `variance-decomposition.ts#loadRuns`, which deliberately does not migrate.
 *
 * WHAT IT REPORTS, in the order the argument runs:
 *
 * 1. THE POOL and the pooled within-pass slope theta, with the variance it
 *    explains. This is the prize CUPED is reaching for, re-derived here on
 *    whatever slice you point it at rather than quoted from FINDINGS.
 *
 * 2. EFFECT PASS-THROUGH. Difference two recorded arms (two ruleset versions of
 *    the same tasks) and ask what fraction of the token delta is `theta` times
 *    the tool-call delta. This is the empirical calibration of the injection
 *    model below: it says, from data, how much of a REAL rule's saving flows
 *    through the covariate. If that fraction is near 1, CUPED cannot work here
 *    and no simulation is needed to know it.
 *
 * 3. FALSE POSITIVES. Permutation A/A and bootstrap-at-zero through the REAL
 *    verdict path (`assessDelta` + `promotedAt` + a top-up pass placed by the
 *    real `allocateTopUpRuns`), one column per estimator arm.
 *
 * 4. POWER, under TWO injection channels. `additive` is the channel every
 *    existing harness here uses: subtract a constant from the with-side token
 *    total and leave the covariate alone. `mechanistic` subtracts the same
 *    constant AND moves `tool_calls` by `saving / theta`, which is how the one
 *    real rule effect this project has ever measured actually behaved (see 2).
 *    The two arms are matched on the TRUE effect and differ only in whether the
 *    covariate moves with it, so the gap between them IS the bad-control bias.
 *
 * 5. BIAS. The mean point estimate against the injected truth. A keep rate alone
 *    cannot separate a smaller error bar from a bigger estimate: both promote
 *    more rules, and a multiplicative bias is invisible to an A/A harness
 *    because it has no effect to multiply. This is the screen that catches an
 *    estimator buying its power with an estimand change, and one of the arms
 *    below is caught by exactly this and nothing else.
 *
 * 6. MINIMUM DETECTABLE SAVING at 80% power, interpolated from the same sweep.
 *    That is the number that decides whether an estimator ships.
 *
 * WHY THE `additive` CHANNEL IS KEPT even though it is a fiction: a reader who
 * only sees the mechanistic column cannot tell a broken implementation from a
 * biased one. Under `additive` a correct CUPED implementation must show a large
 * power GAIN. If it does not, the estimator is wrong rather than merely
 * inapplicable. The additive column is the positive control on this tool.
 *
 *   npx tsx validation/covariate-adjustment.ts [--agent <name>] [--db <path>]
 *     [--config <name>] [--ruleset N] [--arm-a N] [--arm-b N] [--rent N]
 *     [--runs N] [--trials N] [--seed N] [--proportional]
 */
import { pathToFileURL } from "node:url";
import type { TaskSummary } from "../src/bench.js";
import { defaultDbPath } from "../src/db.js";
import { assertKnownAgent } from "../src/registry.js";
import { allocateTopUpRuns, assessDelta } from "../src/select.js";
import { mean, sum } from "../src/stats.js";
import { promotedAt, toSummary, wilson } from "./empirical-calibration.js";
import { mulberry32, resample, shuffled } from "./rng.js";
import {
	type AnalysisRun,
	groupIntoPasses,
	loadRuns,
	metricValue,
} from "./variance-decomposition.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Matches `empirical-calibration.ts`, so an FP number here is comparable to
 * the ones FINDINGS.md already publishes rather than a second scale. */
const DEFAULT_RENT = 25;
const DEFAULT_TRIALS = 2000;
/** The selector's own default run count. */
const DEFAULT_RUNS = 3;
const DEFAULT_SEED = 42;
/** Minimum runs in a pass before it can serve as a replicate pool. A slope
 * needs spread, and two points give one degree of freedom to find it in. */
const DEFAULT_MIN_POOL = 4;
/**
 * Injected savings as a fraction of the pool's mean run cost. Extends well past
 * the 20% ceiling `empirical-calibration.ts` sweeps, because an MDS at 80% power
 * is above that ceiling for every arm at these run counts, and an MDS reported
 * as ">20%" decides nothing.
 */
const INJECTED_FRACS = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5];
/** Power the minimum detectable saving is quoted at. */
const TARGET_POWER = 0.8;

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/** One recorded run reduced to the outcome and the covariate. The pair travels
 * together through every resample: a bootstrap that drew tokens and tool calls
 * independently would destroy the correlation the whole question is about. */
export interface CovariateRun {
	tokens: number;
	calls: number;
}

/** One task's replicate pool: runs of a single configuration, so their spread
 * is measurement noise rather than noise plus a treatment effect. */
export interface CovariatePool {
	taskId: string;
	runs: CovariateRun[];
}

/**
 * Deepest single-configuration pass per task, as (tokens, calls) pairs.
 *
 * Uses `groupIntoPasses` rather than `goldenReplicateRuns`'s key, for the
 * reason variance-decomposition.ts documents: an A/B burn records both arms
 * under `config='candidate'` at the same ruleset version, so keying on
 * (task, ruleset, model) alone pools the arms and reports the treatment effect
 * as noise. A pass is a contiguous block of one task's runs.
 */
export function buildPools(
	runs: readonly AnalysisRun[],
	minPool: number,
): CovariatePool[] {
	const best = new Map<string, CovariatePool>();
	for (const group of groupIntoPasses(runs)) {
		const completed = group.runs.filter((r) => r.completed);
		if (completed.length < minPool) continue;
		const pool: CovariatePool = {
			taskId: group.taskId,
			runs: completed.map((r) => ({
				tokens: metricValue(r, "total"),
				calls: r.toolCalls,
			})),
		};
		const current = best.get(group.taskId);
		if (!current || pool.runs.length > current.runs.length) {
			best.set(group.taskId, pool);
		}
	}
	return [...best.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

// ---------------------------------------------------------------------------
// The slope
// ---------------------------------------------------------------------------

export interface Slope {
	/** d(tokens) / d(tool calls), pooled across cells after centring each cell
	 * on its own means. Zero when the covariate does not vary. */
	theta: number;
	/** Fraction of the within-cell variance the single pooled slope removes. */
	r2: number;
	/** Within-cell degrees of freedom the slope was fitted on. */
	dof: number;
}

/**
 * Pooled WITHIN-CELL least-squares slope of tokens on tool calls.
 *
 * Cell-centred, never grand-centred: between-cell differences are task size
 * and configuration, not run-to-run noise, and fitting through them would
 * report the suite's task-size gradient as the noise slope. Each cell here is
 * one (task, side) group of one trial, or one recorded pass when the tool is
 * describing the pool.
 */
export function pooledSlope(
	cells: readonly (readonly CovariateRun[])[],
): Slope {
	let sxy = 0;
	let sxx = 0;
	let dof = 0;
	for (const cell of cells) {
		if (cell.length < 2) continue;
		const mx = mean(cell.map((r) => r.calls));
		const my = mean(cell.map((r) => r.tokens));
		for (const r of cell) {
			sxy += (r.calls - mx) * (r.tokens - my);
			sxx += (r.calls - mx) ** 2;
		}
		dof += cell.length - 1;
	}
	const theta = sxx > 0 ? sxy / sxx : 0;
	let sse = 0;
	let sst = 0;
	for (const cell of cells) {
		if (cell.length < 2) continue;
		const mx = mean(cell.map((r) => r.calls));
		const my = mean(cell.map((r) => r.tokens));
		for (const r of cell) {
			sse += (r.tokens - my - theta * (r.calls - mx)) ** 2;
			sst += (r.tokens - my) ** 2;
		}
	}
	return { theta, r2: sst > 0 ? 1 - sse / sst : 0, dof };
}

// ---------------------------------------------------------------------------
// Estimator arms
// ---------------------------------------------------------------------------

export type ArmName = "baseline" | "cuped" | "cuped-oracle" | "ratio";

export const ARM_NAMES: readonly ArmName[] = [
	"baseline",
	"cuped",
	"cuped-oracle",
	"ratio",
];

/** One task's drawn runs, both sides, before any adjustment. */
export interface TaskDraw {
	taskId: string;
	without: CovariateRun[];
	with: CovariateRun[];
}

/** The same task after an arm has decided what number the gate should see. */
interface AdjustedTask {
	taskId: string;
	without: number[];
	with: number[];
}

/**
 * Apply an arm's adjustment to a whole trial.
 *
 * `baseline` is the shipped gate: the raw token total, untouched.
 *
 * `cuped` subtracts `theta * (calls - calls_task)` from every run, where
 * `calls_task` is the mean covariate over BOTH sides of that task in this
 * trial. Centring on the pooled mean is what makes the adjustment a pure
 * contrast shift — the constant cancels in `mean_without - mean_with`, so the
 * estimator reads `delta_tokens - theta * delta_calls` exactly, which is the
 * ANCOVA form. `theta` is fitted on the TRIAL's own cells: an estimator that
 * borrowed the pool's slope would be given information a live selector cannot
 * have, and the small-sample cost of estimating theta is part of what is under
 * test.
 *
 * `cuped-oracle` is the same estimator handed the pool-level slope for free. It
 * is not a shippable policy; it is the CEILING. If the oracle arm does not pay,
 * no amount of better theta estimation rescues the real one.
 *
 * `ratio` is the fallback candidate: a per-task variance-stabilizing rescale.
 * Every run of task i is multiplied by `M / mu_i` (mu_i the pooled mean of both
 * sides, M the mean of those over tasks), so each task contributes its
 * FRACTIONAL saving to the suite mean instead of its absolute one, and the
 * suite's biggest tasks stop dominating the standard error. It uses no
 * covariate, so it is immune to the bad-control problem — and it changes the
 * estimand, which is its own price.
 */
export function adjust(
	draws: readonly TaskDraw[],
	arm: ArmName,
	oracleTheta: number,
): AdjustedTask[] {
	if (arm === "baseline") {
		return draws.map((d) => ({
			taskId: d.taskId,
			without: d.without.map((r) => r.tokens),
			with: d.with.map((r) => r.tokens),
		}));
	}
	if (arm === "ratio") {
		const mus = draws.map((d) =>
			mean([...d.without, ...d.with].map((r) => r.tokens)),
		);
		const grand = mean(mus);
		return draws.map((d, i) => {
			const mu = mus[i] as number;
			const scale = mu > 0 ? grand / mu : 1;
			return {
				taskId: d.taskId,
				without: d.without.map((r) => r.tokens * scale),
				with: d.with.map((r) => r.tokens * scale),
			};
		});
	}
	const theta =
		arm === "cuped-oracle"
			? oracleTheta
			: pooledSlope(draws.flatMap((d) => [d.without, d.with])).theta;
	return draws.map((d) => {
		const centre = mean([...d.without, ...d.with].map((r) => r.calls));
		const shift = (r: CovariateRun): number =>
			r.tokens - theta * (r.calls - centre);
		return {
			taskId: d.taskId,
			without: d.without.map(shift),
			with: d.with.map(shift),
		};
	});
}

const summaries = (
	tasks: readonly AdjustedTask[],
	side: "without" | "with",
	tag: string,
): TaskSummary[] =>
	tasks.map((t) =>
		toSummary(t.taskId, side === "without" ? t.without : t.with, tag),
	);

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

export type Channel = "additive" | "mechanistic";

/**
 * Subtract a known saving from one with-side run.
 *
 * `additive` moves the token total and nothing else — the channel every
 * existing harness in this repo assumes, and a fiction for any rule that works
 * by making the agent do less.
 *
 * `mechanistic` moves the token total by the same amount AND the covariate by
 * `saving / theta`, so the saving arrives the way the ledger says a real one
 * does. `theta` is the pool's own slope, so the injected run stays on the
 * pool's token-per-turn line instead of becoming an outlier off it.
 *
 * The tool-call count is left CONTINUOUS rather than rounded to an integer.
 * Rounding would quantize the injected effect at ~14,000 tokens a step, which
 * is coarser than every effect size under test; the continuous version is the
 * arithmetic the estimator sees and the conservative choice for CUPED, since a
 * clean linear covariate is the best case for regression adjustment.
 */
function inject(
	run: CovariateRun,
	saving: number,
	channel: Channel,
	theta: number,
): CovariateRun {
	const tokens = Math.max(0, run.tokens - saving);
	if (channel === "additive" || theta <= 0) return { ...run, tokens };
	return { tokens, calls: run.calls - saving / theta };
}

// ---------------------------------------------------------------------------
// Trials
// ---------------------------------------------------------------------------

export interface TrialSpec {
	pools: readonly CovariatePool[];
	runsPerSide: number;
	rent: number;
	arm: ArmName;
	oracleTheta: number;
	/** Per-task injected saving in tokens, aligned with `pools`. */
	savings: readonly number[];
	channel: Channel;
}

/**
 * What one trial produced: the gate's decision AND the point estimate it decided
 * on.
 *
 * The delta is carried because a keep rate alone cannot distinguish a
 * variance reduction from an estimand shift. An estimator that reports a
 * systematically LARGER saving keeps more rules at every effect size and is
 * indistinguishable from a better one on power — and its A/A false-positive
 * rate is untouched, because the bias is proportional to an effect the null
 * does not have. That is precisely how a biased estimator passes both halves of
 * this project's usual screen. Section 5 divides the mean delta by the injected
 * truth so the shift is visible instead of being paid for as power.
 */
export interface TrialOutcome {
	kept: boolean;
	/** Null when the measurement was unusable (regression / environment). */
	delta: number | null;
}

/**
 * One look at a candidate, mirroring `empirical-calibration.ts#candidateLook`
 * but carrying run RECORDS rather than bare totals, so an arm can re-adjust
 * after a top-up rather than adjust once and hope.
 *
 * The top-up budget and its placement are the selector's: one duplicate pass of
 * the measured side, poured into the high-variance tasks by the real
 * `allocateTopUpRuns`. The allocator is shown the ARM's OWN adjusted summaries,
 * which is the generous reading — an adjusted estimator that shipped would place
 * its extra runs against the variance it actually pays.
 */
function look(
	spec: TrialSpec,
	draws: TaskDraw[],
	topUp: () => TaskDraw[],
): TrialOutcome {
	const { rent, arm, oracleTheta } = spec;
	const assess = (d: TaskDraw[]) => {
		const tasks = adjust(d, arm, oracleTheta);
		return {
			assessment: assessDelta(
				summaries(tasks, "without", "w"),
				summaries(tasks, "with", "m"),
				rent,
			),
			tasks,
		};
	};
	const first = assess(draws);
	if (
		first.assessment.regression ||
		first.assessment.environmentFailure ||
		first.assessment.delta === null
	) {
		return { kept: false, delta: null };
	}
	let final = first.assessment;
	if (first.assessment.uncertain) {
		const extra = topUp();
		const budget = sum(draws.map((d) => d.with.length));
		const allocation = allocateTopUpRuns(
			summaries(first.tasks, "without", "w"),
			summaries(first.tasks, "with", "m"),
			budget,
		);
		const merged = draws.map((d, i) => {
			const drawn = extra[i] as TaskDraw;
			const n = allocation ? (allocation.get(d.taskId) ?? 0) : spec.runsPerSide;
			return { ...d, with: [...d.with, ...drawn.with.slice(0, n)] };
		});
		if (sum(merged.map((d) => d.with.length)) > budget) {
			final = assess(merged).assessment;
		}
	}
	return { kept: promotedAt(final, rent), delta: final.delta };
}

/**
 * PERMUTATION A/A. Per task, shuffle the replicate pool and deal the first
 * `runs` records to the without side and the next `runs` to the with side. Both
 * sides come from one pool, so the true delta is zero by construction and the
 * keep rate is the empirical false-positive rate. Records are dealt whole, so
 * the (tokens, calls) pairing every arm reads is the recorded one.
 */
export function permutationTrial(
	rng: () => number,
	spec: TrialSpec,
): TrialOutcome {
	const decks = spec.pools.map((p) => shuffled(rng, p.runs));
	const draws: TaskDraw[] = spec.pools.map((p, i) => {
		const deck = decks[i] as CovariateRun[];
		return {
			taskId: p.taskId,
			without: deck.slice(0, spec.runsPerSide),
			with: deck.slice(spec.runsPerSide, 2 * spec.runsPerSide),
		};
	});
	const topUp = (): TaskDraw[] =>
		spec.pools.map((p, i) => {
			const rest = (decks[i] as CovariateRun[]).slice(2 * spec.runsPerSide);
			const from = rest.length >= 2 ? rest : p.runs;
			return {
				taskId: p.taskId,
				without: [],
				with: resample(rng, from, spec.runsPerSide),
			};
		});
	return look(spec, draws, topUp);
}

/**
 * BOOTSTRAP. Both sides drawn with replacement from the pool, with the injected
 * saving applied to every with-side record through the chosen channel. A zero
 * saving is a bootstrap A/A and cross-checks the permutation.
 */
export function bootstrapTrial(
	rng: () => number,
	spec: TrialSpec,
): TrialOutcome {
	const drawWith = (i: number, n: number): CovariateRun[] => {
		const pool = spec.pools[i] as CovariatePool;
		return resample(rng, pool.runs, n).map((r) =>
			inject(r, spec.savings[i] as number, spec.channel, spec.oracleTheta),
		);
	};
	const draws: TaskDraw[] = spec.pools.map((p, i) => ({
		taskId: p.taskId,
		without: resample(rng, p.runs, spec.runsPerSide),
		with: drawWith(i, spec.runsPerSide),
	}));
	const topUp = (): TaskDraw[] =>
		spec.pools.map((p, i) => ({
			taskId: p.taskId,
			without: [],
			with: drawWith(i, spec.runsPerSide),
		}));
	return look(spec, draws, topUp);
}

export interface SweepResult {
	/** Fraction of trials the gate promoted: the false-positive rate at a zero
	 * injected saving, the power at a positive one. */
	rate: number;
	lo: number;
	hi: number;
	/** Mean point estimate over every measurable trial — the numerator of the
	 * bias check. Trials are counted whether or not they promoted, so this is the
	 * estimator's behaviour and not the gate's selection of it. */
	meanDelta: number;
}

/** Keep rate and mean point estimate over `trials` independent draws, with the
 * keep rate's Wilson interval. */
export function sweep(
	trial: (rng: () => number) => TrialOutcome,
	trials: number,
	seed: number,
): SweepResult {
	const rng = mulberry32(seed);
	let kept = 0;
	let measured = 0;
	let total = 0;
	for (let i = 0; i < trials; i++) {
		const outcome = trial(rng);
		if (outcome.kept) kept++;
		if (outcome.delta !== null) {
			measured++;
			total += outcome.delta;
		}
	}
	const { lo, hi } = wilson(kept, trials);
	return {
		rate: kept / trials,
		lo,
		hi,
		meanDelta: measured > 0 ? total / measured : Number.NaN,
	};
}

// ---------------------------------------------------------------------------
// Effect pass-through
// ---------------------------------------------------------------------------

export interface PassThroughRow {
	taskId: string;
	deltaTokens: number;
	deltaCalls: number;
	absorbed: number;
}

/**
 * What fraction of a RECORDED rule effect flows through the covariate.
 *
 * Differences two arms of the same tasks and compares the token delta with
 * `theta` times the tool-call delta. A fraction near 1 means the effect and the
 * noise arrive through the same channel, which is the condition under which no
 * covariate adjustment on that variable can work. This is the empirical warrant
 * for the `mechanistic` injection channel; without it that channel is an
 * assumption dressed as a measurement.
 */
export function passThrough(
	runs: readonly AnalysisRun[],
	armA: number,
	armB: number,
	theta: number,
): PassThroughRow[] {
	const byTask = new Map<string, { a: AnalysisRun[]; b: AnalysisRun[] }>();
	for (const run of runs) {
		if (!run.completed) continue;
		if (run.rulesetVersion !== armA && run.rulesetVersion !== armB) continue;
		let entry = byTask.get(run.taskId);
		if (!entry) {
			entry = { a: [], b: [] };
			byTask.set(run.taskId, entry);
		}
		(run.rulesetVersion === armA ? entry.a : entry.b).push(run);
	}
	const rows: PassThroughRow[] = [];
	for (const [taskId, { a, b }] of [...byTask].sort()) {
		if (a.length === 0 || b.length === 0) continue;
		const tok = (rs: AnalysisRun[]): number =>
			mean(rs.map((r) => metricValue(r, "total")));
		const calls = (rs: AnalysisRun[]): number =>
			mean(rs.map((r) => r.toolCalls));
		const deltaTokens = tok(a) - tok(b);
		const deltaCalls = calls(a) - calls(b);
		rows.push({
			taskId,
			deltaTokens,
			deltaCalls,
			absorbed: theta * deltaCalls,
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface CovariateArgs {
	agent: string;
	dbPath: string | null;
	config: string | null;
	ruleset: number | null;
	armA: number | null;
	armB: number | null;
	rent: number;
	runs: number;
	trials: number;
	seed: number;
	minPool: number;
	/** Inject the saving as a fraction of each task's OWN mean rather than as a
	 * constant number of tokens across tasks. The `ratio` arm's estimand is the
	 * proportional one, so a constant-absolute injection judges it on a question
	 * it does not claim to answer. */
	proportional: boolean;
}

export function parseCovariateArgs(argv: readonly string[]): CovariateArgs {
	const args: CovariateArgs = {
		agent: "sql",
		dbPath: null,
		config: "candidate",
		ruleset: null,
		armA: null,
		armB: null,
		rent: DEFAULT_RENT,
		runs: DEFAULT_RUNS,
		trials: DEFAULT_TRIALS,
		seed: DEFAULT_SEED,
		minPool: DEFAULT_MIN_POOL,
		proportional: false,
	};
	const num = (raw: string | undefined, flag: string): number => {
		const n = Number(raw);
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error(`${flag} must be a positive number (got ${raw})`);
		}
		return n;
	};
	const version = (raw: string | undefined, flag: string): number => {
		const n = Number(raw);
		// Ruleset version 0 is the unruled baseline and a legitimate arm.
		if (!Number.isInteger(n) || n < 0) {
			throw new Error(`${flag} must be a non-negative integer (got ${raw})`);
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
			args.ruleset = version(argv[++i], "--ruleset");
		} else if (flag === "--arm-a") {
			args.armA = version(argv[++i], "--arm-a");
		} else if (flag === "--arm-b") {
			args.armB = version(argv[++i], "--arm-b");
		} else if (flag === "--rent") {
			args.rent = num(argv[++i], "--rent");
		} else if (flag === "--runs") {
			args.runs = num(argv[++i], "--runs");
		} else if (flag === "--trials") {
			args.trials = num(argv[++i], "--trials");
		} else if (flag === "--seed") {
			args.seed = num(argv[++i], "--seed");
		} else if (flag === "--min-pool") {
			args.minPool = num(argv[++i], "--min-pool");
		} else if (flag === "--proportional") {
			args.proportional = true;
		} else {
			throw new Error(`unknown flag ${flag}`);
		}
	}
	return args;
}

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const cell = (r: { rate: number; lo: number; hi: number }): string =>
	`${pct(r.rate)} [${pct(r.lo)}, ${pct(r.hi)}]`;

/** The two deepest ruleset versions present, so the pass-through section has a
 * default that does not require the caller to already know the ledger. */
export function deepestArms(
	runs: readonly AnalysisRun[],
): { a: number; b: number } | null {
	const depth = new Map<number, number>();
	for (const run of runs) {
		if (!run.completed) continue;
		depth.set(run.rulesetVersion, (depth.get(run.rulesetVersion) ?? 0) + 1);
	}
	const ranked = [...depth].sort((x, y) => y[1] - x[1]);
	if (ranked.length < 2) return null;
	const first = ranked[0] as [number, number];
	const second = ranked[1] as [number, number];
	return { a: first[0], b: second[0] };
}

/**
 * Smallest injected saving reaching `TARGET_POWER`, linearly interpolated
 * between the two sweep points that straddle it. Null when the sweep never gets
 * there — reported as such rather than extrapolated, because the power curve is
 * not linear and an MDS invented past the last measured point is a guess.
 */
export function interpolateMds(
	savings: readonly number[],
	powers: readonly number[],
): number | null {
	for (let i = 1; i < powers.length; i++) {
		const lo = powers[i - 1] as number;
		const hi = powers[i] as number;
		if (lo < TARGET_POWER && hi >= TARGET_POWER) {
			const a = savings[i - 1] as number;
			const b = savings[i] as number;
			return hi === lo ? b : a + ((TARGET_POWER - lo) / (hi - lo)) * (b - a);
		}
	}
	return null;
}

export function renderReport(
	args: CovariateArgs,
	runs: readonly AnalysisRun[],
	pools: readonly CovariatePool[],
): string[] {
	const out: string[] = [];
	const slope = pooledSlope(pools.map((p) => p.runs));
	const taskMeans = pools.map((p) => mean(p.runs.map((r) => r.tokens)));
	/**
	 * The mean of the per-task means, NOT the mean over pooled runs. The suite's
	 * estimand is the unweighted mean saving across tasks, so this is the scale
	 * against which an injected fraction becomes a suite-level saving. Both
	 * injection shapes below land on the same true suite delta at the same
	 * fraction — constant `f x suiteMean` on every task, or `f x mu_i` on task i
	 * whose mean over tasks is again `f x suiteMean` — which is what makes the
	 * two shapes comparable in one MDS column. Pooling the runs instead would
	 * weight deeper tasks more and quietly change the target the MDS is quoted
	 * against.
	 */
	const suiteMean = mean(taskMeans);

	out.push(
		`COVARIATE ADJUSTMENT -- agent ${args.agent}, config ${args.config ?? "(all)"}`,
	);
	out.push(
		`runs/side ${args.runs}, rent ${args.rent}, trials ${args.trials}, seed ${args.seed}` +
			`${args.proportional ? ", proportional injection" : ""}`,
	);
	out.push("");
	out.push("1. THE POOL");
	out.push("");
	out.push("| task | runs | mean tokens | mean calls | CV |");
	out.push("|---|---|---|---|---|");
	for (const p of pools) {
		const tokens = p.runs.map((r) => r.tokens);
		const mu = mean(tokens);
		const sd = Math.sqrt(
			sum(tokens.map((t) => (t - mu) ** 2)) / (tokens.length - 1),
		);
		out.push(
			`| ${p.taskId} | ${p.runs.length} | ${fmt(mu)} | ${mean(p.runs.map((r) => r.calls)).toFixed(1)} | ${pct(sd / mu)} |`,
		);
	}
	out.push("");
	out.push(
		`Pooled within-pass slope: one extra tool call costs ${fmt(slope.theta)} tokens,` +
			` explaining ${pct(slope.r2)} of the within-pass variance (${slope.dof} df).`,
	);
	out.push(
		`Textbook CUPED ceiling from that R^2: SE x sqrt(1 - R^2) = ${Math.sqrt(1 - slope.r2).toFixed(3)},` +
			` i.e. a ${(1 / Math.sqrt(1 - slope.r2)).toFixed(1)}x smaller error bar -- IF the covariate were pre-treatment.`,
	);

	const armA = args.armA ?? deepestArms(runs)?.a ?? null;
	const armB = args.armB ?? deepestArms(runs)?.b ?? null;
	out.push("");
	out.push("2. EFFECT PASS-THROUGH -- is the covariate pre-treatment?");
	out.push("");
	if (armA === null || armB === null) {
		out.push(
			"NO: this slice holds only one ruleset version, so no recorded effect can be",
		);
		out.push(
			"differenced. Point --config/--ruleset at a slice with two arms, or pass",
		);
		out.push("--arm-a/--arm-b.");
	} else {
		const rows = passThrough(runs, armA, armB, slope.theta);
		out.push(`Arms differenced: ruleset ${armA} minus ruleset ${armB}.`);
		out.push("");
		out.push("| task | delta tokens | delta calls | theta x delta calls |");
		out.push("|---|---|---|---|");
		for (const r of rows) {
			out.push(
				`| ${r.taskId} | ${fmt(r.deltaTokens)} | ${r.deltaCalls.toFixed(2)} | ${fmt(r.absorbed)} |`,
			);
		}
		const dTok = mean(rows.map((r) => r.deltaTokens));
		const dAbs = mean(rows.map((r) => r.absorbed));
		out.push(
			`| **suite mean** | **${fmt(dTok)}** | ${mean(rows.map((r) => r.deltaCalls)).toFixed(2)} | **${fmt(dAbs)}** |`,
		);
		out.push("");
		out.push(
			dTok === 0
				? "The two arms do not differ, so pass-through is undefined here."
				: `A CUPED adjustment on tool calls would subtract ${pct(dAbs / dTok)} of this` +
						` recorded effect away as if it were noise.`,
		);
	}

	const savingsFor = (frac: number): number[] =>
		pools.map((_, i) =>
			args.proportional ? frac * (taskMeans[i] as number) : frac * suiteMean,
		);
	const specFor = (
		arm: ArmName,
		frac: number,
		channel: Channel,
	): TrialSpec => ({
		pools,
		runsPerSide: args.runs,
		rent: args.rent,
		arm,
		oracleTheta: slope.theta,
		savings: savingsFor(frac),
		channel,
	});
	const positive = INJECTED_FRACS.filter((f) => f > 0);
	const ceiling =
		(INJECTED_FRACS[INJECTED_FRACS.length - 1] as number) * suiteMean;

	out.push("");
	out.push("3. FALSE POSITIVES (true delta = 0)");
	out.push("");
	out.push("| estimator | permutation A/A | bootstrap A/A |");
	out.push("|---|---|---|");
	for (const arm of ARM_NAMES) {
		const perm = sweep(
			(rng) => permutationTrial(rng, specFor(arm, 0, "additive")),
			args.trials,
			args.seed,
		);
		const boot = sweep(
			(rng) => bootstrapTrial(rng, specFor(arm, 0, "additive")),
			args.trials,
			args.seed + 1,
		);
		out.push(`| ${arm} | ${cell(perm)} | ${cell(boot)} |`);
	}

	out.push("");
	out.push("4. POWER, by injection channel");
	const mdsRows: string[] = [];
	const biasRows: string[] = [];
	for (const channel of ["additive", "mechanistic"] as const) {
		out.push("");
		out.push(
			channel === "additive"
				? "**additive** -- the saving moves tokens only (the fiction every other harness here"
				: "**mechanistic** -- the saving moves tokens AND tool calls at the pool's own slope",
		);
		out.push(
			channel === "additive"
				? "assumes; kept as the positive control on this tool: a correct CUPED must win here)."
				: "(what section 2 says a real rule does).",
		);
		out.push("");
		out.push(
			`| estimator | ${positive.map((f) => pct(f)).join(" | ")} | MDS80 |`,
		);
		out.push(`|---|${positive.map(() => "---").join("|")}|---|`);
		for (const arm of ARM_NAMES) {
			const powers: number[] = [];
			for (const frac of INJECTED_FRACS) {
				const result = sweep(
					(rng) => bootstrapTrial(rng, specFor(arm, frac, channel)),
					args.trials,
					args.seed + 2,
				);
				powers.push(result.rate);
				// The bias check is quoted at one effect size rather than all of
				// them: a ratio of means is unstable where the true delta is near
				// zero, and 10% is both well clear of that and the size FINDINGS
				// quotes the compression effect at.
				if (frac === 0.1) {
					const truth = mean(savingsFor(frac));
					biasRows.push(
						`| ${arm} | ${channel} | ${fmt(truth)} | ${fmt(result.meanDelta)} | ${(
							result.meanDelta / truth
						).toFixed(2)}x |`,
					);
				}
			}
			const mds = interpolateMds(
				INJECTED_FRACS.map((f) => f * suiteMean),
				powers,
			);
			const label = mds === null ? `> ${fmt(ceiling)}` : fmt(mds);
			out.push(
				`| ${arm} | ${powers
					.slice(1)
					.map((p) => pct(p))
					.join(" | ")} | ${label} |`,
			);
			mdsRows.push(`${channel}/${arm}: MDS80 = ${label} tok/run`);
		}
	}

	out.push("");
	out.push("5. IS IT VARIANCE, OR IS IT BIAS?");
	out.push("");
	out.push(
		"Mean point estimate against the injected truth, at a 10% saving. A gate keeps",
	);
	out.push(
		"more rules when the error bar shrinks AND when the estimate inflates, and the",
	);
	out.push(
		"A/A false-positive rate above cannot tell those apart -- a multiplicative bias",
	);
	out.push("is exactly zero under a null with no effect to multiply.");
	out.push("");
	out.push(
		"COMPARE EACH ARM TO THE BASELINE ROW, not to 1.00x. The baseline is not 1.00x",
	);
	out.push(
		"either, and that is a property of the shipped pipeline rather than of any arm",
	);
	out.push(
		"here: the top-up fires only when the first look is UNCERTAIN, so an unluckily",
	);
	out.push(
		"low first draw is re-measured and pulled back up while a high one is kept as",
	);
	out.push(
		"it stands. Every arm inherits that same optional-stopping inflation, so the",
	);
	out.push(
		"arm-to-arm difference is the estimator and the offset is the policy.",
	);
	out.push("");
	out.push("| estimator | channel | true delta | mean estimate | ratio |");
	out.push("|---|---|---|---|---|");
	for (const row of biasRows) out.push(row);

	out.push("");
	out.push("6. MINIMUM DETECTABLE SAVING at 80% power, tokens per run");
	out.push("");
	out.push(
		`Suite mean run cost: ${fmt(suiteMean)} tokens` +
			` (mean of per-task means; injections are scaled against it).`,
	);
	for (const row of mdsRows) out.push(`  ${row}`);
	out.push("");
	out.push(
		"Read the mechanistic block, not the additive one. The additive block only",
	);
	out.push(
		"confirms the adjustment is implemented correctly; it credits an estimator for",
	);
	out.push("removing variance from an effect that does not exist.");
	out.push(
		"And read section 5 before crediting any arm with the power in section 4.",
	);
	return out;
}

export function main(argv: string[]): number {
	const args = parseCovariateArgs(argv);
	const { runs } = loadRuns(
		args.dbPath ?? defaultDbPath(),
		args.agent,
		args.config,
		args.ruleset,
	);
	if (runs.length === 0) {
		console.log(`NO: no golden runs recorded for agent ${args.agent}.`);
		return 1;
	}
	const pools = buildPools(runs, args.minPool);
	if (pools.length < 2) {
		console.log(
			`NO: need >= 2 tasks with a pass of >= ${args.minPool} completed runs;` +
				` found ${pools.length}.`,
		);
		return 1;
	}
	for (const line of renderReport(args, runs, pools)) console.log(line);
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
