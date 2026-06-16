/**
 * Generic A/B comparison core shared by model-migration benchmarking
 * (`modelbench.ts`) and prompt/agent-definition benchmarking
 * (`promptbench.ts`). It compares two configurations of the same agent's
 * golden suite — only the varied dimension (the model, or the prompt)
 * differs — and produces a measured verdict. It does not know or care WHAT
 * varied; callers supply a `dimension` word and the two variant labels.
 *
 * Verdict metric is PROCESSING tokens (input + output + cache_creation), not
 * the raw four-component total: cache-read tokens are cheap re-reads whose
 * volume is partly a turn-count/scheduling artifact and which dominate the
 * raw sum, so including them 1:1 skews the comparison. Cache-read is reported
 * separately so nothing is hidden. Token counts are never converted to
 * dollars.
 */
import {
	metaCost,
	type RunResult,
	realWorkTokensLast7Days,
	summarizeTask,
	type TaskSummary,
} from "./bench.js";
import { getRunBySession, type WardenDb } from "./db.js";
import { displayText } from "./sanitize.js";
import { assessDelta, type DeltaAssessment } from "./select.js";
import { pctChange } from "./status.js";

/** One golden-task run reduced to the token measures comparison needs. */
export interface RunDatum {
	/** input + output + cache_creation — the verdict metric. */
	processingTokens: number;
	/** + cache_read — shown for transparency. */
	totalTokens: number;
	cacheRead: number;
	completed: boolean;
}

/** Per-task run data for one configuration. */
export interface VariantRuns {
	taskId: string;
	runs: RunDatum[];
}

interface TaskComparison {
	taskId: string;
	baselineProcessingMean: number;
	candidateProcessingMean: number;
	baselineTotalMean: number;
	candidateTotalMean: number;
	baselineCacheReadMean: number;
	candidateCacheReadMean: number;
	/** Completed runs / total runs, per side. */
	baselineCompleted: number;
	candidateCompleted: number;
	runs: number;
	/** Processing-token change of candidate vs baseline, e.g. "-18.0%". */
	pct: string;
}

export interface Comparison {
	/** The agent whose suite was run. */
	subject: string;
	/** What varied between the two sides, e.g. "model" or "prompt". */
	dimension: string;
	baselineLabel: string;
	candidateLabel: string;
	perTask: TaskComparison[];
	/** Overall processing-token savings (baseline − candidate); positive ⇒
	 * candidate cheaper. Null when no task completed in both. */
	delta: number | null;
	pct: string;
	standardError: number | null;
	/** Candidate failed a task the baseline completed → unsafe change. */
	regression: boolean;
	/** Token difference indistinguishable from zero (|Δ| < standard error). */
	uncertain: boolean;
	/** Tasks completed in BOTH configurations — confidence is meaningful
	 * only when this is ≥ 2. */
	comparableTasks: number;
}

const processingOf = (r: RunDatum): number => r.processingTokens;

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function completedMean(
	runs: RunDatum[],
	pick: (r: RunDatum) => number,
): number {
	return mean(runs.filter((r) => r.completed).map(pick));
}

/** TaskSummary shim carrying the processing-token mean so the existing
 * `assessDelta` can score the comparison unchanged. */
function processingSummary(variant: VariantRuns): TaskSummary {
	const results: RunResult[] = variant.runs.map((r, i) => ({
		sessionId: `${variant.taskId}-${i}`,
		tokens: r.processingTokens,
		completed: r.completed,
	}));
	return summarizeTask(variant.taskId, results);
}

/**
 * Pure comparison core (no DB, no claude): given per-task run data for two
 * configurations, produce the verdict. `assessDelta(baseline, candidate, 0)`
 * scores processing-token savings — with contextCost 0 its `uncertain` flag
 * means exactly "|Δ| < standard error", i.e. indistinguishable from zero.
 */
export function compareConfigs(
	subject: string,
	dimension: string,
	rawBaselineLabel: string,
	rawCandidateLabel: string,
	baseline: VariantRuns[],
	candidate: VariantRuns[],
): Comparison {
	// Labels are user/model-controlled (model ids, variant filenames). Strip
	// control/ANSI characters and newlines before they reach the report,
	// which the slash commands relay into the model's context — otherwise a
	// crafted label could inject fake report lines (prompt injection).
	const baselineLabel = displayText(rawBaselineLabel, 80);
	const candidateLabel = displayText(rawCandidateLabel, 80);
	const candidateByTask = new Map(candidate.map((m) => [m.taskId, m]));

	const perTask: TaskComparison[] = [];
	let comparableTasks = 0;
	for (const base of baseline) {
		const cand = candidateByTask.get(base.taskId);
		if (!cand) continue;
		const baseProc = completedMean(base.runs, processingOf);
		const candProc = completedMean(cand.runs, processingOf);
		perTask.push({
			taskId: base.taskId,
			baselineProcessingMean: baseProc,
			candidateProcessingMean: candProc,
			baselineTotalMean: completedMean(base.runs, (r) => r.totalTokens),
			candidateTotalMean: completedMean(cand.runs, (r) => r.totalTokens),
			baselineCacheReadMean: completedMean(base.runs, (r) => r.cacheRead),
			candidateCacheReadMean: completedMean(cand.runs, (r) => r.cacheRead),
			baselineCompleted: base.runs.filter((r) => r.completed).length,
			candidateCompleted: cand.runs.filter((r) => r.completed).length,
			runs: base.runs.length,
			pct: pctChange(candProc, baseProc),
		});
		if (
			base.runs.some((r) => r.completed) &&
			cand.runs.some((r) => r.completed)
		) {
			comparableTasks++;
		}
	}

	const assessment: DeltaAssessment = assessDelta(
		baseline.map(processingSummary),
		candidate.map(processingSummary),
		0,
	);

	const overallBaseProc = mean(
		perTask.map((t) => t.baselineProcessingMean).filter((n) => n > 0),
	);
	const overallCandProc = mean(
		perTask.map((t) => t.candidateProcessingMean).filter((n) => n > 0),
	);

	return {
		subject,
		dimension,
		baselineLabel,
		candidateLabel,
		perTask,
		delta: assessment.delta,
		pct: pctChange(overallCandProc, overallBaseProc),
		standardError: assessment.standardError,
		regression: assessment.regression,
		uncertain: assessment.uncertain,
		comparableTasks,
	};
}

/** Pool two passes of the same configuration, task by task. */
export function poolRuns(
	first: VariantRuns[],
	second: VariantRuns[],
): VariantRuns[] {
	const secondByTask = new Map(second.map((m) => [m.taskId, m]));
	return first.map((m) => ({
		taskId: m.taskId,
		runs: [...m.runs, ...(secondByTask.get(m.taskId)?.runs ?? [])],
	}));
}

export function verdictLine(cmp: Comparison): string {
	const { candidateLabel: c, baselineLabel: b, subject, dimension } = cmp;
	if (cmp.regression) {
		return `⚠ ${c} failed a task that ${b} completed — NOT a safe ${dimension} change for ${subject} regardless of tokens.`;
	}
	if (cmp.comparableTasks < 2) {
		return `Only ${cmp.comparableTasks} task(s) completed in both ${dimension}s — too few to judge confidence; treat ${cmp.pct} (${c} vs ${b}) as indicative only.`;
	}
	if (cmp.uncertain) {
		return `${c} and ${b} are within measurement noise on the ${subject} suite (Δ ${cmp.delta} processing tokens, SE ${Math.round(cmp.standardError ?? 0)}) — no clear difference. Add --runs or --top-up to sharpen.`;
	}
	if ((cmp.delta ?? 0) > 0) {
		return `${c} used ${cmp.pct} processing tokens vs ${b} on the ${subject} suite (all comparable tasks completed) — cheaper for this workload on token count.`;
	}
	return `${c} used ${cmp.pct} processing tokens vs ${b} on the ${subject} suite — more expensive for this workload on token count.`;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

export function formatComparison(cmp: Comparison): string {
	const lines: string[] = [];
	lines.push(
		`${cmp.dimension[0]?.toUpperCase()}${cmp.dimension.slice(1)} comparison — ${cmp.subject}: ${cmp.candidateLabel} (candidate) vs ${cmp.baselineLabel} (baseline)`,
	);
	lines.push("");
	lines.push(
		"Per task — mean PROCESSING tokens (input+output+cache_creation):",
	);
	for (const t of cmp.perTask) {
		const cacheNote =
			t.baselineCacheReadMean > 0 || t.candidateCacheReadMean > 0
				? `  [cache-read ${fmt(t.baselineCacheReadMean)} → ${fmt(t.candidateCacheReadMean)}]`
				: "";
		lines.push(
			`  ${t.taskId}: ${fmt(t.baselineProcessingMean)} → ${fmt(t.candidateProcessingMean)} (${t.pct})` +
				`  completed ${t.baselineCompleted}/${t.runs} → ${t.candidateCompleted}/${t.runs}${cacheNote}`,
		);
	}
	lines.push("");
	lines.push(`Verdict: ${verdictLine(cmp)}`);
	lines.push("");
	lines.push(
		"Note: verdict uses processing tokens; cache-read (cheap re-reads, ~10% price) is shown per task because it distorts raw cross-configuration totals.",
	);
	lines.push(
		"Note: token count ≠ dollar cost — models are priced differently per token. Apply your per-token rates to these counts.",
	);
	return lines.join("\n");
}

/** Reduce the runs a suite pass just wrote (by session id) to comparison
 * data. The run-error sentinel (no row written) becomes a failed zero-token
 * run. */
function gatherRuns(db: WardenDb, summaries: TaskSummary[]): VariantRuns[] {
	return summaries.map((summary) => ({
		taskId: summary.taskId,
		runs: summary.results.map((result): RunDatum => {
			const row = getRunBySession(db, result.sessionId);
			if (!row) {
				return {
					processingTokens: 0,
					totalTokens: 0,
					cacheRead: 0,
					completed: false,
				};
			}
			return {
				processingTokens:
					row.input_tokens + row.output_tokens + row.cache_creation,
				totalTokens:
					row.input_tokens +
					row.output_tokens +
					row.cache_creation +
					row.cache_read,
				cacheRead: row.cache_read,
				completed: row.completed === 1,
			};
		}),
	}));
}

/** Sum of all tokens spent across the gathered runs — for the meta-cost line. */
export function totalBenchTokens(...sides: VariantRuns[][]): number {
	return sides
		.flat()
		.flatMap((m) => m.runs)
		.reduce((sum, r) => sum + r.totalTokens, 0);
}

export interface ComparisonSpec {
	subject: string;
	dimension: string;
	baselineLabel: string;
	candidateLabel: string;
	/** Extra measurement passes (of both sides) when the verdict is within
	 * noise; 0 disables. */
	topUp: number;
	/** Run one suite pass of the baseline configuration. `label` prefixes the
	 * progress output. */
	runBaseline: (label: string) => TaskSummary[];
	runCandidate: (label: string) => TaskSummary[];
}

export interface ComparisonResult {
	comparison: Comparison;
	/** Total tokens spent across both sides — for the meta-cost line. */
	benchTokens: number;
}

/**
 * Orchestrate a full A/B comparison: run both configurations, score them,
 * and — when the verdict lands within noise — spend one bounded variance
 * top-up pass on both sides before re-scoring. Shared by model, prompt, and
 * prompt-evolution benchmarking so the top-up discipline lives in one place.
 */
export function runComparison(
	db: WardenDb,
	spec: ComparisonSpec,
): ComparisonResult {
	let baselineRuns = gatherRuns(db, spec.runBaseline("baseline"));
	let candidateRuns = gatherRuns(db, spec.runCandidate("candidate"));
	const score = (): Comparison =>
		compareConfigs(
			spec.subject,
			spec.dimension,
			spec.baselineLabel,
			spec.candidateLabel,
			baselineRuns,
			candidateRuns,
		);
	let comparison = score();

	if (comparison.uncertain && spec.topUp > 0) {
		console.log("  verdict within noise — spending one variance top-up pass…");
		baselineRuns = poolRuns(
			baselineRuns,
			gatherRuns(db, spec.runBaseline("baseline-topup")),
		);
		candidateRuns = poolRuns(
			candidateRuns,
			gatherRuns(db, spec.runCandidate("candidate-topup")),
		);
		comparison = score();
	}

	return {
		comparison,
		benchTokens: totalBenchTokens(baselineRuns, candidateRuns),
	};
}

/** Print the benchmarking overhead line shared by all comparison CLIs. */
export function reportMetaCost(db: WardenDb, benchTokens: number): void {
	const cost = metaCost(benchTokens, realWorkTokensLast7Days(db));
	const ratioText =
		cost.ratio === null
			? "no real-work tokens collected in the last 7 days"
			: `${(cost.ratio * 100).toFixed(1)}% of the week's real-work tokens`;
	console.log("");
	console.log(
		`Meta-cost: this comparison used ${cost.benchTokens.toLocaleString("en-US")} tokens — ${ratioText}.`,
	);
	if (cost.warn) {
		console.log(
			"⚠ Benchmarking overhead exceeded 10% of the week's collected real-work tokens.",
		);
	}
}
