import { describe, expect, it } from "vitest";
import { type Chunk, chunkDocument, parseDocument } from "../src/corpus.js";
import {
	buildExtractionPrompt,
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

	it("rejects a ROUNDED rendering of the value", () => {
		// Regression, 2026-08-13. The trailing-zero variants were generated with
		// `toFixed(dp)` guarded only by magnitude, which also admitted every
		// rendering the value ROUNDS to — a half-ulp tolerance window inside a
		// verifier whose entire contract is that it has none.
		expect(valueAppearsIn(2.6, "the ratio was 3")).toBe(false);
		expect(valueAppearsIn(2.6, "leverage of 3.0x")).toBe(false);
		expect(valueAppearsIn(3.25, "covenant of 3.3 to 1.00")).toBe(false);
		expect(valueAppearsIn(1204.5, "total of 1205")).toBe(false);
		// Padding is still lossless and still matches; only rounding is refused.
		expect(valueAppearsIn(1.2, "reported 1.20 billion")).toBe(true);
	});

	it("rejects the three false positives the shipped finance suite hit", () => {
		// Each of these was scored as "the answer was retrieved" on the bundled
		// benchmark, and each moved a published recall figure. The matched text is
		// verbatim from benchmarks/finance/corpus.
		// fin-06 wants the 3.25x covenant; matched "3" inside "3.0x".
		expect(
			valueAppearsIn(
				3.25,
				"net total debt to Adjusted EBITDA was 2.6x at December 31, 2024, compared with 3.0x at December 31, 2023.",
			),
		).toBe(false);
		// fin-11 wants the 3.75x maximum; matched "4" inside "4.1 million shares".
		expect(
			valueAppearsIn(
				3.75,
				"During fiscal 2024 the Company repurchased 4.1 million shares of common stock",
			),
		).toBe(false);
		// fin-04 wants a 14.5% margin; matched "15" inside a count of facilities.
		expect(
			valueAppearsIn(
				14.5,
				"our current plan calls for roughly 15 to 18 in fiscal 2025",
			),
		).toBe(false);
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
		// what this module refuses to emit. It is dropped per-fact and counted.
		// This is also the floor the `period` tolerance below must never lower:
		// the schema was loosened for period, NOT for the citation.
		const { chunkId: _omit, ...noCitation } = fact();
		const r = parseFacts(JSON.stringify({ facts: [noCitation] }));
		expect(r.ok && r.facts).toHaveLength(0);
		expect(r.ok && r.malformed).toBe(1);
	});

	it("rejects a non-finite value", () => {
		const r = parseFacts(
			'{"facts":[{"metric":"m","period":"p","value":"NaN","chunkId":"c","quote":"q"}]}',
		);
		expect(r.ok && r.facts).toHaveLength(0);
		expect(r.ok && r.malformed).toBe(1);
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

describe("schema tolerance learned from the first burn", () => {
	it("accepts a fact with NO period — a covenant threshold has none", () => {
		// fin-06 returned period:"" because "Restricted Payments below 3.25 to
		// 1.00" is a standing limit, not a quarterly figure. The old min(1)
		// rejected the whole reply and forced the model to invent a period.
		const r = parseFacts(
			JSON.stringify({
				facts: [{ ...fact(), period: "" }],
			}),
		);
		expect(r.ok && r.facts).toHaveLength(1);
	});

	it("accepts a covenant period stated as a phrase", () => {
		// fin-11 blew the old 60-char bound.
		const long =
			"as of the last day of any fiscal quarter following a Material Acquisition";
		expect(long.length).toBeGreaterThan(60);
		const r = parseFacts(
			JSON.stringify({ facts: [{ ...fact(), period: long }] }),
		);
		expect(r.ok && r.facts[0]?.period).toBe(long);
	});

	it("drops ONE malformed fact instead of discarding the whole reply", () => {
		// The defect: a single over-long field threw away correctly cited
		// figures alongside it. Per-fact validation is the same rule
		// verifyGrounding already applies.
		const r = parseFacts(
			JSON.stringify({ facts: [fact(), { metric: "broken" }, fact()] }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.facts).toHaveLength(2);
			expect(r.malformed).toBe(1);
		}
	});

	it("counts malformed facts separately from ungrounded ones", () => {
		// A shape problem (often ours) must never be hidden inside a
		// hallucination metric.
		const report = verifyGrounding([fact()], chunks, 3);
		expect(report.malformed).toBe(3);
		expect(report.rejected).toHaveLength(0);
		expect(report.groundedness).toBe(1);
	});

	it("rejects a reply that is not a facts envelope at all", () => {
		expect(parseFacts('{"answer":"42"}').ok).toBe(false);
	});
});
