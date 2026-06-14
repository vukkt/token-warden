/**
 * Model-migration benchmarking: "is model B cheaper than model A on this
 * agent's golden suite?" — answered with the same measured rigor the rule
 * selector uses.
 *
 * CLI: npx tsx src/modelbench.ts --agent <name> --model <candidate>
 *      [--baseline <id>] [--runs <n>] [--top-up <n>] [--task <id>]
 *
 * Holds the agent's active rules constant and varies only the model. Both
 * suite passes are recorded with config='modelbench' (isolated from
 * baselines, learning curves, p75, and the golden-run counts) and never
 * touch the frozen run1 baselines.
 *
 * Verdict metric is PROCESSING tokens (input + output + cache_creation), not
 * the raw four-component total: cache-read tokens are cheap re-reads whose
 * volume is partly a turn-count/scheduling artifact and which dominate the
 * raw sum, so including them 1:1 skews a cross-model comparison. Cache-read
 * is reported separately so nothing is hidden. Token count is never
 * converted to dollars (models are priced differently per token).
 */
import { pathToFileURL } from "node:url";
import {
	assertPosixPlatform,
	type GoldenTask,
	loadAgentDefinition,
	loadGoldenTasks,
	metaCost,
	type RunResult,
	realWorkTokensLast7Days,
	runSuite,
	summarizeTask,
	type TaskSummary,
} from "./bench.js";
import {
	getActiveRules,
	getRulesetVersion,
	getRunBySession,
	openDb,
	type RuleRow,
	type WardenDb,
} from "./db.js";
import { assessDelta, type DeltaAssessment } from "./select.js";
import { pctChange } from "./status.js";
import { DOMAIN_AGENTS } from "./types.js";

/** One golden-task run reduced to the token measures model comparison needs. */
export interface RunDatum {
	/** input + output + cache_creation — the verdict metric. */
	processingTokens: number;
	/** + cache_read — shown for transparency. */
	totalTokens: number;
	cacheRead: number;
	completed: boolean;
}

/** Per-task run data for one model. */
export interface ModelRuns {
	taskId: string;
	runs: RunDatum[];
}

export interface ModelTaskResult {
	taskId: string;
	baselineProcessingMean: number;
	candidateProcessingMean: number;
	baselineTotalMean: number;
	candidateTotalMean: number;
	baselineCacheReadMean: number;
	candidateCacheReadMean: number;
	/** Completed runs / total runs, per model. */
	baselineCompleted: number;
	candidateCompleted: number;
	runs: number;
	/** Processing-token change of candidate vs baseline, e.g. "-18.0%". */
	pct: string;
}

export interface ModelComparison {
	agent: string;
	baselineModel: string;
	candidateModel: string;
	perTask: ModelTaskResult[];
	/** Overall processing-token savings (baseline − candidate); positive ⇒
	 * candidate cheaper. Null when no task completed in both. */
	delta: number | null;
	pct: string;
	standardError: number | null;
	/** Candidate failed a task the baseline completed → unsafe switch. */
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
 * `assessDelta` can score the model comparison unchanged. */
function processingSummary(model: ModelRuns): TaskSummary {
	const results: RunResult[] = model.runs.map((r, i) => ({
		sessionId: `${model.taskId}-${i}`,
		tokens: r.processingTokens,
		completed: r.completed,
	}));
	return summarizeTask(model.taskId, results);
}

/**
 * Pure comparison core (no DB, no claude): given per-task run data for two
 * models, produce the verdict. `assessDelta(baseline, candidate, 0)` scores
 * processing-token savings — with contextCost 0 its `uncertain` flag means
 * exactly "|Δ| < standard error", i.e. indistinguishable from zero.
 */
export function compareRuns(
	agent: string,
	baselineModel: string,
	candidateModel: string,
	baseline: ModelRuns[],
	candidate: ModelRuns[],
): ModelComparison {
	const candidateByTask = new Map(candidate.map((m) => [m.taskId, m]));

	const perTask: ModelTaskResult[] = [];
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
	}

	const assessment: DeltaAssessment = assessDelta(
		baseline.map(processingSummary),
		candidate.map(processingSummary),
		0,
	);

	// Tasks completed in both configurations (assessDelta's comparable set).
	let comparableTasks = 0;
	for (const base of baseline) {
		const cand = candidateByTask.get(base.taskId);
		if (!cand) continue;
		if (
			base.runs.some((r) => r.completed) &&
			cand.runs.some((r) => r.completed)
		) {
			comparableTasks++;
		}
	}

	const overallBaseProc = mean(
		perTask.map((t) => t.baselineProcessingMean).filter((n) => n > 0),
	);
	const overallCandProc = mean(
		perTask.map((t) => t.candidateProcessingMean).filter((n) => n > 0),
	);

	return {
		agent,
		baselineModel,
		candidateModel,
		perTask,
		delta: assessment.delta,
		pct: pctChange(overallCandProc, overallBaseProc),
		standardError: assessment.standardError,
		regression: assessment.regression,
		uncertain: assessment.uncertain,
		comparableTasks,
	};
}

/** Pool two passes of the same model, task by task. */
export function poolRuns(first: ModelRuns[], second: ModelRuns[]): ModelRuns[] {
	const secondByTask = new Map(second.map((m) => [m.taskId, m]));
	return first.map((m) => ({
		taskId: m.taskId,
		runs: [...m.runs, ...(secondByTask.get(m.taskId)?.runs ?? [])],
	}));
}

export function verdictLine(cmp: ModelComparison): string {
	const { candidateModel: c, baselineModel: b, agent } = cmp;
	if (cmp.regression) {
		return `⚠ ${c} failed a task that ${b} completed — NOT a safe switch for ${agent} regardless of tokens.`;
	}
	if (cmp.comparableTasks < 2) {
		return `Only ${cmp.comparableTasks} task(s) completed in both models — too few to judge confidence; treat ${cmp.pct} (${c} vs ${b}) as indicative only.`;
	}
	if (cmp.uncertain) {
		return `${c} and ${b} are within measurement noise on the ${agent} suite (Δ ${cmp.delta} processing tokens, SE ${Math.round(cmp.standardError ?? 0)}) — no clear difference. Add --runs or --top-up to sharpen.`;
	}
	if ((cmp.delta ?? 0) > 0) {
		return `${c} used ${cmp.pct} processing tokens vs ${b} on the ${agent} suite (all comparable tasks completed) — cheaper for this workload on token count.`;
	}
	return `${c} used ${cmp.pct} processing tokens vs ${b} on the ${agent} suite — more expensive for this workload on token count.`;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

export function formatComparison(cmp: ModelComparison): string {
	const lines: string[] = [];
	lines.push(
		`Model comparison — ${cmp.agent}: ${cmp.candidateModel} (candidate) vs ${cmp.baselineModel} (baseline)`,
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
		"Note: verdict uses processing tokens; cache-read (cheap re-reads, ~10% price) is shown per task because it distorts raw cross-model totals.",
	);
	lines.push(
		"Note: token count ≠ dollar cost — models are priced differently per token. Apply your per-token rates to these counts.",
	);
	return lines.join("\n");
}

/** Reduce the runs the suite just wrote (by session id) to comparison data. */
function gatherModelRuns(db: WardenDb, summaries: TaskSummary[]): ModelRuns[] {
	return summaries.map((summary) => ({
		taskId: summary.taskId,
		runs: summary.results.map((result): RunDatum => {
			const row = getRunBySession(db, result.sessionId);
			if (!row) {
				// run-error sentinel (no row written): a failed, zero-token run.
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

interface ModelbenchArgs {
	agent: string;
	model: string;
	baseline: string | null;
	runs: number;
	topUp: number;
	task: string | null;
}

export function parseModelbenchArgs(argv: string[]): ModelbenchArgs {
	const args: ModelbenchArgs = {
		agent: "",
		model: "",
		baseline: null,
		runs: 2,
		topUp: 1,
		task: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		switch (argv[i]) {
			case "--agent":
				args.agent = value ?? "";
				i++;
				break;
			case "--model":
				args.model = value ?? "";
				i++;
				break;
			case "--baseline":
				args.baseline = value ?? null;
				i++;
				break;
			case "--runs":
				args.runs = Number(value);
				i++;
				break;
			case "--top-up":
				args.topUp = Number(value);
				i++;
				break;
			case "--task":
				args.task = value ?? null;
				i++;
				break;
			default:
				throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	if (!(DOMAIN_AGENTS as readonly string[]).includes(args.agent)) {
		throw new Error(
			`--agent must be one of: ${DOMAIN_AGENTS.join(", ")} (got "${args.agent}")`,
		);
	}
	if (args.model.trim() === "") {
		throw new Error("--model <candidate model id> is required");
	}
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isInteger(args.topUp) || args.topUp < 0) {
		throw new Error("--top-up must be a non-negative integer");
	}
	return args;
}

function main(args: ModelbenchArgs): void {
	const db = openDb();
	try {
		const baselineModel =
			args.baseline ?? loadAgentDefinition(args.agent).model;
		if (args.model === baselineModel) {
			throw new Error(
				`--model and baseline are both "${baselineModel}" — nothing to compare`,
			);
		}

		let tasks: GoldenTask[] = loadGoldenTasks(args.agent);
		if (args.task !== null) {
			tasks = tasks.filter((t) => t.id === args.task);
			if (tasks.length === 0) throw new Error(`no task with id ${args.task}`);
		}
		const rules: RuleRow[] = getActiveRules(db, args.agent);

		const runModel = (model: string, label: string): TaskSummary[] =>
			runSuite(db, args.agent, tasks, {
				rules,
				runs: args.runs,
				recordBaselines: false,
				rulesetVersion: getRulesetVersion(db, args.agent),
				label,
				config: "modelbench",
				model,
			});

		console.log(
			`Model-bench agent=${args.agent}: ${args.model} vs ${baselineModel}` +
				` (runs=${args.runs} per model, top-up ${args.topUp})`,
		);

		let baselineRuns = gatherModelRuns(db, runModel(baselineModel, "baseline"));
		let candidateRuns = gatherModelRuns(db, runModel(args.model, "candidate"));
		let cmp = compareRuns(
			args.agent,
			baselineModel,
			args.model,
			baselineRuns,
			candidateRuns,
		);

		if (cmp.uncertain && args.topUp > 0) {
			console.log(
				"  verdict within noise — spending one variance top-up pass…",
			);
			baselineRuns = poolRuns(
				baselineRuns,
				gatherModelRuns(db, runModel(baselineModel, "baseline-topup")),
			);
			candidateRuns = poolRuns(
				candidateRuns,
				gatherModelRuns(db, runModel(args.model, "candidate-topup")),
			);
			cmp = compareRuns(
				args.agent,
				baselineModel,
				args.model,
				baselineRuns,
				candidateRuns,
			);
		}

		console.log("");
		console.log(formatComparison(cmp));

		const benchTokens = [...baselineRuns, ...candidateRuns]
			.flatMap((m) => m.runs)
			.reduce((sum, r) => sum + r.totalTokens, 0);
		const cost = metaCost(benchTokens, realWorkTokensLast7Days(db));
		const ratioText =
			cost.ratio === null
				? "no real-work tokens collected in the last 7 days"
				: `${(cost.ratio * 100).toFixed(1)}% of the week's real-work tokens`;
		console.log("");
		console.log(
			`Meta-cost: this comparison used ${fmt(cost.benchTokens)} tokens — ${ratioText}.`,
		);
		if (cost.warn) {
			console.log(
				"⚠ Benchmarking overhead exceeded 10% of the week's collected real-work tokens.",
			);
		}
	} finally {
		db.close();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		assertPosixPlatform();
		main(parseModelbenchArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
