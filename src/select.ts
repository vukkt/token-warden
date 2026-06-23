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
	type WardenDb,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

const MAX_CANDIDATES_PER_INVOCATION = 3;

export interface VerdictInput {
	measuredDelta: number | null;
	contextCost: number;
}

/** Keep/evict inequality from the spec: a rule must save at least twice its
 * context rent. SESSIONS_PER_WEEK cancels algebraically but is kept so the
 * policy reads as the spec states it. */
export function verdict(rule: VerdictInput): "active" | "evicted" {
	// A zero/negative/NaN override would invert or trivialize the
	// inequality; fall back to the default instead.
	const raw = Number(process.env.WARDEN_SESSIONS_PER_WEEK ?? 20);
	const sessionsPerWeek = Number.isFinite(raw) && raw > 0 ? raw : 20;
	if (rule.measuredDelta === null || rule.measuredDelta <= 0) return "evicted";
	const weeklySavings = rule.measuredDelta * sessionsPerWeek;
	const weeklyRent = rule.contextCost * sessionsPerWeek;
	return weeklySavings >= weeklyRent * 2 ? "active" : "evicted";
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
	return status === "active"
		? { status, reason: `savings ${delta} ≥ 2× context rent ${contextCost}` }
		: {
				status,
				reason: `sub-threshold: savings ${delta} < 2× context rent ${contextCost}`,
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
 * (invariant #3), plus the regression flag. */
function perTaskComparisons(
	without: TaskSummary[],
	withRule: TaskSummary[],
): { comparisons: TaskComparison[]; regression: boolean } {
	const withById = new Map(withRule.map((s) => [s.taskId, s]));
	const comparisons: TaskComparison[] = [];
	let regression = false;
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
		comparisons.push({
			saving: base.meanCompletedTokens - other.meanCompletedTokens,
			withoutTokens,
			withTokens,
		});
	}
	return { comparisons, regression };
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

export interface DeltaAssessment extends DeltaResult {
	/** Standard error of the mean saving. Computed from propagated *within-task*
	 * run-to-run variance when ≥2 runs/side exist (the correct estimand for a
	 * frozen, fixed golden suite — it shrinks as 1/√runs); falls back to the
	 * between-task spread only when no within-task variance is estimable. Null
	 * with <2 comparable tasks. */
	standardError: number | null;
	/** Which variance the standard error is built from. "within-task" is the
	 * correct fixed-suite estimator; "between-task" is the legacy fallback at
	 * runs=1 — surfaced so a verdict's confidence basis is auditable. */
	standardErrorBasis: "within-task" | "between-task" | null;
	/** True when the keep/evict verdict could flip within one standard
	 * error — the signal to spend a top-up measurement. */
	uncertain: boolean;
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
	const { comparisons, regression } = perTaskComparisons(without, withRule);
	if (comparisons.length === 0) {
		return {
			delta: null,
			regression,
			standardError: null,
			standardErrorBasis: null,
			uncertain: false,
		};
	}
	const savings = comparisons.map((c) => c.saving);
	const k = savings.length;
	const mean = savings.reduce((a, b) => a + b, 0) / k;
	const delta = Math.round(mean);

	// Propagated within-task standard error (the fixed-suite estimand). Borrow a
	// pooled per-side variance for any task too sparse to estimate its own.
	const pooledWithout = pooledVariance(comparisons.map((c) => c.withoutTokens));
	const pooledWith = pooledVariance(comparisons.map((c) => c.withTokens));
	let standardError: number | null = null;
	let standardErrorBasis: "within-task" | "between-task" | null = null;
	if (pooledWithout !== null && pooledWith !== null) {
		let sumVar = 0;
		for (const c of comparisons) {
			const vW = sampleVariance(c.withoutTokens) ?? pooledWithout;
			const vR = sampleVariance(c.withTokens) ?? pooledWith;
			sumVar += vW / c.withoutTokens.length + vR / c.withTokens.length;
		}
		standardError = Math.sqrt(sumVar / k ** 2);
		standardErrorBasis = "within-task";
	} else if (k >= 2) {
		// runs=1 everywhere: no run-to-run estimate exists. Fall back to the
		// legacy between-task spread so confidence is never silently dropped.
		const variance =
			savings.reduce((acc, s) => acc + (s - mean) ** 2, 0) / (k - 1);
		standardError = Math.sqrt(variance / k);
		standardErrorBasis = "between-task";
	}

	const threshold = 2 * contextCost;
	const uncertain =
		!regression &&
		standardError !== null &&
		Math.abs(mean - threshold) < standardError;
	return { delta, regression, standardError, standardErrorBasis, uncertain };
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
			const { delta, regression, uncertain } = assessment;
			const { status, reason } = finalizeVerdict(
				delta,
				params.rule.context_cost,
				regression,
				uncertain,
				toppedUp,
				params.evictWhenUncertain,
			);
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
		const memoryPath = memoryFilePath(agent);
		mkdirSync(dirname(memoryPath), { recursive: true });
		writeFileSync(memoryPath, compileMemoryMd(finalActive));
		rulesetVersion = bumpRulesetVersion(db, agent, new Date().toISOString());
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

function main(args: SelectArgs): void {
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
					`${decision.uncertain ? ", LOW-CONFIDENCE" : ""}): "${decision.rule.body}"`,
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
