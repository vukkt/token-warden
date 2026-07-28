import { describe, expect, it } from "vitest";
import { type Corpus, chunkDocument, parseDocument } from "../src/corpus.js";
import {
	buildPlanPrompt,
	type InterrogationResult,
	interrogate,
	MAX_HOPS,
	parsePlan,
	type SpawnLike,
} from "../src/interrogate.js";

/** A two-document corpus with no shared vocabulary between the halves — the
 * multi-hop case in miniature. */
const corpus: Corpus = (() => {
	const covenant = parseDocument(
		"covenant.md",
		"md",
		"# Restricted Payments\n\nThe Borrower may make Restricted Payments so long as the Consolidated Leverage Ratio does not exceed 3.25 to 1.00.",
	);
	const filing = parseDocument(
		"filing.md",
		"md",
		"# Liquidity\n\nThe ratio of total debt to Adjusted EBITDA was 2.6x at December 31, 2024.",
	);
	return {
		root: "/x",
		documents: [covenant, filing],
		chunks: [...chunkDocument(covenant), ...chunkDocument(filing)],
	};
})();

/** Build a fake `claude` that replies with a scripted sequence. Each element is
 * the `result` string of one envelope; the queue is consumed in order. */
function scriptedSpawn(replies: string[]): {
	spawn: SpawnLike;
	prompts: string[];
} {
	const prompts: string[] = [];
	const queue = [...replies];
	const spawn: SpawnLike = (_command, args) => {
		prompts.push(args[1] ?? "");
		const next = queue.shift();
		if (next === undefined) return { status: 1 };
		return { status: 0, stdout: JSON.stringify({ result: next }) };
	};
	return { spawn, prompts };
}

const FACT = JSON.stringify({
	facts: [
		{
			chunkId: "filing.md#0",
			quote: "was 2.6x at December 31, 2024",
			metric: "leverage",
			period: "December 31, 2024",
			value: 2.6,
			unit: "x",
			currency: "",
		},
	],
});

describe("parsePlan", () => {
	it("reads a search instruction", () => {
		expect(parsePlan('{"search":"leverage ratio"}')).toEqual({
			kind: "search",
			query: "leverage ratio",
		});
	});

	it("reads a done instruction", () => {
		expect(parsePlan('{"done":true}').kind).toBe("answer");
	});

	it("tolerates a markdown fence", () => {
		expect(parsePlan('```json\n{"done":true}\n```').kind).toBe("answer");
	});

	it("treats an unparseable reply as invalid rather than guessing", () => {
		// A misparsed control reply would silently turn a bounded loop into an
		// unbounded one.
		expect(parsePlan("let me search for the covenant").kind).toBe("invalid");
		expect(parsePlan("null").kind).toBe("invalid");
		expect(parsePlan('{"search":"   "}').kind).toBe("invalid");
	});

	it("bounds an over-long query", () => {
		const plan = parsePlan(JSON.stringify({ search: "x".repeat(5000) }));
		expect(plan.kind === "search" && plan.query.length).toBe(400);
	});
});

describe("buildPlanPrompt", () => {
	it("says how many searches remain so the model can budget", () => {
		expect(buildPlanPrompt("q", "excerpt", 2)).toContain("2 search(es) left");
	});

	it("marks an empty context explicitly rather than leaving a blank", () => {
		expect(buildPlanPrompt("q", "", 3)).toContain("(nothing yet)");
	});
});

describe("interrogate", () => {
	it("stops as soon as the model says it has enough", () => {
		const { spawn } = scriptedSpawn(['{"done":true}', FACT]);
		const r = interrogate(corpus, "leverage ratio", { spawn });
		expect(r.hops).toBe(1);
		expect(r.error).toBeNull();
		expect(r.report?.accepted).toHaveLength(1);
	});

	it("issues a follow-up query it could not have written first", () => {
		// The entire justification for this architecture.
		const { spawn } = scriptedSpawn([
			'{"search":"debt to Adjusted EBITDA"}',
			'{"done":true}',
			FACT,
		]);
		const r = interrogate(corpus, "Restricted Payments", { spawn });
		expect(r.queries).toEqual([
			"Restricted Payments",
			"debt to Adjusted EBITDA",
		]);
		expect(r.hops).toBe(2);
	});

	it("never exceeds the hop cap even if the model always asks to search", () => {
		// Cost control: an agent that has not converged is looping, and each hop
		// is a paid model call.
		const { spawn } = scriptedSpawn([
			...Array(20).fill('{"search":"more"}'),
			FACT,
		]);
		const r = interrogate(corpus, "anything", { spawn });
		expect(r.hops).toBe(MAX_HOPS);
	});

	it("stops on an invalid plan rather than looping", () => {
		const { spawn } = scriptedSpawn(["not json at all", FACT]);
		const r = interrogate(corpus, "leverage", { spawn });
		expect(r.hops).toBe(1);
		expect(r.error).toBeNull();
	});

	it("does not pay twice for a chunk it already read", () => {
		// Without dedupe, an agent that repeats a query is billed for the same
		// context on every hop.
		const repeated = scriptedSpawn([
			'{"search":"leverage ratio"}',
			'{"done":true}',
			FACT,
		]);
		const once = scriptedSpawn(['{"done":true}', FACT]);
		const twoHop = interrogate(corpus, "leverage ratio", {
			spawn: repeated.spawn,
		});
		const oneHop = interrogate(corpus, "leverage ratio", { spawn: once.spawn });
		expect(twoHop.contextTokens).toBe(oneHop.contextTokens);
	});

	it("fails closed with a reason when the planning call fails", () => {
		const spawn: SpawnLike = () => ({ status: 1 });
		const r = interrogate(corpus, "q", { spawn });
		expect(r.report).toBeNull();
		expect(r.error).toBe("planning call failed");
	});

	it("fails closed when the CLI reports an error envelope", () => {
		const spawn: SpawnLike = () => ({
			status: 0,
			stdout: JSON.stringify({ is_error: true, result: "quota exhausted" }),
		});
		const r = interrogate(corpus, "q", { spawn });
		expect(r.error).toBe("planning call failed");
	});

	it("fails closed when the final answer is not parseable", () => {
		const { spawn } = scriptedSpawn(['{"done":true}', "I could not find it."]);
		const r = interrogate(corpus, "q", { spawn });
		expect(r.report).toBeNull();
		expect(r.error).toContain("not JSON");
	});

	it("rejects an ungrounded fact from the agent just as the single-shot path does", () => {
		// The agent arm gets no exemption from the citation gate.
		const fabricated = JSON.stringify({
			facts: [
				{
					chunkId: "filing.md#0",
					quote: "was 2.6x at December 31, 2024",
					metric: "leverage",
					period: "2024",
					value: 9.9,
					unit: "x",
					currency: "",
				},
			],
		});
		const { spawn } = scriptedSpawn(['{"done":true}', fabricated]);
		const r: InterrogationResult = interrogate(corpus, "q", { spawn });
		expect(r.report?.accepted).toHaveLength(0);
		expect(r.report?.rejected[0]?.reason).toBe("value-not-in-quote");
	});

	it("passes the retrieved excerpts into the planning prompt", () => {
		const { spawn, prompts } = scriptedSpawn(['{"done":true}', FACT]);
		interrogate(corpus, "leverage ratio", { spawn });
		expect(prompts[0]).toContain("2.6x");
	});

	it("honors a caller-supplied hop cap", () => {
		const { spawn } = scriptedSpawn(['{"search":"a"}', '{"search":"b"}', FACT]);
		const r = interrogate(corpus, "q", { spawn, maxHops: 2 });
		expect(r.hops).toBe(2);
	});
});
