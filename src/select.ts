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
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	assertPosixPlatform,
	compileMemoryMd,
	type GoldenTask,
	goldenSuiteHash,
	loadAgentDefinition,
	loadGoldenTasks,
	runSuite,
	summarizeTask,
	type TaskSummary,
} from "./bench.js";
import {
	bumpRulesetVersion,
	decideRule,
	getActiveRules,
	getRulesetVersion,
	listCandidates,
	oldestDecidedActiveRule,
	openDb,
	type RuleRow,
	recordReceipt,
	setRuleProbation,
	type WardenDb,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

const MAX_CANDIDATES_PER_INVOCATION = 3;

export interface VerdictInput {
	measuredDelta: number | null;
	contextCost: number;
}

/** Cache-write price relative to a base input token (Anthropic ~1.25×). A rule
 * re-enters the prompt at this price on the session after the ruleset changes
 * (a cache miss on the memory block), then at cache-read price thereafter. */
const CACHE_CREATE_MULTIPLIER = 1.25;

function sessionsPerWeek(): number {
	// A zero/negative/NaN override would invert or trivialize the inequality;
	// fall back to the default instead.
	const raw = Number(process.env.WARDEN_SESSIONS_PER_WEEK ?? 20);
	return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

/**
 * Confidence multiple on the standard error for the "uncertain" band. Default 2
 * (~95% one-sided): a candidate must clear the 2×-rent bar by ≥ 2 standard
 * errors to be promoted. The calibration harness (validation/calibration.ts)
 * showed the old 1-SE band gave a ~16% false-positive rate (keeping a zero-effect
 * rule); 2 SE drops that to ~2-3%. Lower it (toward 1) to trade precision for
 * power once you trust your benchmark's variance. Clamped to ≥ 1.
 */
function confidenceZ(): number {
	const raw = Number(process.env.WARDEN_CONFIDENCE_Z ?? 2);
	return Number.isFinite(raw) && raw >= 1 ? raw : 2;
}

/**
 * Effective per-session rent of carrying a rule, in tokens. Beyond the raw
 * context cost paid every session, a rule incurs a one-time cache re-prefill
 * each time the ruleset changes — the memory block misses the cache and is
 * re-created at ~1.25× input price. Amortized over a week of sessions
 * (assuming ≈one ruleset change per week) that adds `contextCost·1.25/sessions`
 * per session. This is deliberately conservative: it makes the 2× bar slightly
 * *harder*, never easier, and answers the "you bust the cache on every change"
 * critique by pricing the bust in rather than ignoring it.
 */
export function effectiveRent(contextCost: number): number {
	return (
		contextCost + (contextCost * CACHE_CREATE_MULTIPLIER) / sessionsPerWeek()
	);
}

/** Keep/evict inequality from the spec: a rule must save at least twice its
 * (cache-aware) context rent. SESSIONS_PER_WEEK cancels in the carry term but
 * is kept so the policy reads as the spec states it, and now also amortizes the
 * one-time cache re-prefill. */
export function verdict(rule: VerdictInput): "active" | "evicted" {
	if (rule.measuredDelta === null || rule.measuredDelta <= 0) return "evicted";
	return rule.measuredDelta >= 2 * effectiveRent(rule.contextCost)
		? "active"
		: "evicted";
}

export interface ReasonedVerdict {
	status: "active" | "evicted";
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
}

/** Per-task comparisons for tasks completed in both configurations
 * (invariant #3), plus the regression flag and the completion-drop flag. */
function perTaskComparisons(
	without: TaskSummary[],
	withRule: TaskSummary[],
): {
	comparisons: TaskComparison[];
	regression: boolean;
	completionDrop: boolean;
} {
	const withById = new Map(withRule.map((s) => [s.taskId, s]));
	const comparisons: TaskComparison[] = [];
	let regression = false;
	let completionDrop = false;
	for (const base of without) {
		const withoutTokens = base.results
			.filter((r) => r.completed)
			.map((r) => r.tokens);
		if (withoutTokens.length === 0) continue;
		const other = withById.get(base.taskId);
		const withTokens = (other?.results ?? [])
			.filter((r) => r.completed)
			.map((r) => r.tokens);
		if (!other || withTokens.length === 0) {
			regression = true;
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
		});
	}
	return { comparisons, regression, completionDrop };
}

/** Unbiased sample variance; null when fewer than two observations. */
function sampleVariance(xs: number[]): number | null {
	if (xs.length < 2) return null;
	const m = xs.reduce((a, b) => a + b, 0) / xs.length;
	return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
}

/** Degrees-of-freedom-weighted pooled variance across many run vectors —
 * borrowed when an individual task has too few runs to estimate its own
 * run-to-run noise (default runs=3 gives each task its own estimate; this is
 * the backstop at the n=2 edge). Null when no vector has ≥2 observations. */
function pooledVariance(vectors: number[][]): number | null {
	let sumSq = 0;
	let dof = 0;
	for (const xs of vectors) {
		if (xs.length < 2) continue;
		const m = xs.reduce((a, b) => a + b, 0) / xs.length;
		sumSq += xs.reduce((acc, x) => acc + (x - m) ** 2, 0);
		dof += xs.length - 1;
	}
	return dof > 0 ? sumSq / dof : null;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 0
		? ((s[mid - 1] as number) + (s[mid] as number)) / 2
		: (s[mid] as number);
}

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

interface SidePair {
	without: number[];
	with: number[];
}

/** Propagated within-task standard error of the mean saving:
 * `sqrt( (1/K²)·Σᵢ [s²_without,i/n_i + s²_with,i/n_i] )`. Null when no task has
 * ≥2 runs/side. */
function withinTaskSE(pairs: SidePair[]): number | null {
	const k = pairs.length;
	if (k === 0) return null;
	const pooledWithout = pooledVariance(pairs.map((p) => p.without));
	const pooledWith = pooledVariance(pairs.map((p) => p.with));
	if (pooledWithout === null || pooledWith === null) return null;
	let sumVar = 0;
	for (const p of pairs) {
		const vW = sampleVariance(p.without) ?? pooledWithout;
		const vR = sampleVariance(p.with) ?? pooledWith;
		sumVar += vW / p.without.length + vR / p.with.length;
	}
	return Math.sqrt(sumVar / k ** 2);
}

const mean = (xs: number[]): number =>
	xs.reduce((a, b) => a + b, 0) / xs.length;

export interface DeltaAssessment extends DeltaResult {
	/** Standard error of the saving. Propagated *within-task* run-to-run variance
	 * when ≥2 runs/side exist (the correct fixed-suite estimand — shrinks as
	 * 1/√runs); falls back to the between-task spread only when no within-task
	 * variance is estimable. Null with <2 comparable tasks. */
	standardError: number | null;
	/** Which variance the standard error is built from. "within-task" is the
	 * correct fixed-suite estimator; "between-task" is the legacy fallback at
	 * runs=1 — surfaced so a verdict's confidence basis is auditable. */
	standardErrorBasis: "within-task" | "between-task" | null;
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
	const { comparisons, regression, completionDrop } = perTaskComparisons(
		without,
		withRule,
	);
	if (comparisons.length === 0) {
		return {
			delta: null,
			regression,
			standardError: null,
			standardErrorBasis: null,
			uncertain: false,
			robustDelta: null,
			tailRisk: false,
			completionDrop,
		};
	}
	const savings = comparisons.map((c) => c.saving);
	const k = savings.length;
	const meanDelta = mean(savings);
	const delta = Math.round(meanDelta);

	// The verdict uses the *mean* and the *raw* within-task SE. We deliberately do
	// NOT promote on the robust (outlier-trimmed) SE: the calibration harness
	// showed that the trimmed SE is over-confident and *raises* the false-positive
	// rate (a zero-effect rule whose blow-ups are trimmed away looks decisively
	// cheap). Robust aggregation is therefore a *reporting/flag* only — the
	// raw-SE verdict stays correctly calibrated.
	const rawPairs: SidePair[] = comparisons.map((c) => ({
		without: c.withoutTokens,
		with: c.withTokens,
	}));
	const robustPairs: SidePair[] = comparisons.map((c) => ({
		without: filterOutliers(c.withoutTokens),
		with: filterOutliers(c.withTokens),
	}));
	const rawSE = withinTaskSE(rawPairs);
	const robustSE = withinTaskSE(robustPairs);
	const robustSavingsMean = mean(
		robustPairs.map((p) => mean(p.without) - mean(p.with)),
	);
	const robustDelta = robustSE === null ? null : Math.round(robustSavingsMean);
	// Tail-risk: trimming derailment outliers materially moves the saving — the
	// rule's measured cost is unstable. A warning for a human, not a gate input.
	const tailRisk =
		rawSE !== null &&
		robustSE !== null &&
		Math.abs(meanDelta - robustSavingsMean) > robustSE;

	let standardError: number | null = rawSE;
	let standardErrorBasis: "within-task" | "between-task" | null =
		rawSE !== null ? "within-task" : null;
	if (rawSE === null && k >= 2) {
		// runs=1 everywhere: no run-to-run estimate exists. Fall back to the
		// legacy between-task spread so confidence is never silently dropped.
		const variance =
			savings.reduce((acc, s) => acc + (s - meanDelta) ** 2, 0) / (k - 1);
		standardError = Math.sqrt(variance / k);
		standardErrorBasis = "between-task";
	}

	const threshold = 2 * effectiveRent(contextCost);
	const uncertain =
		!regression &&
		standardError !== null &&
		Math.abs(meanDelta - threshold) < confidenceZ() * standardError;
	return {
		delta,
		regression,
		standardError,
		standardErrorBasis,
		uncertain,
		robustDelta,
		tailRisk,
		completionDrop,
	};
}

/** Completed-run tokens for one task in a summary set. */
function completedTokens(summary: TaskSummary | undefined): number[] {
	return (summary?.results ?? [])
		.filter((r) => r.completed)
		.map((r) => r.tokens);
}

/**
 * Variance-proportional (Neyman) allocation of a fixed top-up run budget across
 * the measured side's tasks. The SE is `sqrt( (1/K²)·Σᵢ s²ᵢ/nᵢ )`; one extra run
 * on task i cuts its term by `s²ᵢ/(nᵢ(nᵢ+1))`, so greedily handing each run to
 * the task with the largest such marginal minimizes the SE for the budget. This
 * pours runs into the few high-variance tasks that dominate the error bar
 * instead of re-running the whole suite uniformly.
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
	type Stratum = { taskId: string; variance: number; n: number; alloc: number };
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
			n: tokens.length,
			alloc: 0,
		});
	}
	const pooled = pooledVariance(measuredVectors);
	if (pooled === null || strata.length === 0 || budget <= 0) return null;
	for (let i = 0; i < strata.length; i++) {
		const s = strata[i];
		if (s) s.variance = sampleVariance(measuredVectors[i] ?? []) ?? pooled;
	}

	for (let spent = 0; spent < budget; spent++) {
		let best: Stratum | null = null;
		let bestMarginal = 0;
		for (const s of strata) {
			const marginal = s.variance / (s.n * (s.n + 1));
			if (marginal > bestMarginal) {
				bestMarginal = marginal;
				best = s;
			}
		}
		if (!best) break; // every task perfectly stable — nothing to gain
		best.n++;
		best.alloc++;
	}

	const allocation = new Map<string, number>();
	for (const s of strata) if (s.alloc > 0) allocation.set(s.taskId, s.alloc);
	return allocation.size > 0 ? allocation : null;
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
		return summarizeTask(summary.taskId, [
			...summary.results,
			...extra.results,
		]);
	});
}

/** Where compiled agent memory lives. Overridable for tests so they never
 * touch the real ~/.claude/agent-memory. */
export function memoryFilePath(agent: string): string {
	const base =
		process.env.TOKEN_WARDEN_MEMORY_DIR ??
		join(homedir(), ".claude", "agent-memory");
	return join(base, agent, "MEMORY.md");
}

/** Recompile the agent's MEMORY.md from its current active rule set (including
 * protected rules) and bump the ruleset version. The single writer of agent
 * memory — shared by the selector and the protect command so the file is always
 * the wholesale, never-hand-edited artifact (invariant #2). */
export function compileActiveMemory(db: WardenDb, agent: string): number {
	const active = getActiveRules(db, agent);
	const memoryPath = memoryFilePath(agent);
	mkdirSync(dirname(memoryPath), { recursive: true });
	writeFileSync(memoryPath, compileMemoryMd(active));
	return bumpRulesetVersion(db, agent, new Date().toISOString());
}

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
	kind: "candidate" | "re-audit";
	delta: number | null;
	regression: boolean;
	status: "active" | "evicted";
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

export interface SelectionReport {
	agent: string;
	decisions: Decision[];
	activeBodies: string[];
	rulesetVersion: number | null;
}

export interface SelectOptions {
	/** Extra measurement passes allowed per decision when the verdict is
	 * within one standard error of flipping. Bounded cost: each top-up is
	 * one more suite invocation of the measured configuration. */
	topUpBudget?: number;
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
		xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
	return {
		runs: completed.length,
		tokens: meanOf(completed.map((r) => r.tokens)),
		toolCalls: meanOf(completed.map((r) => r.toolCalls ?? 0)),
		fileRereads: meanOf(completed.map((r) => r.fileRereads ?? 0)),
		tasksPassed: summaries.filter((s) => s.results.some((r) => r.completed))
			.length,
	};
}

export function selectForAgent(
	db: WardenDb,
	agent: string,
	runner: SuiteRunner,
	options: SelectOptions = {},
): SelectionReport {
	const topUpBudget = options.topUpBudget ?? 1;
	const candidates = listCandidates(db, agent, MAX_CANDIDATES_PER_INVOCATION);
	// Captured before any decision so a rule activated this invocation is
	// not immediately re-audited.
	const auditTarget = oldestDecidedActiveRule(db, agent);

	/** Measure `measured` vs `reference`, topping up the measured side when
	 * the verdict is within noise of the threshold. Used for candidates
	 * (reference = baseline) and re-audits (reference = without-rule). */
	function assessWithTopUp(
		reference: () => TaskSummary[],
		measure: (suffix: string, allocation?: RunAllocation) => TaskSummary[],
		contextCost: number,
		invert: boolean,
	): {
		assessment: DeltaAssessment;
		toppedUp: boolean;
		measured: TaskSummary[];
	} {
		let measured = measure("");
		const assess = () =>
			invert
				? assessDelta(measured, reference(), contextCost)
				: assessDelta(reference(), measured, contextCost);
		let assessment = assess();
		let toppedUp = false;
		if (assessment.uncertain && topUpBudget > 0) {
			// Spend a top-up pass worth of runs (one full duplicate of the measured
			// side), but place them by variance: Neyman allocation pours runs into
			// the high-variance tasks that dominate the SE rather than re-running
			// every task. `measured` is always the side being topped up (the
			// candidate's with-rule side, or the re-audit's without side).
			const budget = measured.reduce((sum, s) => sum + s.results.length, 0);
			const allocation = allocateTopUpRuns(reference(), measured, budget);
			const extra = allocation
				? measure("-topup", allocation)
				: measure("-topup"); // runs=1: no variance signal — uniform fallback
			measured = mergeSummaries(measured, extra);
			assessment = assess();
			toppedUp = true;
		}
		return { assessment, toppedUp, measured };
	}

	const decisions: Decision[] = [];
	if (candidates.length > 0 || auditTarget !== undefined) {
		const activeSet = getActiveRules(db, agent);
		const baseline = runner(activeSet, "active-set", true);

		/**
		 * Measure one rule against the active-set baseline, decide its fate,
		 * persist the verdict, and record the decision. The only differences
		 * between candidate promotion and re-audit are these parameters:
		 * which configuration is measured, whether the delta is inverted, and
		 * whether an uncertain verdict evicts (candidates) or keeps (re-audits).
		 */
		const decide = (params: {
			rule: RuleRow;
			kind: Decision["kind"];
			measure: (suffix: string, allocation?: RunAllocation) => TaskSummary[];
			invert: boolean;
			evictWhenUncertain: boolean;
			reasonPrefix: string;
		}): void => {
			const { assessment, toppedUp, measured } = assessWithTopUp(
				() => baseline,
				params.measure,
				params.rule.context_cost,
				params.invert,
			);
			const { delta, regression, uncertain, tailRisk, completionDrop } =
				assessment;
			let { status, reason } = finalizeVerdict(
				delta,
				params.rule.context_cost,
				regression,
				uncertain,
				toppedUp,
				params.evictWhenUncertain,
			);
			// Two-strike probation for re-audits. Admission demanded delta ≥ bar +
			// z·SE, but a point-estimate re-audit retention test churns real earners
			// by regression to the mean (a rule earning exactly the bar fails ~half
			// its re-audits; even a strong earner fails whenever the draw lands a
			// couple of SE low). Keep-when-uncertain is no fix — rent << SE, so a
			// dead rule is always "uncertain" and would never leave. Instead: the
			// first sub-threshold re-audit puts the rule on probation (kept,
			// flagged); a second consecutive one evicts; a passing re-audit clears
			// the strike. A regression still evicts immediately (safety invariant).
			let probation = false;
			if (params.kind === "re-audit" && !regression) {
				if (status === "evicted" && params.rule.probation === 0) {
					status = "active";
					reason = `probation (strike 1 of 2): ${reason} — retained; a second consecutive sub-threshold re-audit evicts`;
					setRuleProbation(db, params.rule.id, true);
					probation = true;
				} else if (status === "evicted") {
					reason = `second consecutive sub-threshold re-audit: ${reason}`;
				} else if (params.rule.probation !== 0) {
					setRuleProbation(db, params.rule.id, false);
				}
			}
			const fullReason = params.reasonPrefix + reason;
			const decidedAt = new Date().toISOString();
			decideRule(db, params.rule.id, status, delta, fullReason, decidedAt);

			// Verdict above is unchanged; the receipt is an additive snapshot.
			// `measured` is the with-rule side for a candidate (rule added) and
			// the without-rule side for a re-audit (rule removed), so map both
			// onto a stable with/without frame for the quality axis.
			const withSide = aggregateSide(params.invert ? baseline : measured);
			const withoutSide = aggregateSide(params.invert ? measured : baseline);
			recordReceipt(db, {
				ruleId: params.rule.id,
				agent,
				decidedAt,
				status,
				kind: params.kind,
				reason: fullReason,
				model: options.measuredModel ?? null,
				fixtureHash: options.fixtureHash ?? null,
				runs: Math.max(withSide.runs, withoutSide.runs),
				delta,
				contextCost: params.rule.context_cost,
				standardError:
					assessment.standardError === null
						? null
						: Math.round(assessment.standardError),
				regression,
				withTokens: withSide.tokens,
				withoutTokens: withoutSide.tokens,
				withToolCalls: withSide.toolCalls,
				withoutToolCalls: withoutSide.toolCalls,
				withFileRereads: withSide.fileRereads,
				withoutFileRereads: withoutSide.fileRereads,
				tasksTotal: baseline.length,
				tasksPassedWith: withSide.tasksPassed,
				tasksPassedWithout: withoutSide.tasksPassed,
			});

			decisions.push({
				rule: params.rule,
				kind: params.kind,
				delta,
				regression,
				status,
				uncertain,
				toppedUp,
				tailRisk,
				completionDrop,
				probation,
			});
		};

		for (const candidate of candidates) {
			// Candidate promotion requires confidence: an uncertain verdict
			// after top-up evicts rather than activates (don't pay rent on a
			// rule we can't show clears 2× rent).
			decide({
				rule: candidate,
				kind: "candidate",
				measure: (suffix, allocation) =>
					runner(
						[...activeSet, candidate],
						`candidate-${candidate.id}${suffix}`,
						false,
						allocation,
					),
				invert: false,
				evictWhenUncertain: true,
				reasonPrefix: "",
			});
		}

		if (auditTarget !== undefined) {
			const withoutIt = activeSet.filter((rule) => rule.id !== auditTarget.id);
			// The rule's current worth is cost-without minus cost-with (baseline
			// includes it), so the measured (toppable) side is the
			// without-configuration and the delta is inverted. Re-audit uses the
			// gentler point-estimate test: an established rule is de-activated
			// only on evidence it has stopped earning, not when a noisy
			// re-measure is merely inconclusive.
			decide({
				rule: auditTarget,
				kind: "re-audit",
				measure: (suffix, allocation) =>
					runner(
						withoutIt,
						`audit-${auditTarget.id}${suffix}`,
						false,
						allocation,
					),
				invert: true,
				evictWhenUncertain: false,
				reasonPrefix: "re-audit: ",
			});
		}
	}

	let rulesetVersion: number | null = null;
	const finalActive = getActiveRules(db, agent);
	if (decisions.length > 0) {
		rulesetVersion = compileActiveMemory(db, agent);
	}

	return {
		agent,
		decisions,
		activeBodies: finalActive.map((rule) => rule.body),
		rulesetVersion,
	};
}

interface SelectArgs {
	agent: string;
	runs: number;
	topUp: number;
}

export function parseSelectArgs(argv: string[]): SelectArgs {
	// Default 3 (not 2): tighter standard error against the >25% golden-suite
	// variance seen in real burns, so the selector can distinguish a genuine
	// small saving from noise instead of evicting it as uncertain.
	const args: SelectArgs = { agent: "", runs: 3, topUp: 1 };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--agent") {
			args.agent = argv[i + 1] ?? "";
			i++;
		} else if (argv[i] === "--runs") {
			args.runs = Number(argv[i + 1]);
			i++;
		} else if (argv[i] === "--top-up") {
			args.topUp = Number(argv[i + 1]);
			i++;
		} else {
			throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	if (!(DOMAIN_AGENTS as readonly string[]).includes(args.agent)) {
		throw new Error(
			`--agent must be one of: ${DOMAIN_AGENTS.join(", ")} (got "${args.agent}")`,
		);
	}
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isInteger(args.topUp) || args.topUp < 0) {
		throw new Error("--top-up must be a non-negative integer");
	}
	return args;
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
function finalizeVerdict(
	delta: number | null,
	contextCost: number,
	regression: boolean,
	uncertain: boolean,
	toppedUp: boolean,
	evictWhenUncertain: boolean,
): ReasonedVerdict {
	const base = verdictWithReason(delta, contextCost, regression);
	if (base.status === "active" && uncertain && evictWhenUncertain) {
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

export function main(args: SelectArgs): void {
	const db = openDb();
	try {
		const tasks: GoldenTask[] = loadGoldenTasks(args.agent);
		const runner: SuiteRunner = (rules, label, recordBaselines, allocation) => {
			const rulesetVersion = getRulesetVersion(db, args.agent);
			const config = recordBaselines
				? "active"
				: label.startsWith("audit-")
					? "audit"
					: "candidate";
			if (!allocation) {
				return runSuite(db, args.agent, tasks, {
					rules,
					runs: args.runs,
					recordBaselines,
					rulesetVersion,
					label,
					config,
				});
			}
			// Neyman top-up: run only the allocated tasks, each for its own count.
			const summaries: TaskSummary[] = [];
			for (const task of tasks) {
				const extraRuns = allocation.get(task.id);
				if (!extraRuns) continue;
				const [summary] = runSuite(db, args.agent, [task], {
					rules,
					runs: extraRuns,
					recordBaselines: false,
					rulesetVersion,
					label,
					config,
				});
				if (summary) summaries.push(summary);
			}
			return summaries;
		};

		console.log(
			`Selecting for agent=${args.agent} (runs=${args.runs} per config, top-up budget ${args.topUp})`,
		);
		const report = selectForAgent(db, args.agent, runner, {
			topUpBudget: args.topUp,
			measuredModel: loadAgentDefinition(args.agent).model,
			fixtureHash: goldenSuiteHash(args.agent),
		});

		if (report.decisions.length === 0) {
			console.log("No candidates and no active rules to audit; nothing to do.");
			return;
		}
		for (const decision of report.decisions) {
			console.log(
				`  [${decision.kind}] rule ${decision.rule.id} → ${decision.status.toUpperCase()}` +
					` (delta=${decision.delta ?? "n/a"}, rent=${decision.rule.context_cost}` +
					`${decision.regression ? ", REGRESSION" : ""}` +
					`${decision.toppedUp ? ", topped-up" : ""}` +
					`${decision.uncertain ? ", LOW-CONFIDENCE" : ""}` +
					`${decision.tailRisk ? ", TAIL-RISK" : ""}` +
					`${decision.completionDrop ? ", COMPLETION-DROP" : ""}` +
					`${decision.probation ? ", PROBATION (strike 1 of 2)" : ""}): "${decision.rule.body}"`,
			);
		}
		console.log(
			`Compiled ${report.activeBodies.length} active rule(s) → ${memoryFilePath(args.agent)}` +
				` (ruleset v${report.rulesetVersion})`,
		);
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
		assertPosixPlatform();
		main(parseSelectArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
