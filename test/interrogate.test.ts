import { describe, expect, it } from "vitest";
import { type Corpus, chunkDocument, parseDocument } from "../src/corpus.js";
import {
	backoffMs,
	buildPlanPrompt,
	callClaude,
	classifyFailure,
	type InterrogationResult,
	interrogate,
	MAX_ATTEMPTS,
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

	it("asks the model to decompose the question before deciding", () => {
		// The first real burn returned {"done":true} on hop 1 for all 12 golden
		// questions, because the old prompt ended with "search again ONLY if...".
		// Naming the required parts is what makes the stop/continue decision
		// concrete instead of a default.
		const p = buildPlanPrompt("q", "excerpt", 3);
		expect(p).toContain("what the question REQUIRES");
		expect(p).toContain("more than one fact");
	});

	it("tells the model to search in the missing document's vocabulary", () => {
		// A follow-up phrased in the question's own words re-retrieves what was
		// already read; dedupe then makes the hop informationless but not free.
		expect(buildPlanPrompt("q", "e", 2)).toContain(
			"words the MISSING document would use",
		);
	});

	it("keeps the decline path — an uncovered corpus must still stop", () => {
		// Two of the twelve golden questions are unanswerable. An agent that
		// cannot stop searches four times and then invents.
		expect(buildPlanPrompt("q", "e", 2)).toContain("plainly does not cover");
	});
});

describe("interrogate", () => {
	it("stops as soon as the model says it has enough", () => {
		const { spawn } = scriptedSpawn(['{"done":true}', FACT]);
		const r = interrogate(corpus, "leverage ratio", { spawn, sleep: () => {} });
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
		const r = interrogate(corpus, "Restricted Payments", {
			spawn,
			sleep: () => {},
		});
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
		const r = interrogate(corpus, "anything", { spawn, sleep: () => {} });
		expect(r.hops).toBe(MAX_HOPS);
	});

	it("stops on an invalid plan rather than looping", () => {
		const { spawn } = scriptedSpawn(["not json at all", FACT]);
		const r = interrogate(corpus, "leverage", { spawn, sleep: () => {} });
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
			sleep: () => {},
		});
		const oneHop = interrogate(corpus, "leverage ratio", {
			spawn: once.spawn,
			sleep: () => {},
		});
		expect(twoHop.contextTokens).toBe(oneHop.contextTokens);
	});

	it("fails closed with a reason when the planning call fails", () => {
		const spawn: SpawnLike = () => ({ status: 1 });
		const r = interrogate(corpus, "q", { spawn, sleep: () => {} });
		expect(r.report).toBeNull();
		expect(r.error).toContain("planning call failed");
	});

	it("fails closed when the CLI reports an error envelope", () => {
		const spawn: SpawnLike = () => ({
			status: 0,
			stdout: JSON.stringify({ is_error: true, result: "quota exhausted" }),
		});
		const r = interrogate(corpus, "q", { spawn, sleep: () => {} });
		expect(r.error).toContain("planning call failed");
		// A quota-death envelope must be classed as ENVIRONMENTAL so the caller
		// aborts instead of scoring the run.
		expect(r.environmentFailure).toBe(true);
	});

	it("fails closed when the final answer is not parseable", () => {
		const { spawn } = scriptedSpawn(['{"done":true}', "I could not find it."]);
		const r = interrogate(corpus, "q", { spawn, sleep: () => {} });
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
		const r: InterrogationResult = interrogate(corpus, "q", {
			spawn,
			sleep: () => {},
		});
		expect(r.report?.accepted).toHaveLength(0);
		expect(r.report?.rejected[0]?.reason).toBe("value-not-in-quote");
	});

	it("passes the retrieved excerpts into the planning prompt", () => {
		const { spawn, prompts } = scriptedSpawn(['{"done":true}', FACT]);
		interrogate(corpus, "leverage ratio", { spawn, sleep: () => {} });
		expect(prompts[0]).toContain("2.6x");
	});

	it("honors a caller-supplied hop cap", () => {
		const { spawn } = scriptedSpawn(['{"search":"a"}', '{"search":"b"}', FACT]);
		const r = interrogate(corpus, "q", { spawn, maxHops: 2, sleep: () => {} });
		expect(r.hops).toBe(2);
	});
});

describe("classifyFailure", () => {
	it("flags a known rate-limit signature", () => {
		expect(
			classifyFailure(1, "API Error 429 rate limit exceeded", undefined)
				.environmental,
		).toBe(true);
	});

	it("flags a silent non-zero exit as environmental", () => {
		// The third agent burn: 6 of 12 calls died as "exited 1 with no stderr"
		// and the guard stayed silent, so the run neither retried nor aborted and
		// produced a half-empty table that looked like a measurement. A CLI
		// rejecting a bad request says so; silence plus non-zero is infra.
		const f = classifyFailure(1, "", undefined);
		expect(f.environmental).toBe(true);
		expect(f.reason).toContain("no stderr");
	});

	it("does NOT flag a real error message as environmental", () => {
		// A genuine defect must never be laundered into "the environment died".
		expect(
			classifyFailure(1, "unknown option --frobnicate", undefined)
				.environmental,
		).toBe(false);
	});

	it("does not flag a clean exit with no stderr", () => {
		expect(classifyFailure(0, "", undefined).environmental).toBe(false);
	});

	it("carries the stderr head so a failure is diagnosable", () => {
		expect(classifyFailure(2, "boom happened", undefined).reason).toContain(
			"boom happened",
		);
	});
});

describe("backoffMs", () => {
	it("grows exponentially so a transient limit gets time to clear", () => {
		expect(backoffMs(1)).toBe(2000);
		expect(backoffMs(2)).toBe(4000);
		expect(backoffMs(1)).toBeLessThan(backoffMs(2));
	});
});

describe("callClaude retry", () => {
	it("retries an environmental failure up to MAX_ATTEMPTS", () => {
		let calls = 0;
		const spawn: SpawnLike = () => {
			calls++;
			return { status: 1, stderr: "429 rate limit" };
		};
		const r = callClaude(spawn, "p", () => {});
		expect(r.ok).toBe(false);
		expect(calls).toBe(MAX_ATTEMPTS);
	});

	it("does NOT retry a genuine bad request", () => {
		// Retrying an argument error fails identically three times and only
		// wastes wall-clock.
		let calls = 0;
		const spawn: SpawnLike = () => {
			calls++;
			return { status: 1, stderr: "unknown option --nope" };
		};
		callClaude(spawn, "p", () => {});
		expect(calls).toBe(1);
	});

	it("returns the first success without further attempts", () => {
		let calls = 0;
		const spawn: SpawnLike = () => {
			calls++;
			if (calls === 1) return { status: 1, stderr: "529 overloaded" };
			return { status: 0, stdout: JSON.stringify({ result: "hi" }) };
		};
		const r = callClaude(spawn, "p", () => {});
		expect(r.ok && r.text).toBe("hi");
		expect(calls).toBe(2);
	});
});
