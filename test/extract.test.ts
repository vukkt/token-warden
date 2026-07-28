import { describe, expect, it } from "vitest";
import { type Chunk, chunkDocument, parseDocument } from "../src/corpus.js";
import {
	buildExtractionPrompt,
	extractFromStdout,
	type Fact,
	normalizeForMatch,
	parseFacts,
	valueAppearsIn,
	verifyGrounding,
} from "../src/extract.js";

const chunks: Chunk[] = chunkDocument(
	parseDocument(
		"10k.md",
		"md",
		"# Liquidity\n\nThe Company held cash and cash equivalents of 512.7 and had 420.0 of undrawn capacity.",
	),
);
const chunkId = chunks[0]?.chunkId as string;

function fact(over: Partial<Fact> = {}): Fact {
	return {
		metric: "cash and cash equivalents",
		period: "December 31, 2024",
		value: 512.7,
		unit: "millions",
		currency: "USD",
		chunkId,
		quote: "cash and cash equivalents of 512.7",
		...over,
	};
}

describe("valueAppearsIn", () => {
	it("matches a plain figure", () => {
		expect(valueAppearsIn(512.7, "cash of 512.7 at year end")).toBe(true);
	});

	it("matches across thousands separators", () => {
		expect(valueAppearsIn(4182.6, "revenue was 4,182.6")).toBe(true);
	});

	it("matches a scaled rendering under a units header", () => {
		// A document writing 1.2045 under a "billions" header is the same figure
		// as a model reporting 1204.5 million.
		expect(valueAppearsIn(1204.5, "total of 1.2045 billion")).toBe(true);
	});

	it("matches a trailing-zero variant", () => {
		expect(valueAppearsIn(420, "undrawn capacity of 420.0")).toBe(true);
	});

	it("rejects a number that is merely close", () => {
		// The whole point: a verifier that accepts near misses does not catch
		// the failure it exists for.
		expect(valueAppearsIn(512.8, "cash of 512.7")).toBe(false);
	});

	it("does not match a figure embedded inside a longer number", () => {
		expect(valueAppearsIn(20.4, "the ratio was 120.45")).toBe(false);
	});

	it("requires an explicit sign or accounting parentheses for negatives", () => {
		expect(valueAppearsIn(-500, "a loss of (500)")).toBe(true);
		expect(valueAppearsIn(-500, "a gain of 500")).toBe(false);
	});

	it("matches zero only when zero is written", () => {
		expect(valueAppearsIn(0, "balance of 0 at year end")).toBe(true);
		expect(valueAppearsIn(0, "balance of 512.7")).toBe(false);
	});
});

describe("normalizeForMatch", () => {
	it("folds case and collapses rewrapped whitespace", () => {
		expect(normalizeForMatch("Cash   and\n  Equivalents")).toBe(
			"cash and equivalents",
		);
	});
});

describe("verifyGrounding", () => {
	it("accepts a fact whose quote and value both check out", () => {
		const report = verifyGrounding([fact()], chunks);
		expect(report.accepted).toHaveLength(1);
		expect(report.groundedness).toBe(1);
	});

	it("rejects a citation that does not resolve", () => {
		const report = verifyGrounding([fact({ chunkId: "nope.md#9" })], chunks);
		expect(report.rejected[0]?.reason).toBe("unknown-chunk");
		expect(report.groundedness).toBe(0);
	});

	it("rejects a quote that is not in the cited chunk", () => {
		const report = verifyGrounding(
			[fact({ quote: "cash and cash equivalents of 999.9" })],
			chunks,
		);
		expect(report.rejected[0]?.reason).toBe("quote-not-in-chunk");
	});

	it("rejects a value that is not inside its own quote", () => {
		// The fabrication case: the quote is real, the number attached to it is
		// not. Schema validation cannot see this — a made-up number is a valid
		// number.
		const report = verifyGrounding(
			[fact({ value: 888.8, quote: "cash and cash equivalents of 512.7" })],
			chunks,
		);
		expect(report.rejected[0]?.reason).toBe("value-not-in-quote");
	});

	it("tolerates a quote the model rewrapped across lines", () => {
		const report = verifyGrounding(
			[fact({ quote: "cash and cash\n   equivalents of 512.7" })],
			chunks,
		);
		expect(report.accepted).toHaveLength(1);
	});

	it("reports groundedness 1 for an empty extraction but zero accepted", () => {
		// An empty result must not be able to masquerade as a perfect one, which
		// is why the counts are reported alongside the ratio.
		const report = verifyGrounding([], chunks);
		expect(report.groundedness).toBe(1);
		expect(report.accepted).toHaveLength(0);
	});

	it("splits a mixed batch into accepted and rejected", () => {
		const report = verifyGrounding(
			[fact(), fact({ value: 1.1, quote: "of undrawn capacity" })],
			chunks,
		);
		expect(report.accepted).toHaveLength(1);
		expect(report.rejected).toHaveLength(1);
		expect(report.groundedness).toBeCloseTo(0.5);
	});
});

describe("parseFacts", () => {
	it("parses the documented envelope", () => {
		const r = parseFacts(JSON.stringify({ facts: [fact()] }));
		expect(r.ok && r.facts).toHaveLength(1);
	});

	it("tolerates a bare array", () => {
		const r = parseFacts(JSON.stringify([fact()]));
		expect(r.ok).toBe(true);
	});

	it("tolerates a markdown fence", () => {
		const r = parseFacts("```json\n" + JSON.stringify({ facts: [] }) + "\n```");
		expect(r.ok).toBe(true);
	});

	it("fails closed on non-JSON", () => {
		const r = parseFacts("I could not find that figure.");
		expect(r.ok).toBe(false);
	});

	it("drops a fact with no citation rather than accepting it", () => {
		// An uncitable fact cannot be verified, and an unverified fact is exactly
		// what this module refuses to emit.
		const { chunkId: _omit, ...noCitation } = fact();
		const r = parseFacts(JSON.stringify({ facts: [noCitation] }));
		expect(r.ok).toBe(false);
	});

	it("rejects a non-finite value", () => {
		const r = parseFacts(
			'{"facts":[{"metric":"m","period":"p","value":"NaN","chunkId":"c","quote":"q"}]}',
		);
		expect(r.ok).toBe(false);
	});
});

describe("extractFromStdout", () => {
	it("runs the envelope and fact boundaries in one call", () => {
		const stdout = JSON.stringify({
			result: JSON.stringify({ facts: [fact()] }),
		});
		const r = extractFromStdout(stdout, chunks);
		expect(r.ok && r.report.accepted).toHaveLength(1);
	});

	it("fails closed when the CLI reported an error", () => {
		const r = extractFromStdout(
			JSON.stringify({ is_error: true, result: "quota" }),
			chunks,
		);
		expect(r.ok).toBe(false);
	});

	it("fails closed on empty stdout", () => {
		expect(extractFromStdout("", chunks).ok).toBe(false);
	});
});

describe("buildExtractionPrompt", () => {
	it("demands the citation before the value", () => {
		// Asking for evidence after the claim invites the evidence to be written
		// to fit the claim.
		const p = buildExtractionPrompt("q", "ctx");
		expect(p.indexOf("chunkId")).toBeLessThan(p.indexOf('"value"'));
	});

	it("explicitly licenses an empty answer", () => {
		// A pipeline that cannot decline will always find something, and on a
		// retrieval miss that something is invented.
		expect(buildExtractionPrompt("q", "ctx")).toContain('{"facts":[]}');
	});

	it("embeds the question and the context", () => {
		const p = buildExtractionPrompt(
			"What was revenue?",
			"[c#0] revenue 4,182.6",
		);
		expect(p).toContain("What was revenue?");
		expect(p).toContain("[c#0] revenue 4,182.6");
	});
});
