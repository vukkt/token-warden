import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/corpus.js";
import type { SpawnLike } from "../src/interrogate.js";
import {
	ENV_FAILURE_STREAK,
	knee,
	loadSuite,
	main,
	parseArgs,
	type Question,
	renderEndToEnd,
	renderReport,
	renderSweep,
	runEndToEnd,
	runRetrievalBench,
	scoreAnswer,
	scoreRetrieval,
	summarize,
	sweepBudgets,
} from "../src/ragbench.js";
import { buildIndex, renderContext, retrieve } from "../src/retrieve.js";

const SUITE = "benchmarks/finance";

function question(over: Partial<Question> = {}): Question {
	return {
		id: "q",
		type: "single-hop",
		question: "What was consolidated revenue in fiscal 2024?",
		expect: { value: 4182.6, unit: "millions", period: "fiscal 2024" },
		mustCiteDoc: "northwind-10k-2024.md",
		requiresDocs: [],
		expectEmpty: false,
		expectConflict: false,
		why: "",
		...over,
	};
}

describe("loadSuite", () => {
	it("loads the shipped finance corpus and questions", () => {
		const { corpus, questions } = loadSuite(SUITE);
		expect(corpus.documents.length).toBe(5);
		expect(questions.length).toBeGreaterThanOrEqual(12);
	});

	it("ingests every shipped format", () => {
		const formats = new Set(
			loadSuite(SUITE).corpus.documents.map((d) => d.format),
		);
		expect(formats).toEqual(new Set(["md", "txt", "csv", "html"]));
	});

	it("does not index the script block in the credit agreement", () => {
		// The HTML fixture carries a tracking id inside <script> precisely to
		// prove it never reaches the lexical index.
		const { corpus } = loadSuite(SUITE);
		const html = corpus.documents.find((d) => d.format === "html");
		expect(html?.text).not.toContain("should-never-be-indexed");
	});

	it("splits the heading-free transcript into many chunks", () => {
		// A failure of the ALL-CAPS heuristic shows up as the whole transcript
		// arriving as a single chunk.
		const { corpus } = loadSuite(SUITE);
		const transcript = corpus.chunks.filter((c) => c.docId.endsWith(".txt"));
		expect(transcript.length).toBeGreaterThan(5);
	});
});

describe("scoreRetrieval", () => {
	const { corpus } = loadSuite(SUITE);
	const index = buildIndex(corpus.chunks);

	it("finds the answer to a single-hop question", () => {
		const r = scoreRetrieval("bm25", corpus, index, question(), 2000);
		expect(r.answerBearing).toBe(true);
		expect(r.citedDocPresent).toBe(true);
	});

	it("scores an unanswerable question as distractor exposure, not recall", () => {
		const r = scoreRetrieval(
			"bm25",
			corpus,
			index,
			question({
				question: "What was customer churn in fiscal 2024?",
				expect: { value: null, unit: "", period: "" },
				expectEmpty: true,
				mustCiteDoc: null,
			}),
			2000,
		);
		expect(r.answerBearing).toBeNull();
		// Retrieval still returns the customer-concentration section; that is the
		// exposure that makes a model fabricate.
		expect(r.distractorOnly).toBe(true);
	});

	it("requires every listed document for a cross-document question", () => {
		const r = scoreRetrieval(
			"full",
			corpus,
			index,
			question({
				requiresDocs: [
					"northwind-credit-agreement.html",
					"northwind-10k-2024.md",
				],
				mustCiteDoc: null,
			}),
			2000,
		);
		expect(r.citedDocPresent).toBe(true);
	});

	it("misses when the budget is too small to reach the answer", () => {
		const r = scoreRetrieval("bm25", corpus, index, question(), 20);
		expect(r.answerBearing).toBe(false);
	});

	it("never exceeds the budget it was given", () => {
		for (const budget of [100, 500, 2000]) {
			expect(
				scoreRetrieval("bm25", corpus, index, question(), budget).tokens,
			).toBeLessThanOrEqual(budget);
		}
	});

	it("reports exactly what it sends, on every arm", () => {
		// The gap this replaces was pinned on 2026-08-14 and closed on 2026-08-15.
		// `tokens` summed chunk bodies while the prompt was renderContext(), whose
		// per-chunk citation label is load-bearing and was unpriced: 17.6-20.8%
		// across arms. Both now derive from `renderChunk`, so equality here is
		// structural rather than lucky — but assert it anyway, because that single
		// source of truth is exactly the kind of thing a later edit splits again.
		const { questions } = loadSuite(SUITE);
		for (const strategy of ["full", "bm25", "section"] as const) {
			for (const q of questions) {
				const r = retrieve(strategy, corpus, index, q.question, 1200);
				expect(r.tokens).toBe(estimateTokens(renderContext(r)));
			}
		}
	});

	it("treats the budget as a real bound on the assembled context", () => {
		// The consequence of the old undercount: the packer measured bodies, so
		// the context it assembled exceeded its stated budget on 12 of 12
		// questions in BOTH budgeted arms. `full` is exempt by construction - it
		// ignores the budget, and reporting its cost against the others is the
		// entire comparison.
		const { questions } = loadSuite(SUITE);
		for (const budget of [200, 600, 1200]) {
			for (const strategy of ["bm25", "section"] as const) {
				for (const q of questions) {
					const r = retrieve(strategy, corpus, index, q.question, budget);
					expect(estimateTokens(renderContext(r))).toBeLessThanOrEqual(budget);
				}
			}
		}
	});
});

describe("summarize", () => {
	it("reports infinite tokens-per-answer when nothing was found", () => {
		// The honest rendering of "spent tokens, produced nothing".
		const reports = summarize([
			{
				questionId: "q",
				strategy: "bm25",
				tokens: 500,
				answerBearing: false,
				distractorOnly: false,
				citedDocPresent: false,
			},
		]);
		expect(reports[0]?.tokensPerAnswer).toBe(Number.POSITIVE_INFINITY);
		expect(reports[0]?.recall).toBe(0);
	});

	it("reports doc recall as null when no question names a document", () => {
		const reports = summarize([
			{
				questionId: "q",
				strategy: "full",
				tokens: 10,
				answerBearing: true,
				distractorOnly: false,
				citedDocPresent: null,
			},
		]);
		expect(reports[0]?.docRecall).toBeNull();
	});

	it("omits a strategy with no rows rather than emitting a zero row", () => {
		expect(summarize([]).length).toBe(0);
	});
});

describe("runRetrievalBench on the shipped suite", () => {
	const { corpus, reports } = runRetrievalBench(SUITE, 2000);

	it("gives the mega-prompt arm perfect recall by construction", () => {
		// `full` retrieves everything, so it can never miss. Its cost is the
		// point, not its recall.
		expect(reports.find((r) => r.strategy === "full")?.recall).toBe(1);
	});

	it("costs the mega-prompt the whole corpus on every question", () => {
		const full = reports.find((r) => r.strategy === "full");
		// The whole corpus AS RENDERED - bodies plus the citation labels the
		// pipeline actually sends. Strictly more than the sum of bodies, and that
		// difference is the undercount corrected on 2026-08-15.
		const bodies = corpus.chunks.reduce((a, c) => a + c.tokens, 0);
		expect(full?.meanTokens).toBeGreaterThan(bodies);
		expect(full?.meanTokens).toBe(5648);
	});

	it("makes retrieval strictly cheaper per question", () => {
		const full = reports.find((r) => r.strategy === "full")?.meanTokens ?? 0;
		const bm = reports.find((r) => r.strategy === "bm25")?.meanTokens ?? 0;
		expect(bm).toBeLessThan(full);
	});

	it("counts the unanswerable questions as distractor exposure", () => {
		expect(reports.find((r) => r.strategy === "bm25")?.distractors).toBe(2);
	});
});

describe("sweepBudgets", () => {
	const rows = sweepBudgets(SUITE, [200, 400, 800]);

	it("recall is monotone non-decreasing in budget", () => {
		// More context can only add answers, never remove them. A violation means
		// the budget packer is dropping a chunk it previously kept.
		for (const strategy of ["bm25", "section"] as const) {
			const series = rows
				.filter((r) => r.strategy === strategy)
				.sort((a, b) => a.budget - b.budget)
				.map((r) => r.recall);
			for (let i = 1; i < series.length; i++) {
				expect(series[i] as number).toBeGreaterThanOrEqual(
					series[i - 1] as number,
				);
			}
		}
	});

	it("finds a knee below the corpus size", () => {
		const k = knee(sweepBudgets(SUITE, [200, 400, 600, 1200, 1400]), "section");
		expect(k).not.toBeNull();
		// Against the RENDERED corpus, which is what the mega-prompt arm now
		// costs; comparing a rendered knee to an unrendered corpus size was
		// mixing two accountings.
		expect(k?.budget).toBeLessThan(5648);
	});

	it("reports never when a strategy cannot reach mega-prompt recall", () => {
		// At a budget of 1 token nothing fits, so the knee must be absent rather
		// than silently reported as a small number.
		expect(knee(sweepBudgets(SUITE, [1]), "bm25")).toBeNull();
	});

	it("pins the PUBLISHED knee for the bundled suite", () => {
		// Added 2026-08-13. Nothing pinned this before, which is how the v0.42.0
		// headline (`section` at 400 tokens, 11.2x) survived to the README while
		// resting on a rounding hole in `valueAppearsIn`. Re-pinned 2026-08-15
		// when the token accounting was corrected to price the assembled prompt
		// rather than the chunk bodies: the knee moves 1,200 -> 1,400 tokens for
		// BOTH lexical strategies. Any change to the scorer, the chunker, the
		// packer or the corpus that moves these must move the published figures
		// in the same commit.
		const rows = sweepBudgets(SUITE, [200, 400, 600, 800, 1200, 1400, 2400]);
		for (const strategy of ["bm25", "section"] as const) {
			expect(knee(rows, strategy)?.budget).toBe(1400);
		}
		const at = (strategy: string, budget: number): number =>
			(rows.find((r) => r.strategy === strategy && r.budget === budget)
				?.recall ?? -1) * 100;
		// The knee is real: recall is still far from complete well below it. The
		// floor moved 22% -> 11% because 200 tokens no longer buys 200 tokens of
		// bodies plus unpriced labels.
		expect(Math.round(at("bm25", 200))).toBe(11);
		expect(Math.round(at("section", 200))).toBe(11);
		// `section` does not beat `bm25`. The v0.42.0 claim that it did was an
		// artifact of the scorer; with honest pricing the two are indistinguishable
		// on recall at every swept budget, and `bm25` is marginally cheaper at the
		// knee (1,280.5 vs 1,307.8 tokens/question), which is the opposite of the
		// original claim.
		for (const budget of [200, 400, 600, 800, 1200, 1400]) {
			expect(at("section", budget)).toBe(at("bm25", budget));
		}
	});

	it("pins the PUBLISHED mega-prompt ratio", () => {
		// The headline: what the whole corpus costs per question, against what the
		// retrieval pipeline costs at the knee. 11.2x was a scorer artifact; 3.7x
		// was measured but priced only the chunk bodies. Both sides are now priced
		// on the assembled prompt, which is the only basis on which the comparison
		// means anything.
		const rows = sweepBudgets(SUITE, [200, 400, 600, 800, 1200, 1400, 2400]);
		const full = rows.find((r) => r.strategy === "full");
		const kneeRow = knee(rows, "bm25");
		expect(full?.meanTokens).toBe(5648);
		expect(kneeRow?.meanTokens).toBeCloseTo(1280.5, 1);
		const ratio = (full?.meanTokens ?? 0) / (kneeRow?.meanTokens ?? 1);
		expect(ratio).toBeCloseTo(4.41, 1);
	});
});

describe("parseArgs", () => {
	it("defaults to a stated budget rather than an implicit one", () => {
		expect(parseArgs([]).budget).toBe(2000);
		expect(parseArgs([]).sweep).toBe(false);
	});

	it("accepts the documented flags", () => {
		const a = parseArgs([
			"--budget",
			"500",
			"--sweep",
			"--json",
			"--dir",
			"/x",
		]);
		expect(a).toMatchObject({
			budget: 500,
			sweep: true,
			json: true,
			dir: "/x",
		});
	});

	it("rejects a non-positive budget", () => {
		expect(() => parseArgs(["--budget", "0"])).toThrow(/positive integer/);
		expect(() => parseArgs(["--budget", "abc"])).toThrow(/positive integer/);
	});

	it("accepts --arm for a subset run and rejects an unknown arm", () => {
		expect(parseArgs(["--arm", "agent"]).arms).toEqual(["agent"]);
		expect(parseArgs(["--arm", "bm25", "--arm", "full"]).arms).toEqual([
			"bm25",
			"full",
		]);
		expect(() => parseArgs(["--arm", "embeddings"])).toThrow(/--arm must be/);
	});

	it("defaults to every arm when --arm is absent", () => {
		expect(parseArgs([]).arms).toEqual([]);
	});

	it("rejects an unknown flag rather than ignoring it", () => {
		expect(() => parseArgs(["--embeddings"])).toThrow(/unknown flag/);
	});
});

describe("rendering", () => {
	it("renders the comparison table with the budget stated in the header", () => {
		const { corpus, reports } = runRetrievalBench(SUITE, 2000);
		const text = renderReport(corpus, reports, 2000);
		expect(text).toContain("retrieval budget: 2,000 tokens/question");
		expect(text).toContain("mega-prompt costs");
	});

	it("renders the sweep with its generalization caveat", () => {
		const { corpus } = loadSuite(SUITE);
		const text = renderSweep(corpus, sweepBudgets(SUITE, [400, 800]));
		expect(text).toContain("answer recall vs retrieval budget");
		expect(text).toContain("FLOOR for a real document set");
	});
});

describe("main", () => {
	it("exits 0 in table mode", () => {
		expect(main(["--dir", SUITE])).toBe(0);
	});

	it("exits 0 in sweep mode", () => {
		expect(main(["--dir", SUITE, "--sweep"])).toBe(0);
	});

	it("emits parseable JSON in both modes", () => {
		for (const argv of [["--json"], ["--json", "--sweep"]]) {
			const lines: string[] = [];
			const original = console.log;
			console.log = (s: string) => lines.push(s);
			try {
				main(["--dir", SUITE, ...argv]);
			} finally {
				console.log = original;
			}
			expect(() => JSON.parse(lines.join("\n"))).not.toThrow();
		}
	});
});

describe("scoreAnswer", () => {
	const grounded = (value: number) => ({
		accepted: [
			{
				metric: "m",
				period: "p",
				value,
				unit: "",
				currency: "",
				chunkId: "c#0",
				quote: "q",
			},
		],
		rejected: [],
		malformed: 0,
		groundedness: 1,
	});

	const citing = (...chunkIds: string[]) => ({
		accepted: chunkIds.map((chunkId, i) => ({
			metric: "operating margin",
			period: "fiscal 2024",
			value: 14.5 + i,
			unit: "%",
			currency: "",
			chunkId,
			quote: "q",
		})),
		rejected: [],
		malformed: 0,
		groundedness: 1,
	});

	const conflictQuestion = () =>
		question({
			expectConflict: true,
			expect: { value: null, unit: "", period: "fiscal 2024" },
		});

	it("credits a conflict answer only when BOTH sources are cited", () => {
		// Implemented 2026-08-20. Until then `expectConflict` was inert: the
		// branch was reached via a null expected value and scored
		// `accepted.length > 0`, so one grounded fact passed.
		expect(
			scoreAnswer(conflictQuestion(), citing("10k.md#3", "segments.md#1"))
				.correct,
		).toBe(true);
	});

	it("refuses the exact failure the conflict question exists to detect", () => {
		// Quoting one source and silently ignoring the other. The old scorer
		// marked this CORRECT, which made the row measure the model's willingness
		// to emit output rather than its handling of disagreement.
		expect(scoreAnswer(conflictQuestion(), citing("10k.md#3")).correct).toBe(
			false,
		);
		expect(
			scoreAnswer(conflictQuestion(), citing("10k.md#3", "10k.md#7")).correct,
		).toBe(false);
	});

	it("refuses a conflict answer with nothing grounded", () => {
		expect(
			scoreAnswer(conflictQuestion(), {
				accepted: [],
				rejected: [],
				malformed: 0,
				groundedness: 1,
			}).correct,
		).toBe(false);
	});

	it("credits an answer matching the expected value", () => {
		expect(scoreAnswer(question(), grounded(4182.6)).correct).toBe(true);
	});

	it("does not credit a near miss", () => {
		expect(scoreAnswer(question(), grounded(4182.7)).correct).toBe(false);
	});

	it("scores an unanswerable question inversely", () => {
		// Correct means the pipeline DECLINED. Without this, a benchmark rewards
		// a model for always producing something.
		const q = question({
			expectEmpty: true,
			expect: { value: null, unit: "", period: "" },
		});
		expect(
			scoreAnswer(q, {
				accepted: [],
				rejected: [],
				malformed: 0,
				groundedness: 1,
			}).correct,
		).toBe(true);
		expect(scoreAnswer(q, grounded(4150)).correct).toBe(false);
	});

	it("counts a failed run as incorrect rather than skipping it", () => {
		expect(scoreAnswer(question(), null).correct).toBe(false);
	});

	it("reports how many claims the citation gate threw out", () => {
		const report = {
			accepted: [],
			rejected: [
				{
					fact: {
						metric: "m",
						period: "p",
						value: 1,
						unit: "",
						currency: "",
						chunkId: "x",
						quote: "q",
					},
					reason: "unknown-chunk" as const,
				},
			],
			malformed: 0,
			groundedness: 0,
		};
		expect(scoreAnswer(question(), report).ungrounded).toBe(1);
	});
});

describe("runEndToEnd", () => {
	/** A fake `claude` that always returns one grounded fact for the first
	 * chunk it is shown, so the loop can be exercised without tokens. */
	const spawn = (_c: string, args: string[]) => {
		const prompt = args[1] ?? "";
		if (prompt.includes("search(es) left")) {
			return { status: 0, stdout: JSON.stringify({ result: '{"done":true}' }) };
		}
		const id = /\[([^\]]+)\]/.exec(prompt)?.[1];
		const quote = /\[[^\]]+\][^\n]*\n(.{0,40})/.exec(prompt)?.[1] ?? "";
		return {
			status: 0,
			stdout: JSON.stringify({
				result: JSON.stringify({
					facts:
						id === undefined
							? []
							: [
									{
										chunkId: id,
										quote,
										metric: "m",
										period: "p",
										value: 0,
										unit: "",
										currency: "",
									},
								],
				}),
			}),
		};
	};

	it("runs every arm against every question, paired", () => {
		const { rows } = runEndToEnd(SUITE, 600, { spawn, sleep: () => {} });
		const questions = new Set(rows.map((r) => r.questionId));
		for (const arm of ["full", "bm25", "section", "agent"]) {
			expect(rows.filter((r) => r.arm === arm).length).toBe(questions.size);
		}
	});

	it("runs only the requested arm when --arm is given", () => {
		const { rows } = runEndToEnd(SUITE, 600, {
			spawn,
			sleep: () => {},
			arms: ["agent"],
		});
		expect(new Set(rows.map((r) => r.arm))).toEqual(new Set(["agent"]));
	});

	it("includes the agentic arm with its hop count", () => {
		const { rows } = runEndToEnd(SUITE, 600, { spawn, sleep: () => {} });
		const agent = rows.filter((r) => r.arm === "agent");
		expect(agent.length).toBeGreaterThan(0);
		for (const row of agent) expect(row.hops).toBeGreaterThanOrEqual(1);
	});

	it("records a failure reason instead of throwing", () => {
		const { rows } = runEndToEnd(SUITE, 600, {
			spawn: () => ({ status: 1 }),
			sleep: () => {},
		});
		expect(rows.every((r) => r.error !== null)).toBe(true);
		expect(rows.every((r) => r.correct === false)).toBe(true);
	});

	it("does NOT abort on non-environmental failures", () => {
		// An unparseable reply is a result, not a dead API. Aborting on it would
		// discard a real (bad) measurement.
		const { aborted } = runEndToEnd(SUITE, 600, {
			spawn: () => ({ status: 1, stderr: "malformed flag" }),
			sleep: () => {},
		});
		expect(aborted).toBe(false);
	});

	it("ABORTS after a streak of environment failures", () => {
		// The defect this guard exists for: the first real burn hit a rate limit
		// at question 5, failed every remaining call, and reported "33.3%
		// accuracy" for all four arms -- 4 of 12 correct because 8 of 12 never
		// ran.
		const run = runEndToEnd(SUITE, 600, {
			spawn: () => ({ status: 1, stderr: "API Error 429 rate limit exceeded" }),
			sleep: () => {},
		});
		expect(run.aborted).toBe(true);
		expect(run.rows.length).toBe(ENV_FAILURE_STREAK);
		expect(run.abortReason).toContain("consecutive environment failures");
	});

	it("a success resets the environment-failure streak", () => {
		// Three failures then a success must not abort -- transient flakiness is
		// not a dead environment.
		let n = 0;
		const flaky: SpawnLike = () => {
			n++;
			if (n % 4 !== 0) return { status: 1, stderr: "429 rate limit" };
			return {
				status: 0,
				stdout: JSON.stringify({ result: JSON.stringify({ facts: [] }) }),
			};
		};
		expect(
			runEndToEnd(SUITE, 600, { spawn: flaky, sleep: () => {} }).aborted,
		).toBe(false);
	});
});

describe("renderEndToEnd", () => {
	it("REFUSES to print an accuracy table for an aborted run", () => {
		// A percentage computed over calls that never reached the model is
		// indistinguishable in shape from a real one, and far more persuasive
		// than it is true.
		const text = renderEndToEnd({
			rows: [
				{
					questionId: "q",
					arm: "bm25",
					contextTokens: 500,
					correct: true,
					ungrounded: 0,
					hops: 1,
					error: null,
				},
			],
			aborted: true,
			abortReason: "4 consecutive environment failures (last: 429).",
		});
		expect(text).toContain("ABORTED — no verdict");
		// No table header and no percentage anywhere: the prose may discuss
		// accuracy, but no NUMBER may be presented as one.
		expect(text).not.toContain("arm          questions");
		expect(text).not.toContain("%");
	});

	const row = (over: Record<string, unknown> = {}) => ({
		questionId: "q",
		arm: "bm25",
		contextTokens: 500,
		correct: true,
		ungrounded: 0,
		hops: 1,
		error: null,
		...over,
	});

	it("explains that ungrounded claims measure the gate, not the model", () => {
		expect(
			renderEndToEnd({ rows: [row()], aborted: false, abortReason: null }),
		).toContain("measured value of the gate");
	});

	it("says plainly when runs failed rather than dropping them", () => {
		const text = renderEndToEnd({
			rows: [row(), row({ error: "boom", correct: false })],
			aborted: false,
			abortReason: null,
		});
		expect(text).toContain("1 of 2 runs failed outright");
	});

	it("omits the failure note when nothing failed", () => {
		expect(
			renderEndToEnd({ rows: [row()], aborted: false, abortReason: null }),
		).not.toContain("failed outright");
	});
});
