/**
 * Selector: measure candidates, keep what earns its rent, evict the rest,
 * compile survivors into the agent's persistent memory.
 *
 * CLI: npx tsx src/select.ts --agent <name> [--runs <n>]
 *
 * Per invocation (cost-bounded):
 * - bench the active set once (shared baseline for all candidates)
 * - bench each candidate (oldest first, max 3) on top of the active set
 * - re-audit the least recently decided active rule by benching without it
 * - regenerate ~/.claude/agent-memory/<agent>/MEMORY.md wholesale from the
 *   final active set and bump the agent's ruleset_version
 *
 * Evicted rules are never deleted — they are the negative dataset.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	assertPosixPlatform,
	EnvironmentFailureError,
	type GoldenTask,
	goldenSuiteHash,
	isEnvironmentFailure,
	loadAgentDefinition,
	loadGoldenTasks,
	passEnvironmentFailure,
	runSuite,
	summarizeTask,
	type TaskSummary,
} from "./bench.js";
import { runCli } from "./cli.js";
import {
	agentTokenMix,
	bumpRulesetVersion,
	decideRule,
	getActiveRules,
	getRulesetVersion,
	listCandidates,
	oldestDecidedActiveRule,
	openDb,
	type RuleRow,
	type RunConfig,
	recordReceipt,
	setRuleProbation,
	type WardenDb,
} from "./db.js";
import {
	compileActiveMemory,
	healMemoryDrift,
	memoryFilePath,
} from "./memory.js";
import { blendedDollarsPerToken, priceFor } from "./pricing.js";
import { assertKnownAgent } from "./registry.js";
import { displayText } from "./sanitize.js";
import {
	confidenceZ,
	effectiveRent,
	mean,
	median,
	pooledVariance,
	sampleVariance,
	sessionsPerWeek,
	sum,
	weightedMean,
} from "./stats.js";

const MAX_CANDIDATES_PER_INVOCATION = 3;

/** Whether a rule is carried in compiled memory or banked as a negative
 * example. Every verdict in this module lands on exactly one of these. */
export type RuleStatus = "active" | "evicted";

/** Why a rule was measured: a pending candidate seeking promotion, or an
 * active rule being re-audited for continued worth. The two differ only in
 * how the measurement is framed and how an uncertain verdict resolves. */
export type DecisionKind = "candidate" | "re-audit";

/** Which variance a standard error was built from. "within-task" is the
 * correct fixed-suite estimator; "between-task" is the legacy runs=1
 * fallback — surfaced so a verdict's confidence basis is auditable. */
export type StandardErrorBasis = "within-task" | "between-task";

export interface VerdictInput {
	measuredDelta: number | null;
	contextCost: number;
}

/** Keep/evict inequality from the spec: a rule must save at least twice its
 * (cache-aware) context rent. SESSIONS_PER_WEEK cancels in the carry term but
 * is kept so the policy reads as the spec states it, and now also amortizes the
 * one-time cache re-prefill. */
export function verdict(rule: VerdictInput): RuleStatus {
	if (rule.measuredDelta === null || rule.measuredDelta <= 0) return "evicted";
	return rule.measuredDelta >= 2 * effectiveRent(rule.contextCost)
		? "active"
		: "evicted";
}

export interface ReasonedVerdict {
	status: RuleStatus;
	reason: string;
}

/** Verdict plus the human-readable reason stored on the rule and shown in
 * the /warden-status eviction ledger. */
export function verdictWithReason(
	delta: number | null,
	contextCost: number,
	regression: boolean,
): ReasonedVerdict {
	if (regression) {
		return {
			status: "evicted",
			reason: "regression: a previously passing golden task failed",
		};
	}
	if (delta === null) {
		return { status: "evicted", reason: "no comparable completed runs" };
	}
	if (delta <= 0) {
		return { status: "evicted", reason: `non-positive delta (${delta})` };
	}
	const status = verdict({ measuredDelta: delta, contextCost });
	// Ceil so the displayed bar never rounds down to equal a sub-threshold delta
	// (which would read "savings 21 < ... (21)"); an active delta still reads ≥.
	const bar = Math.ceil(2 * effectiveRent(contextCost));
	return status === "active"
		? { status, reason: `savings ${delta} ≥ 2× cache-aware rent (${bar})` }
		: {
				status,
				reason: `sub-threshold: savings ${delta} < 2× cache-aware rent (${bar})`,
			};
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Drop genuine "derailment" outliers — a run that costs both >50% away from the
 * median *and* more than 3 MADs out (a Hampel filter with a relative floor).
 * Conservative on purpose: clean, symmetric noise is never trimmed (so the
 * estimate is unchanged on well-behaved data), and only a real blow-up like
 * `sql-05`'s 96k-vs-42k run is removed. Never trims below one observation; a
 * no-op below 3 runs (an outlier can't be identified from two points).
 */
function filterOutliers(xs: number[]): number[] {
	if (xs.length < 3) return xs;
	const med = median(xs);
	const mad = median(xs.map((x) => Math.abs(x - med)));
	const threshold = Math.max(3 * mad, 0.5 * Math.abs(med));
	const kept = xs.filter((x) => Math.abs(x - med) <= threshold);
	return kept.length >= 1 ? kept : xs;
}

/** Completed-run token vectors for one task under both configurations. */
interface SidePair {
	without: number[];
	with: number[];
}

/** Pooled (borrowed) run-to-run variance of each side, used for tasks too thin
 * to estimate their own. */
interface PooledVariances {
	without: number;
	with: number;
}

/** Null when either side has no task with ≥2 runs — no variance is estimable
 * and every within-task statistic must stand down. */
function pooledSideVariances(pairs: SidePair[]): PooledVariances | null {
	const without = pooledVariance(pairs.map((p) => p.without));
	const withRule = pooledVariance(pairs.map((p) => p.with));
	if (without === null || withRule === null) return null;
	return { without, with: withRule };
}

/** Variance of one task's saving, `s²_without/n_without + s²_with/n_with`,
 * borrowing the pooled estimate for a side that cannot estimate its own. */
function taskSavingVariance(pair: SidePair, pooled: PooledVariances): number {
	const varWithout = sampleVariance(pair.without) ?? pooled.without;
	const varWith = sampleVariance(pair.with) ?? pooled.with;
	return varWithout / pair.without.length + varWith / pair.with.length;
}

/** Propagated within-task standard error of the WEIGHTED mean saving:
 * `sqrt( Σᵢ wᵢ²·[s²_without,i/n_i + s²_with,i/n_i] ) / Σᵢ wᵢ`. This is the exact
 * propagation of independent per-task run-to-run noise through the weighted mean
 * `Σ wᵢ sᵢ / Σ wᵢ`. With every wᵢ = 1 it collapses to the unweighted
 * `sqrt( (1/K²)·Σᵢ [·] )` — the K² in the old formula is `(Σ 1)²` — so the
 * unweighted path stays bit-identical. `weights` is aligned with `pairs`. Null
 * when no task has ≥2 runs/side. */
function withinTaskSE(pairs: SidePair[], weights: number[]): number | null {
	if (pairs.length === 0) return null;
	const pooled = pooledSideVariances(pairs);
	if (pooled === null) return null;
	let sumVar = 0;
	for (let i = 0; i < pairs.length; i++) {
		const weight = weights[i] as number;
		sumVar += weight ** 2 * taskSavingVariance(pairs[i] as SidePair, pooled);
	}
	return Math.sqrt(sumVar / sum(weights) ** 2);
}

/** Uniform weights leave every DoF correction at exactly 1, which is what keeps
 * the unweighted gate bit-identical to the pre-weighting calibration. */
function weightsAreUniform(weights: number[]): boolean {
	const first = weights[0];
	return weights.every((w) => w === first);
}

/**
 * Effective-degrees-of-freedom inflation of the confidence multiple for a
 * WEIGHTED suite. Concentrating weight onto fewer tasks lowers the effective
 * sample size of the SE *estimate*, so a flat normal quantile z under-covers
 * and the false-positive rate creeps up (the calibration harness measured this:
 * weights [4,1,1,1,1] pushed FP from ~4% to ~6.5% at runs=2). We widen z by the
 * ratio of the small-sample t-inflation at the actual effective DoF to the same
 * at the uniform-weight DoF, using the Cornish-Fisher expansion
 * `t_df ≈ z·(1 + (z²+1)/(4·df))`:
 *
 *   f = [1 + (z²+1)/(4·df_actual)] / [1 + (z²+1)/(4·df_uniform)]
 *
 * At uniform weights df_actual == df_uniform so f == 1 *exactly* — the unweighted
 * gate is bit-identical. As weights concentrate, df_actual < df_uniform so f > 1
 * and the gate tightens back toward the unweighted false-positive rate. The
 * target is parity with the (already accepted) unweighted gate at the same run
 * count, not the nominal z — weighting must not make the gate more
 * anti-conservative than not weighting.
 */
function tInflation(df: number, z: number): number {
	return Number.isFinite(df) && df > 0 ? 1 + (z ** 2 + 1) / (4 * df) : 1;
}

/** Welch-Satterthwaite DoF of `Σ aᵢ` with `aᵢ = wᵢ²·termᵢ`; the arrays are
 * aligned. Infinite (i.e. no small-sample penalty) when no term contributes. */
function satterthwaiteDof(
	weights: number[],
	terms: number[],
	dofs: number[],
): number {
	let num = 0;
	let den = 0;
	for (let i = 0; i < terms.length; i++) {
		const a = (weights[i] as number) ** 2 * (terms[i] as number);
		num += a;
		den += (a * a) / (dofs[i] as number);
	}
	return den > 0 ? (num * num) / den : Number.POSITIVE_INFINITY;
}

/** Within-task effective-DoF inflation: Welch-Satterthwaite over the per-task
 * variance contributions aᵢ = wᵢ²·(s²_wo,i/n + s²_w,i/n), with per-task DoF
 * (n_wo-1)+(n_w-1). Returns 1 for uniform weights (bit-identical) or when the
 * DoF is not estimable. `weights` is aligned with `pairs`. Exported for the
 * unit tests that pin the correction's shape. */
export function withinTaskDofInflation(
	pairs: SidePair[],
	weights: number[],
	z: number,
): number {
	if (pairs.length === 0) return 1;
	if (weightsAreUniform(weights)) return 1;
	const pooled = pooledSideVariances(pairs);
	if (pooled === null) return 1;
	const terms: number[] = [];
	const dofs: number[] = [];
	for (const pair of pairs) {
		const term = taskSavingVariance(pair, pooled);
		if (term <= 0) return 1; // a zero-variance task makes df undefined; no adj.
		terms.push(term);
		dofs.push(Math.max(1, pair.without.length - 1 + (pair.with.length - 1)));
	}
	// Clamp to >= 1: weighting may TIGHTEN the gate (concentration onto
	// equal-variance tasks lowers effective DoF) but must never loosen it below
	// the calibrated unweighted z — a gate is only ever made stricter by weights.
	return Math.max(
		1,
		tInflation(satterthwaiteDof(weights, terms, dofs), z) /
			tInflation(
				satterthwaiteDof(
					weights.map(() => 1),
					terms,
					dofs,
				),
				z,
			),
	);
}

/** Between-task effective-DoF inflation (the runs=1 fallback). Concentrating
 * weight lowers the Kish effective sample size n_eff = (Σw)²/Σw²; the SE there
 * carries n_eff - 1 degrees of freedom versus K - 1 unweighted. Returns 1 for
 * uniform weights (bit-identical). Exported for the unit tests. */
export function betweenTaskDofInflation(weights: number[], z: number): number {
	const k = weights.length;
	if (k < 2) return 1;
	if (weightsAreUniform(weights)) return 1;
	const sumW = sum(weights);
	const sumW2 = weights.reduce((a, w) => a + w ** 2, 0);
	const nEff = (sumW * sumW) / sumW2;
	// Kish n_eff <= K always, so this ratio is already >= 1; clamp defensively.
	return Math.max(
		1,
		tInflation(Math.max(1, nEff - 1), z) / tInflation(k - 1, z),
	);
}

// ---------------------------------------------------------------------------
// Delta assessment
// ---------------------------------------------------------------------------

interface DeltaResult {
	/** Mean tokens saved per golden run (positive = candidate is cheaper);
	 * null when no task completed in both configurations. */
	delta: number | null;
	/** True when a task that completed in the baseline configuration has no
	 * completed run in the candidate configuration → immediate eviction. */
	regression: boolean;
}

/** One golden task measured under both configurations: the point saving plus
 * the raw completed-run token vectors needed to estimate run-to-run noise. */
interface TaskComparison {
	saving: number;
	withoutTokens: number[];
	withTokens: number[];
	/** Distribution weight of this task, taken from the BASELINE (without-rule)
	 * summary: the reference configuration defines the suite composition, so a
	 * rule cannot alter its own task weighting by changing completion behavior. */
	weight: number;
}

/** Per-task comparisons for tasks completed in both configurations
 * (invariant #3), plus the regression, completion-drop, and
 * environment-failure flags. */
interface ComparisonSet {
	comparisons: TaskComparison[];
	regression: boolean;
	completionDrop: boolean;
	environmentFailure: boolean;
}

/** Completed-run tokens for one task in a summary set. */
function completedTokens(summary: TaskSummary | undefined): number[] {
	return (summary?.results ?? [])
		.filter((r) => r.completed)
		.map((r) => r.tokens);
}

/**
 * True when a task's lack of completed runs is the environment's fault rather
 * than evidence about the rule: the side is missing entirely (a truncated,
 * environment-aborted pass), or every run that did happen was a zero-token
 * death (quota exhaustion, API outage). A failure that burned real tokens is
 * the opposite — the agent attempted the task and broke it.
 *
 * On the with-rule side that distinction is the difference between an abort and
 * an eviction; reading a quota death as a regression was the false-eviction bug
 * of FINDINGS.md 2026-07.
 *
 * An EMPTY result array counts as environmental, deliberately: a task carried
 * in a pass with zero recorded runs is a pass that was cut short, and "no data"
 * must never be read as evidence against a rule. The conservative failure mode
 * — abort the invocation, requeue the rule, measure again — is the correct one
 * for an absence of data; the alternatives are evicting a rule that was never
 * measured, or quietly dropping the task from the suite the verdict claims.
 */
function noCompletedRunsAreEnvironmental(
	summary: TaskSummary | undefined,
): boolean {
	return summary === undefined || summary.results.every(isEnvironmentFailure);
}

function perTaskComparisons(
	without: TaskSummary[],
	withRule: TaskSummary[],
): ComparisonSet {
	const withById = new Map(withRule.map((s) => [s.taskId, s]));
	const comparisons: TaskComparison[] = [];
	let regression = false;
	let completionDrop = false;
	let environmentFailure = false;
	for (const base of without) {
		const withoutTokens = completedTokens(base);
		if (withoutTokens.length === 0) {
			// Symmetry with the with-side check below. A BASELINE task whose runs
			// all died environmentally must not be silently dropped: that shrinks
			// the suite behind the verdict's back. A quota death taking 3 of 7
			// baseline tasks stays under the pass-level majority guard, and the
			// surviving 4 would then produce a confident-looking verdict reported
			// as if it were measured on the whole suite. A baseline task that
			// failed while burning real tokens is a different thing — the task is
			// simply not comparable — and is still skipped.
			if (noCompletedRunsAreEnvironmental(base)) environmentFailure = true;
			continue;
		}
		const other = withById.get(base.taskId);
		const withTokens = completedTokens(other);
		if (other === undefined || withTokens.length === 0) {
			if (noCompletedRunsAreEnvironmental(other)) environmentFailure = true;
			else regression = true;
			continue;
		}
		// Savings means use completed runs only, so a rule whose failed runs are
		// excluded looks cheaper than it is (survivorship bias). A lower
		// completion RATE on the with-rule side flags that the mean may be
		// flattered by dropped failures. Rates, not counts: a variance top-up
		// legitimately gives the measured side more runs.
		const withoutRate = withoutTokens.length / base.results.length;
		const withRate = withTokens.length / other.results.length;
		if (withRate < withoutRate) completionDrop = true;
		comparisons.push({
			saving: base.meanCompletedTokens - other.meanCompletedTokens,
			withoutTokens,
			withTokens,
			weight: base.weight,
		});
	}
	return { comparisons, regression, completionDrop, environmentFailure };
}

export interface DeltaAssessment extends DeltaResult {
	/** Standard error of the saving. Propagated *within-task* run-to-run variance
	 * when ≥2 runs/side exist (the correct fixed-suite estimand — shrinks as
	 * 1/√runs); falls back to the between-task spread only when no within-task
	 * variance is estimable. Null with <2 comparable tasks. */
	standardError: number | null;
	/** Which variance the standard error is built from. "within-task" is the
	 * correct fixed-suite estimator; "between-task" is the legacy fallback at
	 * runs=1 — surfaced so a verdict's confidence basis is auditable. */
	standardErrorBasis: StandardErrorBasis | null;
	/** True when the keep/evict verdict could flip within `WARDEN_CONFIDENCE_Z`
	 * standard errors — the signal to spend a top-up measurement. */
	uncertain: boolean;
	/** The saving after dropping derailment outliers (robust location). Null when
	 * robust aggregation could not run (runs=1). */
	robustDelta: number | null;
	/** True when trimming outliers materially changed the saving (by more than a
	 * robust standard error) — the rule's measured cost is unstable / tail-heavy.
	 * When set, the verdict deliberately stays on the *mean* (which keeps the tail
	 * cost) rather than the optimistic robust estimate, so a rule that occasionally
	 * blows up cannot be promoted by trimming its worst runs away. */
	tailRisk: boolean;
	/** True when some task completed at a lower *rate* with the rule than without
	 * it. Savings means use completed runs only, so dropped failures flatter the
	 * mean (survivorship bias). Report-only — never a gate input; a full
	 * per-task failure is already the regression eviction. */
	completionDrop: boolean;
	/** True when a baseline-completed task's with-side is missing or consists
	 * only of zero-token environment failures (quota death, API outage). The
	 * measurement says nothing about the rule; no verdict may be finalized
	 * from it — callers must abort instead of deciding. */
	environmentFailure: boolean;
}

/** Robust (outlier-trimmed) view of the same measurement — reporting only. */
interface Robustness {
	robustDelta: number | null;
	tailRisk: boolean;
}

/**
 * The verdict uses the *mean* and the *raw* within-task SE. We deliberately do
 * NOT promote on the robust (outlier-trimmed) SE: the calibration harness
 * showed that the trimmed SE is over-confident and *raises* the false-positive
 * rate (a zero-effect rule whose blow-ups are trimmed away looks decisively
 * cheap). Robust aggregation is therefore a *reporting/flag* only — the
 * raw-SE verdict stays correctly calibrated. Tail risk means trimming
 * materially moved the saving: the rule's measured cost is unstable.
 */
function assessRobustness(
	robustPairs: SidePair[],
	weights: number[],
	meanDelta: number,
	rawSE: number | null,
): Robustness {
	const robustSE = withinTaskSE(robustPairs, weights);
	// Robust location weighted identically to the mean, so tail-risk compares
	// like with like (weighted mean vs weighted robust mean).
	const robustMean = weightedMean(
		robustPairs.map((p) => mean(p.without) - mean(p.with)),
		weights,
	);
	return {
		robustDelta: robustSE === null ? null : Math.round(robustMean),
		tailRisk:
			rawSE !== null &&
			robustSE !== null &&
			Math.abs(meanDelta - robustMean) > robustSE,
	};
}

/** Standard error of the weighted mean saving from the BETWEEN-task spread —
 * the runs=1 fallback, where no run-to-run estimate exists. Reliability
 * (frequency) weights: the unbiased weighted variance divides by
 * (Σw - Σw²/Σw), and the SE of the weighted mean is sqrt(var_w · Σw²) / Σw.
 * With every wᵢ = 1 this reduces to var = Σ(sᵢ-mean)²/(k-1) and SE =
 * sqrt(var/k) — the legacy formula. */
function betweenTaskSE(
	comparisons: TaskComparison[],
	weights: number[],
	meanDelta: number,
): number {
	const sumW = sum(weights);
	const sumW2 = weights.reduce((acc, w) => acc + w ** 2, 0);
	const weightedSquares = comparisons.reduce(
		(acc, c) => acc + c.weight * (c.saving - meanDelta) ** 2,
		0,
	);
	const varW = weightedSquares / (sumW - sumW2 / sumW);
	return Math.sqrt(varW * sumW2) / sumW;
}

/** The standard error the verdict is judged against, which variance it came
 * from, and the confidence multiple to apply to it. */
interface ConfidenceBasis {
	standardError: number | null;
	basis: StandardErrorBasis | null;
	/** Effective confidence multiple. For a weighted suite the SE estimate loses
	 * effective degrees of freedom, so z is widened toward the unweighted gate's
	 * coverage (== confidenceZ() exactly when weights are uniform). See
	 * with/betweenTaskDofInflation. */
	z: number;
}

function confidenceBasis(
	comparisons: TaskComparison[],
	rawPairs: SidePair[],
	weights: number[],
	meanDelta: number,
	rawSE: number | null,
): ConfidenceBasis {
	const z = confidenceZ();
	if (rawSE !== null) {
		return {
			standardError: rawSE,
			basis: "within-task",
			z: z * withinTaskDofInflation(rawPairs, weights, z),
		};
	}
	// runs=1 everywhere: no run-to-run estimate exists. Fall back to the
	// between-task spread so confidence is never silently dropped — but that
	// spread needs at least two comparable tasks to exist at all.
	if (comparisons.length < 2) {
		return { standardError: null, basis: null, z };
	}
	return {
		standardError: betweenTaskSE(comparisons, weights, meanDelta),
		basis: "between-task",
		z: z * betweenTaskDofInflation(weights, z),
	};
}

/** The assessment of a measurement with nothing comparable in it: no delta, no
 * confidence, only the flags that explain why. */
function unmeasurable(set: ComparisonSet): DeltaAssessment {
	return {
		delta: null,
		regression: set.regression,
		standardError: null,
		standardErrorBasis: null,
		uncertain: false,
		robustDelta: null,
		tailRisk: false,
		completionDrop: set.completionDrop,
		environmentFailure: set.environmentFailure,
	};
}

/**
 * Variance-aware delta: alongside the point estimate, report whether the
 * verdict is within noise of the 2×rent threshold. LLM run-to-run variance is
 * the dominant error source at small effect sizes.
 *
 * The standard error is the *propagated within-task* error
 *   Var(mean saving) = (1/K²) · Σᵢ [ s²_without,i/n_without,i + s²_with,i/n_with,i ]
 * — the right estimand for a frozen golden suite, where the tasks are the whole
 * population (their differing savings are fixed offsets, not sampling error) and
 * the only randomness is run-to-run noise. Critically, this SE shrinks as more
 * runs are added, so the run-count lever actually tightens confidence. When no
 * task has ≥2 completed runs per side (runs=1), it falls back to the legacy
 * between-task spread so the uncertainty flag is never silently lost.
 */
export function assessDelta(
	without: TaskSummary[],
	withRule: TaskSummary[],
	contextCost: number,
): DeltaAssessment {
	const set = perTaskComparisons(without, withRule);
	const { comparisons, regression } = set;
	if (comparisons.length === 0) return unmeasurable(set);

	const weights = comparisons.map((c) => c.weight);
	const meanDelta = weightedMean(
		comparisons.map((c) => c.saving),
		weights,
	);

	const rawPairs: SidePair[] = comparisons.map((c) => ({
		without: c.withoutTokens,
		with: c.withTokens,
	}));
	const robustPairs: SidePair[] = comparisons.map((c) => ({
		without: filterOutliers(c.withoutTokens),
		with: filterOutliers(c.withTokens),
	}));
	const rawSE = withinTaskSE(rawPairs, weights);
	const { robustDelta, tailRisk } = assessRobustness(
		robustPairs,
		weights,
		meanDelta,
		rawSE,
	);
	const { standardError, basis, z } = confidenceBasis(
		comparisons,
		rawPairs,
		weights,
		meanDelta,
		rawSE,
	);

	const threshold = 2 * effectiveRent(contextCost);
	const uncertain =
		!regression &&
		standardError !== null &&
		Math.abs(meanDelta - threshold) < z * standardError;
	return {
		delta: Math.round(meanDelta),
		regression,
		standardError,
		standardErrorBasis: basis,
		uncertain,
		robustDelta,
		tailRisk,
		completionDrop: set.completionDrop,
		environmentFailure: set.environmentFailure,
	};
}

// ---------------------------------------------------------------------------
// Top-up allocation
// ---------------------------------------------------------------------------

/** One task as a Neyman allocation stratum: how noisy it is, how much of the
 * suite it stands for, and how many runs it already has. */
interface Stratum {
	taskId: string;
	variance: number;
	weight: number;
	n: number;
	alloc: number;
}

/**
 * Variance-proportional (Neyman) allocation of a fixed top-up run budget across
 * the measured side's tasks. The weighted SE is `sqrt( Σᵢ wᵢ²·s²ᵢ/nᵢ ) / Σwᵢ`;
 * one extra run on task i cuts its term by `wᵢ²·s²ᵢ/(nᵢ(nᵢ+1))`, so greedily
 * handing each run to the task with the largest such marginal minimizes the SE
 * for the budget. This pours runs into the few high-variance (and high-weight)
 * tasks that dominate the error bar instead of re-running the whole suite
 * uniformly. With every wᵢ = 1 the allocation is identical to the unweighted one.
 *
 * Returns null — meaning "fall back to a uniform full top-up pass" — when no
 * within-task variance is estimable (every task has <2 runs, i.e. runs=1), since
 * there is then no variance signal to allocate against.
 */
export function allocateTopUpRuns(
	reference: TaskSummary[],
	measured: TaskSummary[],
	budget: number,
): Map<string, number> | null {
	const measuredById = new Map(measured.map((s) => [s.taskId, s]));
	const strata: Stratum[] = [];
	const measuredVectors: number[][] = [];
	for (const base of reference) {
		if (!base.results.some((r) => r.completed)) continue;
		const tokens = completedTokens(measuredById.get(base.taskId));
		if (tokens.length === 0) continue; // regression / not comparable
		measuredVectors.push(tokens);
		strata.push({
			taskId: base.taskId,
			variance: 0,
			// Weight from the reference summary — the suite composition the SE is
			// defined against (matches the estimator's baseline-side weighting).
			weight: base.weight,
			n: tokens.length,
			alloc: 0,
		});
	}
	const pooled = pooledVariance(measuredVectors);
	if (pooled === null || strata.length === 0 || budget <= 0) return null;
	for (const [i, stratum] of strata.entries()) {
		stratum.variance = sampleVariance(measuredVectors[i] ?? []) ?? pooled;
	}

	for (let spent = 0; spent < budget; spent++) {
		const best = neediestStratum(strata);
		if (!best) break; // every task perfectly stable — nothing to gain
		best.n++;
		best.alloc++;
	}

	const allocation = new Map<string, number>();
	for (const s of strata) if (s.alloc > 0) allocation.set(s.taskId, s.alloc);
	return allocation.size > 0 ? allocation : null;
}

/** The task whose next run buys the largest cut in the weighted SE, or null
 * when no task has variance left to shrink. The weighted SE term for task i is
 * wᵢ²·s²ᵢ/nᵢ, so one extra run cuts it by wᵢ²·s²ᵢ/(nᵢ(nᵢ+1)); greedy on that
 * marginal minimizes the WEIGHTED SE for the budget. wᵢ = 1 recovers the old
 * allocation exactly. */
function neediestStratum(strata: Stratum[]): Stratum | null {
	let best: Stratum | null = null;
	let bestMarginal = 0;
	for (const s of strata) {
		const marginal = (s.weight ** 2 * s.variance) / (s.n * (s.n + 1));
		if (marginal > bestMarginal) {
			bestMarginal = marginal;
			best = s;
		}
	}
	return best;
}

/** Combine two measurement passes of the same configuration: pool the raw
 * results per task and re-summarize. */
export function mergeSummaries(
	first: TaskSummary[],
	second: TaskSummary[],
): TaskSummary[] {
	const secondById = new Map(second.map((s) => [s.taskId, s]));
	return first.map((summary) => {
		const extra = secondById.get(summary.taskId);
		if (!extra) return summary;
		return summarizeTask(
			summary.taskId,
			[...summary.results, ...extra.results],
			summary.weight,
		);
	});
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Per-task run allocation for a Neyman top-up: taskId → number of extra runs
 * to spend on that task. Absent tasks get none. */
export type RunAllocation = ReadonlyMap<string, number>;

/** Runs the golden suite under an explicit rule set; injected so unit tests
 * can fake measurements. The real one wraps bench.runSuite. When `allocation`
 * is given, only those tasks run, each for its allocated number of runs (the
 * variance-proportional top-up); otherwise the full suite runs at the default
 * run count. */
export type SuiteRunner = (
	rules: RuleRow[],
	label: string,
	recordBaselines: boolean,
	allocation?: RunAllocation,
) => TaskSummary[];

interface Decision {
	rule: RuleRow;
	kind: DecisionKind;
	delta: number | null;
	regression: boolean;
	status: RuleStatus;
	/** True when the verdict was within one standard error of flipping
	 * after all measurements (decided at low confidence). */
	uncertain: boolean;
	/** True when an extra measurement pass was spent on this decision. */
	toppedUp: boolean;
	/** True when the rule's measured cost was tail-heavy (outlier runs materially
	 * moved the saving) — surfaced so a human can see the savings are unstable. */
	tailRisk: boolean;
	/** True when some task completed at a lower rate with the rule than without —
	 * the completed-runs-only savings mean may be flattered by dropped failures.
	 * Report-only. */
	completionDrop: boolean;
	/** True when this decision put the rule on probation instead of evicting it:
	 * a re-audit measured sub-threshold (first strike), the rule is retained, and
	 * a second consecutive sub-threshold re-audit will evict. */
	probation: boolean;
}

/** Details of an invocation-stopping environment failure: which rule was
 * being measured when the pass died, and how dead the pass was. */
export interface EnvironmentAbort {
	ruleId: number;
	kind: DecisionKind;
	/** The measurement pass that died. */
	label: string;
	/** Zero-token failed runs in that pass. */
	envFailed: number;
	/** Runs observed in that pass. */
	total: number;
}

export interface SelectionReport {
	agent: string;
	decisions: Decision[];
	activeBodies: string[];
	rulesetVersion: number | null;
	/** Set when the invocation stopped on an environment failure (quota death,
	 * API outage): the rule being measured was NOT judged — no verdict, no
	 * receipt, no probation strike — and remains queued for the next
	 * invocation. Decisions made before the abort stand. */
	aborted: EnvironmentAbort | null;
}

export interface SelectOptions {
	/** Extra measurement passes allowed per decision when the verdict is
	 * within one standard error of flipping. Bounded cost: each top-up is
	 * one more suite invocation of the measured configuration. */
	topUpBudget?: number;
	/** Force the top-up to re-run the FULL suite uniformly instead of the
	 * Neyman variance-proportional allocation. Same token budget, spent
	 * evenly — the control arm for benchmarking the allocation strategy
	 * (deferred from v0.24.0; see DECISIONS.md). */
	uniformTopUp?: boolean;
	/** Recorded into each rule receipt for provenance: the model the suite ran
	 * under and a hash of the golden suite it was measured against. */
	measuredModel?: string | null;
	fixtureHash?: string | null;
}

interface SideAggregate {
	/** Completed runs on this side. */
	runs: number;
	tokens: number;
	toolCalls: number;
	fileRereads: number;
	/** Tasks with at least one completed run. */
	tasksPassed: number;
}

/** Mean token/activity profile over the completed runs of one configuration —
 * the raw material for the quality axis of a rule receipt. */
function aggregateSide(summaries: TaskSummary[]): SideAggregate {
	const completed = summaries
		.flatMap((s) => s.results)
		.filter((r) => r.completed);
	const meanOf = (xs: number[]): number =>
		xs.length === 0 ? 0 : Math.round(mean(xs));
	return {
		runs: completed.length,
		tokens: meanOf(completed.map((r) => r.tokens)),
		toolCalls: meanOf(completed.map((r) => r.toolCalls ?? 0)),
		fileRereads: meanOf(completed.map((r) => r.fileRereads ?? 0)),
		tasksPassed: summaries.filter((s) => s.results.some((r) => r.completed))
			.length,
	};
}

/** Which side of the comparison the topped-up `measure` pass produces: the
 * with-rule configuration (candidate promotion) or the without-rule one
 * (re-audit, where the baseline already carries the rule). Replaces the old
 * boolean `invert` — it decides both the delta's orientation and which
 * aggregate is the "with" side of the receipt. */
type MeasuredSide = "with-rule" | "without-rule";

/**
 * How one rule is measured and judged. The only differences between candidate
 * promotion, a compression swap, and a re-audit are captured here: which
 * configuration is measured against which reference, which side the measured
 * pass is, and whether an uncertain verdict evicts (candidates) or keeps
 * (re-audits).
 */
interface MeasurementPlan {
	rule: RuleRow;
	kind: DecisionKind;
	/** The reference (unchanged) configuration; memoized, so it is benched at
	 * most once per invocation and never at all if nothing needs it. */
	reference: () => TaskSummary[];
	measure: (suffix: string, allocation?: RunAllocation) => TaskSummary[];
	measuredSide: MeasuredSide;
	evictWhenUncertain: boolean;
	reasonPrefix: string;
}

/** The invocation-wide context every decision writes into. */
interface SelectionRun {
	db: WardenDb;
	agent: string;
	options: SelectOptions;
	topUpBudget: number;
	uniformTopUp: boolean;
	/** The injected runner wrapped in the per-pass environment-failure guard. */
	measureSuite: SuiteRunner;
}

/** Lazily run a measurement pass at most once, and not at all when no decision
 * asks for it — an invocation whose only candidates are compression swaps
 * (which measure against their own reduced reference) never pays for an unused
 * baseline pass. */
function lazyPass(run: () => TaskSummary[]): () => TaskSummary[] {
	let cache: TaskSummary[] | undefined;
	return () => {
		cache ??= run();
		return cache;
	};
}

/**
 * Wrap a runner so every measurement pass — baseline, swap reference,
 * candidate, audit, top-up — is checked the moment it is produced: a pass that
 * is majority zero-token failures (quota death) cannot support any verdict, and
 * the check must be per-pass, never post-merge (a contaminated top-up merged
 * into a clean first pass dilutes below any threshold; that is exactly how
 * burn 1 finalized a garbage verdict, FINDINGS.md 2026-07).
 */
function guardEnvironment(agent: string, runner: SuiteRunner): SuiteRunner {
	return (rules, label, recordBaselines, allocation) => {
		const pass = runner(rules, label, recordBaselines, allocation);
		const { envFailed, total, tripped } = passEnvironmentFailure(pass);
		if (tripped) {
			throw new EnvironmentFailureError({
				agent,
				label,
				envFailed,
				total,
				streak: null,
				partial: pass,
			});
		}
		return pass;
	};
}

interface MeasuredComparison {
	assessment: DeltaAssessment;
	toppedUp: boolean;
	measured: TaskSummary[];
}

/** Measure the plan's configuration against its reference, topping up the
 * measured side when the verdict is within noise of the threshold. */
function measureWithTopUp(
	run: SelectionRun,
	plan: MeasurementPlan,
): MeasuredComparison {
	let measured = plan.measure("");
	const assess = (): DeltaAssessment =>
		plan.measuredSide === "without-rule"
			? assessDelta(measured, plan.reference(), plan.rule.context_cost)
			: assessDelta(plan.reference(), measured, plan.rule.context_cost);
	const assessment = assess();
	if (!assessment.uncertain || run.topUpBudget <= 0) {
		return { assessment, toppedUp: false, measured };
	}
	// Spend a top-up pass worth of runs (one full duplicate of the measured
	// side), but place them by variance: Neyman allocation pours runs into the
	// high-variance tasks that dominate the SE rather than re-running every
	// task. `measured` is always the side being topped up (the candidate's
	// with-rule side, or the re-audit's without side).
	const budget = measured.reduce((total, s) => total + s.results.length, 0);
	// --uniform-top-up: spend the same budget as one full uniform suite pass
	// instead of pouring it into high-variance tasks (the control arm when
	// benchmarking the allocation strategy itself).
	const allocation = run.uniformTopUp
		? null
		: allocateTopUpRuns(plan.reference(), measured, budget);
	const extra = allocation
		? plan.measure("-topup", allocation)
		: plan.measure("-topup"); // runs=1: no variance signal — uniform fallback
	measured = mergeSummaries(measured, extra);
	return { assessment: assess(), toppedUp: true, measured };
}

/**
 * A pass can slip past the per-pass majority guard yet still leave a task with
 * only zero-token environment failures on one side — which the old code misread
 * as a rule regression and evicted on. No verdict may be finalized from an
 * environmentally dead measurement, so this is thrown BEFORE any verdict,
 * probation strike, rule update or receipt: an abort structurally cannot
 * persist anything.
 */
function deadMeasurementError(
	agent: string,
	plan: MeasurementPlan,
	measured: TaskSummary[],
): EnvironmentFailureError {
	const { envFailed, total } = passEnvironmentFailure(measured);
	return new EnvironmentFailureError({
		agent,
		label: `${plan.kind} measurement of rule ${plan.rule.id}`,
		envFailed,
		total,
		streak: null,
		partial: measured,
	});
}

interface ProbationOutcome extends ReasonedVerdict {
	probation: boolean;
	/** Pending write to `rules.probation`: true = record a strike, false = clear
	 * one, null = leave it alone. Returned rather than written so the policy is
	 * pure and the write can land inside the verdict transaction. */
	probationWrite: boolean | null;
}

/**
 * Two-strike probation for re-audits. Admission demanded delta ≥ bar + z·SE,
 * but a point-estimate re-audit retention test churns real earners by
 * regression to the mean (a rule earning exactly the bar fails ~half its
 * re-audits; even a strong earner fails whenever the draw lands a couple of SE
 * low). Keep-when-uncertain is no fix — rent << SE, so a dead rule is always
 * "uncertain" and would never leave. Instead: the first sub-threshold re-audit
 * puts the rule on probation (kept, flagged); a second consecutive one evicts;
 * a passing re-audit clears the strike. A regression still evicts immediately
 * (safety invariant).
 */
function applyProbationPolicy(
	plan: MeasurementPlan,
	regression: boolean,
	base: ReasonedVerdict,
): ProbationOutcome {
	const { rule } = plan;
	if (plan.kind !== "re-audit" || regression) {
		return { ...base, probation: false, probationWrite: null };
	}
	if (base.status === "evicted" && rule.probation === 0) {
		return {
			status: "active",
			reason: `probation (strike 1 of 2): ${base.reason} — retained; a second consecutive sub-threshold re-audit evicts`,
			probation: true,
			probationWrite: true,
		};
	}
	if (base.status === "evicted") {
		return {
			status: base.status,
			reason: `second consecutive sub-threshold re-audit: ${base.reason}`,
			probation: false,
			probationWrite: null,
		};
	}
	return {
		...base,
		probation: false,
		probationWrite: rule.probation !== 0 ? false : null,
	};
}

/** Everything the persistence step needs about a finished measurement. Both
 * summary sides are passed in already measured: the write runs inside a
 * transaction, so nothing here may trigger a benchmark pass. */
interface DecisionRecord {
	assessment: DeltaAssessment;
	/** The measured (topped-up) side. */
	measured: TaskSummary[];
	/** The reference side, already benched by the assessment above. */
	reference: TaskSummary[];
	decidedAt: string;
	status: RuleStatus;
	reason: string;
	probationWrite: boolean | null;
}

/** The verdict is unchanged by this; the receipt is an additive snapshot.
 * `measured` is the with-rule side for a candidate (rule added) and the
 * without-rule side for a re-audit (rule removed), so both are mapped onto a
 * stable with/without frame for the quality axis. */
function recordDecisionReceipt(
	run: SelectionRun,
	plan: MeasurementPlan,
	outcome: DecisionRecord,
): void {
	const reference = outcome.reference;
	const measuredIsWithRule = plan.measuredSide === "with-rule";
	const withSide = aggregateSide(
		measuredIsWithRule ? outcome.measured : reference,
	);
	const withoutSide = aggregateSide(
		measuredIsWithRule ? reference : outcome.measured,
	);
	const { standardError, delta, regression } = outcome.assessment;
	recordReceipt(run.db, {
		ruleId: plan.rule.id,
		agent: run.agent,
		decidedAt: outcome.decidedAt,
		status: outcome.status,
		kind: plan.kind,
		reason: outcome.reason,
		model: run.options.measuredModel ?? null,
		fixtureHash: run.options.fixtureHash ?? null,
		runs: Math.max(withSide.runs, withoutSide.runs),
		delta,
		contextCost: plan.rule.context_cost,
		standardError: standardError === null ? null : Math.round(standardError),
		regression,
		withTokens: withSide.tokens,
		withoutTokens: withoutSide.tokens,
		withToolCalls: withSide.toolCalls,
		withoutToolCalls: withoutSide.toolCalls,
		withFileRereads: withSide.fileRereads,
		withoutFileRereads: withoutSide.fileRereads,
		tasksTotal: reference.length,
		tasksPassedWith: withSide.tasksPassed,
		tasksPassedWithout: withoutSide.tasksPassed,
	});
}

/**
 * A verdict is ONE fact about a rule, spread over three tables: its probation
 * flag, its status/delta/reason, and its receipt. Written separately, a crash
 * (or a quota-killed process) between them leaves a rule decided with no
 * receipt, or a probation strike recorded against a verdict that never landed —
 * exactly the inconsistency the receipt ledger exists to make visible. db.ts
 * deliberately ships each as a clean single-statement primitive, so the
 * transaction boundary belongs here, at the only call site that knows the three
 * are one unit.
 *
 * IMMEDIATE so the write lock is taken up front instead of being upgraded
 * mid-transaction (the DB is WAL and a second warden process may be writing).
 * The write order is unchanged: probation, then verdict, then receipt.
 */
function persistDecision(
	run: SelectionRun,
	plan: MeasurementPlan,
	record: DecisionRecord,
): void {
	run.db
		.transaction(() => {
			if (record.probationWrite !== null) {
				setRuleProbation(run.db, plan.rule.id, record.probationWrite);
			}
			decideRule(
				run.db,
				plan.rule.id,
				record.status,
				record.assessment.delta,
				record.reason,
				record.decidedAt,
			);
			recordDecisionReceipt(run, plan, record);
		})
		.immediate();
}

/** Measure one rule against its reference, decide its fate, persist the
 * verdict and its receipt. Throws EnvironmentFailureError instead of deciding
 * when the measurement died environmentally. */
function runDecision(run: SelectionRun, plan: MeasurementPlan): Decision {
	const { assessment, toppedUp, measured } = measureWithTopUp(run, plan);
	if (assessment.environmentFailure) {
		throw deadMeasurementError(run.agent, plan, measured);
	}
	const { delta, regression, uncertain, tailRisk, completionDrop } = assessment;
	const { status, reason, probation, probationWrite } = applyProbationPolicy(
		plan,
		regression,
		finalizeVerdict({
			delta,
			contextCost: plan.rule.context_cost,
			regression,
			uncertain,
			toppedUp,
			evictWhenUncertain: plan.evictWhenUncertain,
		}),
	);
	persistDecision(run, plan, {
		assessment,
		measured,
		// Memoized: the assessment above already benched it. Resolved out here so
		// the transaction can never wrap a benchmark pass.
		reference: plan.reference(),
		decidedAt: new Date().toISOString(),
		status,
		reason: plan.reasonPrefix + reason,
		probationWrite,
	});

	return {
		rule: plan.rule,
		kind: plan.kind,
		delta,
		regression,
		status,
		uncertain,
		toppedUp,
		tailRisk,
		completionDrop,
		probation,
	};
}

type DecisionOutcome =
	| { outcome: "decided"; decision: Decision }
	| { outcome: "aborted"; abort: EnvironmentAbort };

/** runDecision(), but an environment failure yields an abort record instead of
 * a verdict. Any other error propagates unchanged. */
function tryDecide(run: SelectionRun, plan: MeasurementPlan): DecisionOutcome {
	try {
		return { outcome: "decided", decision: runDecision(run, plan) };
	} catch (err) {
		if (err instanceof EnvironmentFailureError) {
			return {
				outcome: "aborted",
				abort: {
					ruleId: plan.rule.id,
					kind: plan.kind,
					label: err.info.label,
					envFailed: err.info.envFailed,
					total: err.info.total,
				},
			};
		}
		throw err;
	}
}

/** Ordinary candidate promotion: measured ON TOP of the active set. Promotion
 * requires confidence — an uncertain verdict after top-up evicts rather than
 * activates (don't pay rent on a rule we can't show clears 2× rent). */
function promotionPlan(
	run: SelectionRun,
	candidate: RuleRow,
	activeSet: RuleRow[],
	baseline: () => TaskSummary[],
): MeasurementPlan {
	return {
		rule: candidate,
		kind: "candidate",
		reference: baseline,
		measure: (suffix, allocation) =>
			run.measureSuite(
				[...activeSet, candidate],
				`candidate-${candidate.id}${suffix}`,
				false,
				allocation,
			),
		measuredSide: "with-rule",
		evictWhenUncertain: true,
		reasonPrefix: "",
	};
}

/**
 * Compression swap: a candidate carrying `replaces` proposes to stand in for an
 * active rule that says the same thing in more characters. Measuring it ON TOP
 * of that original would pin its marginal delta at ~0 (the agent already
 * follows the advice) and make the A/B unwinnable by construction, so the swap
 * is measured against the active set MINUS the original: same 2x-rent bar,
 * standalone. The original is untouched this pass — once the variant is active,
 * the original is redundant and exits via its own re-audits (two-strike).
 */
function swapPlan(
	run: SelectionRun,
	candidate: RuleRow,
	replaced: RuleRow,
	activeSet: RuleRow[],
): MeasurementPlan {
	const reduced = activeSet.filter((rule) => rule.id !== replaced.id);
	return {
		rule: candidate,
		kind: "candidate",
		reference: lazyPass(() =>
			run.measureSuite(reduced, `swap-base-${candidate.id}`, false),
		),
		measure: (suffix, allocation) =>
			run.measureSuite(
				[...reduced, candidate],
				`candidate-${candidate.id}${suffix}`,
				false,
				allocation,
			),
		measuredSide: "with-rule",
		evictWhenUncertain: true,
		reasonPrefix: `swap for rule ${replaced.id}: `,
	};
}

function planForCandidate(
	run: SelectionRun,
	candidate: RuleRow,
	activeSet: RuleRow[],
	baseline: () => TaskSummary[],
): MeasurementPlan {
	const replaced =
		candidate.replaces === null
			? undefined
			: activeSet.find((rule) => rule.id === candidate.replaces);
	// A `replaces` pointing at a rule that is no longer active has nothing to
	// swap against: fall back to the ordinary on-top measurement.
	return replaced === undefined
		? promotionPlan(run, candidate, activeSet, baseline)
		: swapPlan(run, candidate, replaced, activeSet);
}

/** Re-audit of an active rule. Its current worth is cost-without minus
 * cost-with (the baseline includes it), so the measured (toppable) side is the
 * without-configuration and the delta is oriented the other way. Re-audit uses
 * the gentler point-estimate test: an established rule is de-activated only on
 * evidence it has stopped earning, not when a noisy re-measure is merely
 * inconclusive. */
function reAuditPlan(
	run: SelectionRun,
	target: RuleRow,
	activeSet: RuleRow[],
	baseline: () => TaskSummary[],
): MeasurementPlan {
	const withoutIt = activeSet.filter((rule) => rule.id !== target.id);
	return {
		rule: target,
		kind: "re-audit",
		reference: baseline,
		measure: (suffix, allocation) =>
			run.measureSuite(
				withoutIt,
				`audit-${target.id}${suffix}`,
				false,
				allocation,
			),
		measuredSide: "without-rule",
		evictWhenUncertain: false,
		reasonPrefix: "re-audit: ",
	};
}

export function selectForAgent(
	db: WardenDb,
	agent: string,
	runner: SuiteRunner,
	options: SelectOptions = {},
): SelectionReport {
	// Before anything else: repair memory left inconsistent with the DB by an
	// invocation that died between a verdict and the end-of-run compile.
	const healedVersion = healMemoryDrift(db, agent);
	const candidates = listCandidates(db, agent, MAX_CANDIDATES_PER_INVOCATION);
	// Captured before any decision so a rule activated this invocation is
	// not immediately re-audited.
	const auditTarget = oldestDecidedActiveRule(db, agent);
	const decisions: Decision[] = [];
	let aborted: EnvironmentAbort | null = null;

	if (candidates.length > 0 || auditTarget !== undefined) {
		const activeSet = getActiveRules(db, agent);
		const run: SelectionRun = {
			db,
			agent,
			options,
			topUpBudget: options.topUpBudget ?? 1,
			uniformTopUp: options.uniformTopUp ?? false,
			measureSuite: guardEnvironment(agent, runner),
		};
		const baseline = lazyPass(() =>
			run.measureSuite(activeSet, "active-set", true),
		);

		for (const candidate of candidates) {
			const result = tryDecide(
				run,
				planForCandidate(run, candidate, activeSet, baseline),
			);
			// An environment failure means every further run this invocation would
			// die the same way — stop measuring; remaining candidates stay queued
			// for the next invocation.
			if (result.outcome === "aborted") {
				aborted = result.abort;
				break;
			}
			decisions.push(result.decision);
		}

		if (auditTarget !== undefined && aborted === null) {
			const result = tryDecide(
				run,
				reAuditPlan(run, auditTarget, activeSet, baseline),
			);
			if (result.outcome === "aborted") aborted = result.abort;
			else decisions.push(result.decision);
		}
	}

	const finalActive = getActiveRules(db, agent);
	// A drift repair is also a compile of this invocation, so it is reported as
	// the ruleset version when no decision produced a later one.
	const rulesetVersion =
		decisions.length > 0 ? compileActiveMemory(db, agent) : healedVersion;

	return {
		agent,
		decisions,
		activeBodies: finalActive.map((rule) => rule.body),
		rulesetVersion,
		aborted,
	};
}

interface FinalVerdictInput {
	delta: number | null;
	contextCost: number;
	regression: boolean;
	uncertain: boolean;
	toppedUp: boolean;
	/** Candidate promotion: an uncertain verdict evicts. Re-audit: it keeps. */
	evictWhenUncertain: boolean;
}

/**
 * Final keep/evict verdict, variance-aware. A rule is injected into every
 * future session and pays its context rent each time, so promotion should
 * require *confidence* that it earns ≥2× that rent — not a point estimate
 * that merely lands above the line. When `evictWhenUncertain` (candidate
 * promotion) and the savings remain within one standard error of the
 * threshold after the top-up budget is spent (`uncertain`), a winner cannot
 * be distinguished from a sub-threshold rule, so we do NOT start paying the
 * rent — evict. Re-audit of an already-earning rule uses the gentler
 * point-estimate test (it is only de-activated on evidence it has *stopped*
 * earning), so one noisy re-audit does not churn out a good rule.
 */
function finalizeVerdict(input: FinalVerdictInput): ReasonedVerdict {
	const { delta, uncertain, toppedUp } = input;
	const base = verdictWithReason(delta, input.contextCost, input.regression);
	if (base.status === "active" && uncertain && input.evictWhenUncertain) {
		const tu = toppedUp ? " after top-up" : "";
		return {
			status: "evicted",
			reason: `uncertain${tu}: measured savings (${delta}) within one standard error of the 2× rent threshold — not confidently earning`,
		};
	}
	if (!toppedUp && !uncertain) return base;
	const notes: string[] = [];
	if (toppedUp) notes.push("after variance top-up");
	if (uncertain) notes.push("low confidence: within one SE of flipping");
	return {
		status: base.status,
		reason: `${base.reason} (${notes.join("; ")})`,
	};
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface SelectArgs {
	agent: string;
	runs: number;
	topUp: number;
	uniformTopUp: boolean;
}

export function parseSelectArgs(argv: string[]): SelectArgs {
	// Default 3 (not 2): tighter standard error against the >25% golden-suite
	// variance seen in real burns, so the selector can distinguish a genuine
	// small saving from noise instead of evicting it as uncertain.
	const args: SelectArgs = {
		agent: "",
		runs: 3,
		topUp: 1,
		uniformTopUp: false,
	};
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--agent":
				args.agent = argv[i + 1] ?? "";
				i++;
				break;
			case "--runs":
				args.runs = Number(argv[i + 1]);
				i++;
				break;
			case "--top-up":
				args.topUp = Number(argv[i + 1]);
				i++;
				break;
			case "--uniform-top-up":
				args.uniformTopUp = true;
				break;
			default:
				throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	assertKnownAgent(args.agent);
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isInteger(args.topUp) || args.topUp < 0) {
		throw new Error("--top-up must be a non-negative integer");
	}
	return args;
}

/** Which rule configuration the recorded runs belong to, so status can
 * separate active-set golden runs from measurement runs. */
function runConfigFor(label: string, recordBaselines: boolean): RunConfig {
	if (recordBaselines) return "active";
	return label.startsWith("audit-") ? "audit" : "candidate";
}

/** Neyman top-up: run only the allocated tasks, each for its own run count. */
function runAllocatedTasks(
	db: WardenDb,
	agent: string,
	tasks: GoldenTask[],
	allocation: RunAllocation,
	pass: { rules: RuleRow[]; rulesetVersion: number; label: string },
): TaskSummary[] {
	const summaries: TaskSummary[] = [];
	for (const task of tasks) {
		const extraRuns = allocation.get(task.id);
		if (!extraRuns) continue;
		const [summary] = runSuite(db, agent, [task], {
			rules: pass.rules,
			runs: extraRuns,
			recordBaselines: false,
			rulesetVersion: pass.rulesetVersion,
			label: pass.label,
			config: runConfigFor(pass.label, false),
		});
		if (summary) summaries.push(summary);
	}
	return summaries;
}

/** The real SuiteRunner: bench.runSuite over the agent's golden tasks. */
function benchSuiteRunner(
	db: WardenDb,
	args: SelectArgs,
	tasks: GoldenTask[],
): SuiteRunner {
	return (rules, label, recordBaselines, allocation) => {
		const rulesetVersion = getRulesetVersion(db, args.agent);
		if (allocation) {
			return runAllocatedTasks(db, args.agent, tasks, allocation, {
				rules,
				rulesetVersion,
				label,
			});
		}
		return runSuite(db, args.agent, tasks, {
			rules,
			runs: args.runs,
			recordBaselines,
			rulesetVersion,
			label,
			config: runConfigFor(label, recordBaselines),
		});
	};
}

/** The advisory/warning suffixes on a decision line, in fixed order. */
function decisionFlags(decision: Decision, weightedSuite: boolean): string {
	const flags: string[] = [];
	if (decision.regression) flags.push("REGRESSION");
	if (decision.toppedUp) flags.push("topped-up");
	if (decision.uncertain) flags.push("LOW-CONFIDENCE");
	if (decision.tailRisk) flags.push("TAIL-RISK");
	if (decision.completionDrop) flags.push("COMPLETION-DROP");
	if (decision.probation) flags.push("PROBATION (strike 1 of 2)");
	if (weightedSuite) flags.push("WEIGHTED");
	return flags.map((flag) => `, ${flag}`).join("");
}

function decisionLine(
	decision: Decision,
	dollarsPerToken: number,
	weightedSuite: boolean,
): string {
	const dollars =
		decision.delta !== null
			? `, ≈$${(decision.delta * dollarsPerToken).toFixed(4)}/run advisory`
			: "";
	return (
		`  [${decision.kind}] rule ${decision.rule.id} → ${decision.status.toUpperCase()}` +
		` (delta=${decision.delta ?? "n/a"}, rent=${decision.rule.context_cost}${dollars}` +
		`${decisionFlags(decision, weightedSuite)}): "${decision.rule.body}"`
	);
}

function reportDecisions(
	db: WardenDb,
	agent: string,
	decisions: Decision[],
	weightedSuite: boolean,
): void {
	// Advisory dollar mapping: the agent's real-work token mix priced at the
	// measured model's rates. Reporting only — the keep/evict gate stays on
	// raw tokens (a dollar gate needs its own calibration proof first).
	const perToken = blendedDollarsPerToken(
		agentTokenMix(db, agent),
		priceFor(loadAgentDefinition(agent).model),
	);
	for (const decision of decisions) {
		console.log(decisionLine(decision, perToken, weightedSuite));
	}
	const weeklyDollars =
		decisions
			.filter((d) => d.status === "active" && (d.delta ?? 0) > 0)
			.reduce((total, d) => total + (d.delta as number), 0) *
		perToken *
		sessionsPerWeek();
	if (weeklyDollars > 0) {
		console.log(
			`Advisory dollars (never a gate input): the rules kept this pass earn ≈$${weeklyDollars.toFixed(2)}/week at ${sessionsPerWeek()} sessions/week.`,
		);
	}
}

function reportAbort(abort: EnvironmentAbort): void {
	console.log(
		`ABORTED: environment failure during ${abort.label} ` +
			`(${abort.envFailed} of ${abort.total} runs failed with ~0 tokens — quota exhausted?)`,
	);
	console.log(
		`Rule ${abort.ruleId} was NOT judged: no verdict or receipt was recorded` +
			(abort.kind === "candidate"
				? "; it remains queued as a candidate."
				: "; the active rule and its probation state are unchanged."),
	);
	console.log("Re-run /warden-select on a fresh quota window.");
	// Non-zero exit so callers/scripts see the abort; exitCode (not
	// process.exit) so the caller's finally still closes the DB.
	process.exitCode = 1;
}

export function main(args: SelectArgs): void {
	const db = openDb();
	try {
		const tasks: GoldenTask[] = loadGoldenTasks(args.agent);
		// Surfaced on every decision line when the suite is distribution-weighted,
		// so a weighted verdict is never mistaken for a plain one.
		const weightedSuite = tasks.some((t) => t.weight !== 1);

		console.log(
			`Selecting for agent=${args.agent} (runs=${args.runs} per config, top-up budget ${args.topUp})`,
		);
		const report = selectForAgent(
			db,
			args.agent,
			benchSuiteRunner(db, args, tasks),
			{
				topUpBudget: args.topUp,
				uniformTopUp: args.uniformTopUp,
				measuredModel: loadAgentDefinition(args.agent).model,
				fixtureHash: goldenSuiteHash(args.agent),
			},
		);

		if (report.decisions.length === 0 && report.aborted === null) {
			console.log("No candidates and no active rules to audit; nothing to do.");
			return;
		}
		reportDecisions(db, args.agent, report.decisions, weightedSuite);
		if (report.rulesetVersion !== null) {
			console.log(
				`Compiled ${report.activeBodies.length} active rule(s) → ${memoryFilePath(args.agent)}` +
					` (ruleset v${report.rulesetVersion})`,
			);
		}
		if (report.aborted !== null) reportAbort(report.aborted);
	} finally {
		db.close();
	}
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	assertPosixPlatform();
	main(parseSelectArgs(process.argv.slice(2)));
});
/* v8 ignore stop */
