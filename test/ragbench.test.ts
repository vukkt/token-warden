import { describe, expect, it } from "vitest";
import {
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
import { buildIndex } from "../src/retrieve.js";

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
		expect(full?.meanTokens).toBe(
			corpus.chunks.reduce((a, c) => a + c.tokens, 0),
		);
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
		const k = knee(sweepBudgets(SUITE, [200, 400, 600, 1200]), "section");
		expect(k).not.toBeNull();
		expect(k?.budget).toBeLessThan(4474);
	});

	it("reports never when a strategy cannot reach mega-prompt recall", () => {
		// At a budget of 1 token nothing fits, so the knee must be absent rather
		// than silently reported as a small number.
		expect(knee(sweepBudgets(SUITE, [1]), "bm25")).toBeNull();
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
		groundedness: 1,
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
			scoreAnswer(q, { accepted: [], rejected: [], groundedness: 1 }).correct,
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
		const rows = runEndToEnd(SUITE, 600, { spawn });
		const questions = new Set(rows.map((r) => r.questionId));
		for (const arm of ["full", "bm25", "section", "agent"]) {
			expect(rows.filter((r) => r.arm === arm).length).toBe(questions.size);
		}
	});

	it("includes the agentic arm with its hop count", () => {
		const rows = runEndToEnd(SUITE, 600, { spawn });
		const agent = rows.filter((r) => r.arm === "agent");
		expect(agent.length).toBeGreaterThan(0);
		for (const row of agent) expect(row.hops).toBeGreaterThanOrEqual(1);
	});

	it("records a failure reason instead of throwing", () => {
		const rows = runEndToEnd(SUITE, 600, { spawn: () => ({ status: 1 }) });
		expect(rows.every((r) => r.error !== null)).toBe(true);
		expect(rows.every((r) => r.correct === false)).toBe(true);
	});
});

describe("renderEndToEnd", () => {
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
		expect(renderEndToEnd([row()])).toContain("measured value of the gate");
	});

	it("says plainly when runs failed rather than dropping them", () => {
		const text = renderEndToEnd([
			row(),
			row({ error: "boom", correct: false }),
		]);
		expect(text).toContain("1 of 2 runs failed outright");
	});

	it("omits the failure note when nothing failed", () => {
		expect(renderEndToEnd([row()])).not.toContain("failed outright");
	});
});
