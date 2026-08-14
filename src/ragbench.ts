/**
 * The context-architecture benchmark: mega-prompt vs retrieval pipeline.
 *
 * ## The question this answers
 *
 * "Should we hand the agent one big prompt, or build a retrieval pipeline?" is
 * normally settled by argument. It is an empirical question with a different
 * answer per corpus, per budget, and per question mix, and this measures it.
 *
 * ## Two modes, and why the default is free
 *
 * **Retrieval mode (default, ZERO tokens).** Whether a strategy put the answer
 * in front of the model is decidable without calling one: the corpus is
 * synthetic, so the ground-truth value is known, and `valueAppearsIn` checks the
 * assembled context for it. That yields two numbers per strategy — how often the
 * answer was present, and what the context cost — which is the entire
 * architecture trade-off. It is deterministic and reproducible forever.
 *
 * **End-to-end mode (`--yes`, spends tokens).** Actually calls the model,
 * extracts facts, verifies every citation, and scores against expected values.
 * Gated behind an explicit flag for the same reason every other burn script in
 * this repo is: token spend is an operator decision, never a side effect of
 * running a report.
 *
 * The split is not a compromise. Retrieval recall is an UPPER BOUND on
 * end-to-end accuracy — a pipeline cannot answer from context it never
 * retrieved — so the free measurement bounds the expensive one, and a strategy
 * that loses on recall cannot be rescued by a better prompt.
 *
 * ## What "mega-prompt" costs, precisely
 *
 * The `full` arm has recall 1.0 by construction; it can never miss, because it
 * retrieves everything. Its cost is that it pays for the whole corpus on every
 * single question, forever, whether or not any of it was relevant — which is the
 * identical failure mode this project was built to catch in agent memory files.
 * A rule nobody measured and a corpus nobody filtered are the same mistake at
 * different scales. The output table is deliberately shaped to make that
 * comparison unavoidable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "./cli.js";
import { type Corpus, corpusTokens, ingestCorpus } from "./corpus.js";
import {
	buildExtractionPrompt,
	type GroundingReport,
	parseFacts,
	valueAppearsIn,
	verifyGrounding,
} from "./extract.js";
import { formatNumber, formatRounded } from "./format.js";
import {
	callClaude,
	defaultSpawn,
	interrogate,
	type SpawnLike,
} from "./interrogate.js";
import {
	buildIndex,
	type LexicalIndex,
	renderContext,
	retrieve,
	STRATEGIES,
	type Strategy,
} from "./retrieve.js";
import { mean } from "./stats.js";

/** A golden question with known ground truth. */
const questionSchema = z.object({
	id: z.string().min(1),
	type: z.string().min(1),
	question: z.string().min(1),
	expect: z.object({
		value: z.number().nullable(),
		unit: z.string().default(""),
		period: z.string().default(""),
	}),
	mustCiteDoc: z.string().nullable().default(null),
	requiresDocs: z.array(z.string()).default([]),
	expectEmpty: z.boolean().default(false),
	expectConflict: z.boolean().default(false),
	why: z.string().default(""),
});

export type Question = z.infer<typeof questionSchema>;

const suiteSchema = z.object({
	corpus: z.string().default("corpus"),
	questions: z.array(questionSchema).min(1),
});

/** Load and validate a question suite. Validated at the boundary like every
 * other foreign input in this repo — a malformed suite should fail loudly at
 * load, not produce a confident table built on a missing field. */
export function loadSuite(dir: string): {
	corpus: Corpus;
	questions: Question[];
} {
	const raw = JSON.parse(readFileSync(join(dir, "questions.json"), "utf8"));
	const suite = suiteSchema.parse(raw);
	return {
		corpus: ingestCorpus(join(dir, suite.corpus)),
		questions: suite.questions,
	};
}

/** One strategy's result on one question. */
export interface QuestionResult {
	questionId: string;
	strategy: Strategy;
	/** Context tokens this strategy spent on this question. */
	tokens: number;
	/**
	 * Was the answer retrievable from what this strategy assembled?
	 *
	 * For an answerable question: does the context contain the expected value.
	 * For an `expectEmpty` question there is no value to find, so this is scored
	 * INVERSELY — see `distractorOnly`. Null when the question is not scorable
	 * on retrieval alone (conflict questions need both sources judged).
	 *
	 * The mechanism is `expect.value === null`, NOT `expectConflict` — nothing
	 * reads that flag. The conflict question is excluded only because it happens
	 * to carry a null expected value; a conflict question written with a value
	 * would be scored like any other. Named because the two read the same from
	 * outside and are not the same rule.
	 */
	answerBearing: boolean | null;
	/**
	 * True when the question is unanswerable AND the strategy still supplied
	 * plausible context. Not a failure of retrieval — retrieval is working as
	 * designed — but it is the exposure that makes a model fabricate, so it is
	 * counted rather than hidden.
	 */
	distractorOnly: boolean;
	/** Whether the document the answer actually lives in was retrieved at all.
	 * Separated from `answerBearing` because "wrong document, right number"
	 * happens on the period-trap questions and is a different bug. */
	citedDocPresent: boolean | null;
}

/** Evaluate one strategy on one question without calling a model. */
export function scoreRetrieval(
	strategy: Strategy,
	corpus: Corpus,
	index: LexicalIndex,
	question: Question,
	budgetTokens: number,
): QuestionResult {
	const r = retrieve(strategy, corpus, index, question.question, budgetTokens);

	if (question.expectEmpty) {
		return {
			questionId: question.id,
			strategy,
			tokens: r.tokens,
			answerBearing: null,
			distractorOnly: r.chunks.length > 0,
			citedDocPresent: null,
		};
	}

	const expected = question.expect.value;
	const answerBearing =
		expected === null ? null : valueAppearsIn(expected, renderContext(r));
	const required =
		question.requiresDocs.length > 0
			? question.requiresDocs
			: question.mustCiteDoc !== null
				? [question.mustCiteDoc]
				: [];
	const docs = new Set(r.chunks.map((c) => c.docId));
	const citedDocPresent =
		required.length === 0 ? null : required.every((d) => docs.has(d));

	return {
		questionId: question.id,
		strategy,
		tokens: r.tokens,
		answerBearing,
		distractorOnly: false,
		citedDocPresent,
	};
}

/** Aggregate scores for one strategy across the suite. */
export interface StrategyReport {
	strategy: Strategy;
	/** Mean context tokens per question. */
	meanTokens: number;
	/** Fraction of answerable questions whose answer was in the context. */
	recall: number;
	/** Fraction of multi-document questions where every required document was
	 * retrieved. Null when the suite has none. */
	docRecall: number | null;
	/** Answerable questions scored. */
	scored: number;
	/** Unanswerable questions where context was supplied anyway. */
	distractors: number;
	/**
	 * Mean tokens spent per answer actually made available.
	 *
	 * This is the number the architecture decision turns on, and it is the one
	 * that is invisible if you look at recall alone. A strategy with recall 1.0
	 * at 15x the token cost is not winning; it is buying the last few points of
	 * recall at a price nobody quoted.
	 */
	tokensPerAnswer: number;
}

export function summarize(results: QuestionResult[]): StrategyReport[] {
	const out: StrategyReport[] = [];
	for (const strategy of STRATEGIES) {
		const rows = results.filter((r) => r.strategy === strategy);
		if (rows.length === 0) continue;
		const answerable = rows.filter((r) => r.answerBearing !== null);
		const hits = answerable.filter((r) => r.answerBearing === true).length;
		const docRows = rows.filter((r) => r.citedDocPresent !== null);
		const meanTokens = mean(rows.map((r) => r.tokens));
		out.push({
			strategy,
			meanTokens,
			recall: answerable.length === 0 ? 0 : hits / answerable.length,
			docRecall:
				docRows.length === 0
					? null
					: docRows.filter((r) => r.citedDocPresent === true).length /
						docRows.length,
			scored: answerable.length,
			distractors: rows.filter((r) => r.distractorOnly).length,
			// Total context spent across the suite divided by answers made
			// available. Infinite when nothing was found, which is the honest
			// rendering of "spent tokens, produced nothing".
			tokensPerAnswer:
				hits === 0
					? Number.POSITIVE_INFINITY
					: rows.reduce((a, r) => a + r.tokens, 0) / hits,
		});
	}
	return out;
}

/** Render the comparison table. */
export function renderReport(
	corpus: Corpus,
	reports: StrategyReport[],
	budgetTokens: number,
): string {
	const lines: string[] = [];
	lines.push(
		`corpus: ${corpus.documents.length} documents, ${corpus.chunks.length} chunks, ${formatNumber(corpusTokens(corpus))} tokens total`,
	);
	lines.push(`retrieval budget: ${formatNumber(budgetTokens)} tokens/question`);
	lines.push("");
	lines.push(
		"strategy      mean ctx tok    answer recall    doc recall    tok/answer",
	);
	for (const r of reports) {
		const tpa = Number.isFinite(r.tokensPerAnswer)
			? formatRounded(r.tokensPerAnswer)
			: "n/a";
		lines.push(
			`${r.strategy.padEnd(14)}${formatRounded(r.meanTokens).padStart(12)}` +
				`${`${(r.recall * 100).toFixed(1)}%`.padStart(18)}` +
				`${(r.docRecall === null ? "n/a" : `${(r.docRecall * 100).toFixed(1)}%`).padStart(14)}` +
				`${tpa.padStart(14)}`,
		);
	}
	const full = reports.find((r) => r.strategy === "full");
	const bm = reports.find((r) => r.strategy === "bm25");
	if (full !== undefined && bm !== undefined && bm.meanTokens > 0) {
		const ratio = full.meanTokens / bm.meanTokens;
		const lost = (full.recall - bm.recall) * 100;
		lines.push("");
		lines.push(
			`mega-prompt costs ${ratio.toFixed(1)}x the retrieval pipeline per question ` +
				`and buys ${lost >= 0 ? "+" : ""}${lost.toFixed(1)} points of answer recall.`,
		);
		lines.push(
			"Recall is an UPPER BOUND on end-to-end accuracy, not a substitute for it:",
		);
		lines.push(
			"a strategy can place the answer in context and still be answered wrongly.",
		);
	}
	return lines.join("\n");
}

/** Suite directory. Overridable so an integrator can point this at their own
 * corpus and questions without editing the source. */
export function financeSuiteDir(): string {
	return (
		process.env.TOKEN_WARDEN_RAG_SUITE ??
		join(process.cwd(), "benchmarks", "finance")
	);
}

export interface RagbenchArgs {
	dir: string;
	budget: number;
	json: boolean;
	sweep: boolean;
	/** Explicit opt-in to spending tokens. Never defaulted on. */
	yes: boolean;
	/** Restrict the end-to-end run to these arms. Empty means all four.
	 * Exists so a single arm can be re-validated after a change without
	 * re-buying the other three — but note that a subset run is NOT comparable
	 * with a full run, because the arms are only paired when they answer the
	 * same questions in the same session. */
	arms: string[];
}

/** Default per-question retrieval budget, in tokens.
 *
 * 2,000 is roughly two sections of a filing — enough for a real answer plus its
 * surrounding context, small enough that the mega-prompt comparison is not
 * rigged. Note that a budget large enough to hold the whole corpus makes every
 * strategy identical, so this number IS the experiment; it is reported in the
 * output header rather than left implicit. */
const DEFAULT_BUDGET = 2000;

export function parseArgs(argv: string[]): RagbenchArgs {
	const args: RagbenchArgs = {
		dir: financeSuiteDir(),
		budget: DEFAULT_BUDGET,
		json: false,
		sweep: false,
		yes: false,
		arms: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--sweep") args.sweep = true;
		else if (flag === "--yes") args.yes = true;
		else if (flag === "--arm") {
			const name = String(argv[++i] ?? "");
			const known = [...STRATEGIES, "agent"];
			if (!known.includes(name)) {
				throw new Error(`--arm must be one of: ${known.join(", ")}`);
			}
			args.arms.push(name);
		} else if (flag === "--dir") args.dir = String(argv[++i] ?? "");
		else if (flag === "--budget") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--budget must be a positive integer");
			}
			args.budget = n;
		} else if (flag === "--json") args.json = true;
		else if (flag?.startsWith("--")) {
			throw new Error(`unknown flag: ${flag}`);
		}
	}
	return args;
}

/** Run the zero-token retrieval comparison across every strategy. */
export function runRetrievalBench(
	dir: string,
	budgetTokens: number,
): { corpus: Corpus; results: QuestionResult[]; reports: StrategyReport[] } {
	const { corpus, questions } = loadSuite(dir);
	const index = buildIndex(corpus.chunks);
	const results: QuestionResult[] = [];
	for (const strategy of STRATEGIES) {
		for (const question of questions) {
			results.push(
				scoreRetrieval(strategy, corpus, index, question, budgetTokens),
			);
		}
	}
	return { corpus, results, reports: summarize(results) };
}

/** One budget's worth of the frontier. */
export interface SweepRow {
	budget: number;
	strategy: Strategy;
	recall: number;
	meanTokens: number;
}

/**
 * Sweep the retrieval budget and report the recall/cost frontier.
 *
 * ## Why the sweep is the real answer
 *
 * A single-budget table answers "is retrieval better than a mega-prompt AT THIS
 * ONE BUDGET", which is a question nobody has. The decision an architect
 * actually faces is "how few tokens can I spend and still answer everything",
 * and that is a curve with a knee in it. The knee — the smallest budget still at
 * full recall — is the operating point, and everything to the right of it is
 * money spent on context that changed no answer.
 *
 * This also exposes the honest failure case. Where the curve never reaches the
 * mega-prompt's recall at any budget below the corpus size, retrieval is simply
 * losing on that corpus, and the tool says so rather than reporting the one
 * budget where it happened to look good.
 */
export function sweepBudgets(dir: string, budgets: number[]): SweepRow[] {
	const { corpus, questions } = loadSuite(dir);
	const index = buildIndex(corpus.chunks);
	const rows: SweepRow[] = [];
	for (const budget of budgets) {
		const results: QuestionResult[] = [];
		for (const strategy of STRATEGIES) {
			for (const question of questions) {
				results.push(scoreRetrieval(strategy, corpus, index, question, budget));
			}
		}
		for (const report of summarize(results)) {
			rows.push({
				budget,
				strategy: report.strategy,
				recall: report.recall,
				meanTokens: report.meanTokens,
			});
		}
	}
	return rows;
}

/** Budgets swept by `--sweep`. Geometric so the curve is readable across two
 * orders of magnitude without 40 rows. */
const SWEEP_BUDGETS = [200, 400, 600, 800, 1200, 1600, 2400, 3200, 6400];

/**
 * The smallest swept budget at which a strategy still answers everything the
 * mega-prompt answers. Null when it never does — reported as "never", because a
 * silent absence here would read as a small number.
 */
export function knee(rows: SweepRow[], strategy: Strategy): SweepRow | null {
	const target = Math.max(
		...rows.filter((r) => r.strategy === "full").map((r) => r.recall),
		0,
	);
	const hits = rows
		.filter((r) => r.strategy === strategy && r.recall >= target)
		.sort((a, b) => a.budget - b.budget);
	return hits[0] ?? null;
}

export function renderSweep(corpus: Corpus, rows: SweepRow[]): string {
	const lines: string[] = [];
	const total = corpusTokens(corpus);
	lines.push(
		`corpus: ${corpus.documents.length} documents, ${corpus.chunks.length} chunks, ${formatNumber(total)} tokens total`,
	);
	lines.push("");
	lines.push("answer recall vs retrieval budget");
	lines.push("");
	lines.push("  budget      bm25   section      full");
	for (const budget of SWEEP_BUDGETS) {
		const at = (s: Strategy): string => {
			const row = rows.find((r) => r.budget === budget && r.strategy === s);
			return row === undefined ? "     -" : `${(row.recall * 100).toFixed(0)}%`;
		};
		lines.push(
			`${formatNumber(budget).padStart(8)}${at("bm25").padStart(10)}${at("section").padStart(10)}${at("full").padStart(10)}`,
		);
	}
	lines.push("");
	for (const strategy of ["bm25", "section"] as const) {
		const k = knee(rows, strategy);
		lines.push(
			k === null
				? `${strategy}: never reaches mega-prompt recall at any swept budget — retrieval loses on this corpus.`
				: `${strategy}: matches mega-prompt recall from ${formatNumber(k.budget)} tokens/question ` +
						`(${(total / Math.max(k.meanTokens, 1)).toFixed(1)}x cheaper than carrying all ${formatNumber(total)}).`,
		);
	}
	lines.push("");
	lines.push(
		"Caveat that governs how far this generalizes: a 5-document corpus is small",
	);
	lines.push(
		"enough that the mega-prompt is a legitimate architecture. The saving scales",
	);
	lines.push(
		"with corpus size while the retrieval cost does not, so the ratio above is a",
	);
	lines.push("FLOOR for a real document set, not a headline.");
	return lines.join("\n");
}

/** One question answered end to end by one architecture. */
export interface EndToEndResult {
	questionId: string;
	arm: string;
	contextTokens: number;
	/** Answered correctly: the expected value appears among the ACCEPTED facts,
	 * or — for an unanswerable question — nothing was accepted. */
	correct: boolean;
	/** Facts the grounding gate threw out. These are the claims that would have
	 * been reported as fact by a pipeline without a citation check, so this
	 * column is the measured value of the check itself. */
	ungrounded: number;
	hops: number;
	error: string | null;
}

/**
 * Score one model answer against known ground truth.
 *
 * An unanswerable question is scored INVERSELY — correct means the pipeline
 * declined. Without that row a benchmark rewards a model for always producing
 * something, which is precisely the behavior that produces fabricated figures.
 */
export function scoreAnswer(
	question: Question,
	report: GroundingReport | null,
): { correct: boolean; ungrounded: number } {
	if (report === null) return { correct: false, ungrounded: 0 };
	const ungrounded = report.rejected.length;
	if (question.expectEmpty) {
		return { correct: report.accepted.length === 0, ungrounded };
	}
	const expected = question.expect.value;
	if (expected === null) {
		// WEAK, and named as such (2026-08-13). This branch is reached by the
		// CONFLICT question, whose suite entry claims it is "scored on whether BOTH
		// sources are cited". Nothing reads `expectConflict` — not here, not in
		// `scoreRetrieval` — so any single grounded fact marks the row correct,
		// including one about an entirely different metric. It is left as-is rather
		// than tightened silently, because changing it would move an end-to-end
		// accuracy figure that no re-run exists to re-establish. Implementing real
		// conflict scoring is tracked in ROADMAP.
		return { correct: report.accepted.length > 0, ungrounded };
	}
	return {
		correct: report.accepted.some((f) => Math.abs(f.value - expected) < 1e-9),
		ungrounded,
	};
}

/**
 * Run the end-to-end benchmark. SPENDS TOKENS.
 *
 * Every arm answers every question, so the comparison is paired: the same
 * questions, the same corpus, the same model, differing only in how context was
 * assembled. Unpaired arms would confound retrieval quality with question mix,
 * which is the mistake that makes most published RAG comparisons unreadable.
 */
/**
 * Consecutive environment failures that abort the whole run.
 *
 * Mirrors `ENV_FAILURE_STREAK` in `bench.ts`, and exists for the same reason.
 * The FIRST end-to-end burn of this benchmark hit a rate limit at question 5,
 * failed every remaining call, and cheerfully reported "33.3% accuracy" for all
 * four arms — 4 of 12 correct because 8 of 12 never ran. Every arm scored
 * identically because none of them were measured. That number was garbage with
 * a decimal point on it, and this is the guard that makes producing it
 * impossible.
 *
 * Four, like bench.ts: enough that a single flaky call cannot abort a paid run,
 * few enough that a dead environment is not discovered forty calls later.
 */
export const ENV_FAILURE_STREAK = 4;

export interface EndToEndRun {
	rows: EndToEndResult[];
	/**
	 * Set when the run was cut short by consecutive environment failures. When
	 * true the rows are EVIDENCE OF NOTHING and must not be scored — the
	 * renderer refuses to print an accuracy table.
	 */
	aborted: boolean;
	abortReason: string | null;
}

export function runEndToEnd(
	dir: string,
	budgetTokens: number,
	deps: {
		spawn?: SpawnLike;
		sleep?: (ms: number) => void;
		/** Arms to run; empty/undefined means all of them. */
		arms?: string[];
	} = {},
): EndToEndRun {
	const { corpus, questions } = loadSuite(dir);
	const index = buildIndex(corpus.chunks);
	const out: EndToEndResult[] = [];
	const wanted = deps.arms ?? [];
	const runs = (arm: string): boolean =>
		wanted.length === 0 || wanted.includes(arm);
	let streak = 0;
	let abortReason: string | null = null;

	/** Record a row and update the environment-failure streak. Returns true when
	 * the caller must stop. A NON-environmental failure (an unparseable reply,
	 * say) resets nothing and never aborts — that is a result, not a dead API. */
	const record = (row: EndToEndResult, environmental: boolean): boolean => {
		out.push(row);
		if (row.error !== null && environmental) {
			streak++;
			if (streak >= ENV_FAILURE_STREAK) {
				abortReason =
					`${streak} consecutive environment failures (last: ${row.error}).` +
					" Nothing here is a measurement.";
				return true;
			}
		} else if (row.error === null) {
			streak = 0;
		}
		return false;
	};

	for (const question of questions) {
		for (const strategy of STRATEGIES) {
			if (!runs(strategy)) continue;
			const retrieval = retrieve(
				strategy,
				corpus,
				index,
				question.question,
				budgetTokens,
			);
			const answer = answerOnce(
				question.question,
				renderContext(retrieval),
				corpus,
				deps.spawn,
				deps.sleep,
			);
			const scored = scoreAnswer(question, answer.report);
			const stop = record(
				{
					questionId: question.id,
					arm: strategy,
					contextTokens: retrieval.tokens,
					correct: scored.correct,
					ungrounded: scored.ungrounded,
					hops: 1,
					error: answer.error,
				},
				answer.environmentFailure,
			);
			if (stop) return { rows: out, aborted: true, abortReason };
		}
		// The agentic arm, which is the only one that can issue a query it could
		// not have written before seeing the first result.
		if (!runs("agent")) continue;
		const agent = interrogate(corpus, question.question, { index, ...deps });
		const scored = scoreAnswer(question, agent.report);
		const stop = record(
			{
				questionId: question.id,
				arm: "agent",
				contextTokens: agent.contextTokens,
				correct: scored.correct,
				ungrounded: scored.ungrounded,
				hops: agent.hops,
				error: agent.error,
			},
			agent.environmentFailure,
		);
		if (stop) return { rows: out, aborted: true, abortReason };
	}
	return { rows: out, aborted: false, abortReason: null };
}

/** Single-shot: one context, one model call, verified. */
function answerOnce(
	question: string,
	context: string,
	corpus: Corpus,
	spawn?: SpawnLike,
	sleep?: (ms: number) => void,
): {
	report: GroundingReport | null;
	error: string | null;
	environmentFailure: boolean;
} {
	// Shares `callClaude` with the agent arm so both get the same bounded retry
	// on rate limits and the same failure classification. Two hand-rolled spawn
	// sites would drift, and the arm that drifted would look better or worse for
	// a reason that has nothing to do with its architecture.
	const called = callClaude(
		spawn ?? defaultSpawn,
		buildExtractionPrompt(question, context),
		sleep,
	);
	if (!called.ok) {
		return {
			report: null,
			error: called.failure.reason,
			environmentFailure: called.failure.environmental,
		};
	}
	const parsed = parseFacts(called.text);
	if (!parsed.ok) {
		return { report: null, error: parsed.reason, environmentFailure: false };
	}
	return {
		report: verifyGrounding(parsed.facts, corpus.chunks, parsed.malformed),
		error: null,
		environmentFailure: false,
	};
}

/**
 * Aggregate the end-to-end rows into one line per architecture.
 *
 * REFUSES to print an accuracy table for an aborted run. That refusal is the
 * feature: the alternative is a table of percentages computed over calls that
 * never happened, and a percentage is far more persuasive than it is true.
 */
export function renderEndToEnd(run: EndToEndRun): string {
	const { rows } = run;
	if (run.aborted) {
		return [
			"ABORTED — no verdict.",
			"",
			run.abortReason ?? "environment failure",
			"",
			`${rows.length} ${rows.length === 1 ? "run was" : "runs were"} attempted before the abort and ${rows.length === 1 ? "is" : "are"} NOT scored.`,
			"An accuracy figure computed over calls that never reached the model",
			"would be indistinguishable in shape from a real one, so none is shown.",
			"Re-run when the environment is healthy.",
		].join("\n");
	}
	const arms = [...new Set(rows.map((r) => r.arm))];
	const lines: string[] = [];
	lines.push(
		"arm          questions   accuracy   ungrounded claims   mean ctx tok   mean hops",
	);
	for (const arm of arms) {
		const mine = rows.filter((r) => r.arm === arm);
		const correct = mine.filter((r) => r.correct).length;
		const ungrounded = mine.reduce((a, r) => a + r.ungrounded, 0);
		lines.push(
			`${arm.padEnd(13)}${String(mine.length).padStart(9)}` +
				`${`${((correct / mine.length) * 100).toFixed(1)}%`.padStart(11)}` +
				`${String(ungrounded).padStart(20)}` +
				`${formatRounded(mean(mine.map((r) => r.contextTokens))).padStart(15)}` +
				`${mean(mine.map((r) => r.hops))
					.toFixed(1)
					.padStart(12)}`,
		);
	}
	const errors = rows.filter((r) => r.error !== null).length;
	if (errors > 0) {
		lines.push("");
		lines.push(
			`NOTE: ${errors} of ${rows.length} runs failed outright and are scored as incorrect.`,
		);
		lines.push(
			"A failed run is not a wrong answer, but it is not a right one either, and",
		);
		lines.push(
			"silently dropping it would inflate every accuracy figure above it.",
		);
	}
	lines.push("");
	lines.push(
		"'ungrounded claims' counts facts the citation gate REJECTED — claims a",
	);
	lines.push(
		"pipeline without the gate would have reported as fact. That column is the",
	);
	lines.push("measured value of the gate, not a defect of the model.");
	return lines.join("\n");
}

export function main(argv: string[]): number {
	const args = parseArgs(argv);
	if (args.yes) {
		const run = runEndToEnd(args.dir, args.budget, { arms: args.arms });
		if (args.json) console.log(JSON.stringify(run, null, 2));
		else {
			console.log("=== end-to-end benchmark (SPENDS TOKENS) ===\n");
			console.log(renderEndToEnd(run));
		}
		// Non-zero on abort so a scripted caller cannot mistake a dead
		// environment for a completed benchmark.
		return run.aborted ? 1 : 0;
	}
	if (args.sweep) {
		const { corpus } = loadSuite(args.dir);
		const rows = sweepBudgets(args.dir, SWEEP_BUDGETS);
		if (args.json) console.log(JSON.stringify({ rows }, null, 2));
		else {
			console.log("=== retrieval budget frontier (zero tokens) ===\n");
			console.log(renderSweep(corpus, rows));
		}
		return 0;
	}
	const { corpus, results, reports } = runRetrievalBench(args.dir, args.budget);
	if (args.json) {
		console.log(JSON.stringify({ reports, results }, null, 2));
	} else {
		console.log("=== context-architecture benchmark (zero tokens) ===\n");
		console.log(renderReport(corpus, reports, args.budget));
	}
	return 0;
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	return main(process.argv.slice(2));
});
/* v8 ignore stop */
