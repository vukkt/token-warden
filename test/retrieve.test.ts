import { describe, expect, it } from "vitest";
import {
	type Chunk,
	chunkDocument,
	estimateTokens,
	parseDocument,
} from "../src/corpus.js";
import {
	bm25,
	buildIndex,
	renderContext,
	retrieve,
	retrieveBm25,
	retrieveFull,
	retrieveSection,
	tokenize,
} from "../src/retrieve.js";

function chunksOf(text: string, docId = "d.md"): Chunk[] {
	return chunkDocument(parseDocument(docId, "md", text));
}

describe("tokenize", () => {
	it("keeps numbers with separators intact", () => {
		// The single most important behavior for financial text: a shattered
		// number matches every document containing the digit 5.
		expect(tokenize("revenue was 1,204.5")).toContain("1,204.5");
		expect(tokenize("we filed a 10-K")).toContain("10-k");
	});

	it("keeps years distinct so period traps stay separable", () => {
		const t = tokenize("fiscal 2024 versus fiscal 2023");
		expect(t).toContain("2024");
		expect(t).toContain("2023");
	});

	it("strips edge punctuation but not internal separators", () => {
		expect(tokenize("(revenue), 1,204.5.")).toEqual(["revenue", "1,204.5"]);
	});

	it("drops bare currency and percent symbols", () => {
		expect(tokenize("$ % cash")).toEqual(["cash"]);
	});
});

describe("bm25", () => {
	const chunks = chunksOf(
		"# Liquidity\n\ncash and cash equivalents of 512.7\n\n# Fuel\n\ndiesel was 14.6% of cost",
	);
	const index = buildIndex(chunks);

	it("ranks the section containing the query terms first", () => {
		expect(bm25(index, "diesel cost")[0]?.chunk.text).toContain("diesel");
	});

	it("returns nothing when no term matches", () => {
		expect(bm25(index, "zzzznomatch")).toEqual([]);
	});

	it("never assigns a negative score to a matching chunk", () => {
		// The textbook IDF goes negative for terms in over half the corpus, which
		// would make common terms penalize the documents containing them.
		for (const s of bm25(index, "cash")) expect(s.score).toBeGreaterThan(0);
	});

	it("orders deterministically when scores tie", () => {
		const a = bm25(index, "cash").map((s) => s.chunk.chunkId);
		const b = bm25(buildIndex([...chunks].reverse()), "cash").map(
			(s) => s.chunk.chunkId,
		);
		expect(a).toEqual(b);
	});

	it("handles an empty index", () => {
		expect(bm25(buildIndex([]), "anything")).toEqual([]);
	});
});

describe("budgeting", () => {
	const chunks = chunksOf(
		`# A\n\n${"alpha ".repeat(200)}\n\n# B\n\n${"beta ".repeat(200)}`,
	);
	const index = buildIndex(chunks);

	it("never exceeds the token budget", () => {
		for (const budget of [50, 100, 200, 400]) {
			expect(
				retrieveBm25(index, "alpha beta", budget).tokens,
			).toBeLessThanOrEqual(budget);
		}
	});

	it("counts what it dropped for budget", () => {
		const r = retrieveBm25(index, "alpha beta", 10);
		expect(r.chunks.length).toBe(0);
		expect(r.dropped).toBeGreaterThan(0);
	});

	it("full ignores the budget by construction and reports the whole corpus", () => {
		const corpus = { root: "/x", documents: [], chunks };
		const r = retrieveFull(corpus);
		expect(r.chunks.length).toBe(chunks.length);
		// Priced on the assembled prompt, like every other arm - so strictly more
		// than the bare bodies, because the citation labels are real context. A
		// ratio whose numerator and denominator were counted differently would
		// flatter retrieval by exactly the difference.
		expect(r.tokens).toBe(estimateTokens(renderContext(r)));
		expect(r.tokens).toBeGreaterThan(chunks.reduce((a, c) => a + c.tokens, 0));
		expect(r.dropped).toBe(0);
	});
});

describe("retrieveSection", () => {
	it("expands a hit to its whole section in document order", () => {
		// The failure this exists to fix: a hit lands on a table row and the
		// paragraph naming its period and currency is left behind.
		const big = "gamma ".repeat(900);
		const chunks = chunksOf(
			`# S\n\nheader says millions\n\n${big}delta marker`,
		);
		const index = buildIndex(chunks);
		const r = retrieveSection(index, "delta marker", 100_000);
		const starts = r.chunks.map((c) => c.charStart);
		expect([...starts].sort((a, b) => a - b)).toEqual(starts);
		expect(r.chunks.length).toBeGreaterThan(1);
	});

	it("does not duplicate a section when several of its chunks hit", () => {
		const chunks = chunksOf("# S\n\nalpha alpha alpha");
		const r = retrieveSection(buildIndex(chunks), "alpha", 100_000);
		expect(new Set(r.chunks.map((c) => c.chunkId)).size).toBe(r.chunks.length);
	});
});

describe("Retrieval.tokens prices the assembled prompt", () => {
	// Gap found and pinned 2026-08-14, closed 2026-08-15. `tokens` summed chunk
	// BODIES while the pipeline sent renderContext(), which adds a per-chunk
	// `[chunkId] — path` label that retrieve.ts itself calls load-bearing (a
	// citation must quote it, and extract.ts rejects facts whose citation does
	// not resolve). That label was real context nothing priced: 17.6-20.8%.
	const chunks = chunksOf(
		"# Item 7\n\n## Liquidity\n\ncash 512.7\n\n## Fuel\n\ndiesel 14.6",
	);
	const index = buildIndex(chunks);

	it("reports exactly the context it sends", () => {
		// Both a whole-corpus arm and a budgeted one, so this cannot be read as an
		// artifact of `full`.
		for (const r of [
			retrieveFull({ root: "", documents: [], chunks }),
			retrieveBm25(index, "cash diesel", 10_000),
		]) {
			expect(r.chunks.length).toBeGreaterThan(0);
			expect(r.tokens).toBe(estimateTokens(renderContext(r)));
		}
	});

	it("never assembles a context larger than its budget", () => {
		// The old undercount's real consequence: the packer bounded chunk bodies,
		// not context, so the budget was not a bound at all.
		for (const budget of [20, 40, 80, 200]) {
			const r = retrieveBm25(index, "cash diesel", budget);
			expect(estimateTokens(renderContext(r))).toBeLessThanOrEqual(budget);
		}
	});

	it("keeps every chunk a smaller budget kept", () => {
		// Monotonicity is why the packer takes a prefix and stops. Nested
		// selections are the only way recall can be non-decreasing in budget, and
		// a curve that can fall as its input rises has no well-defined knee.
		let previous: string[] = [];
		for (const budget of [20, 40, 80, 200, 1000]) {
			const ids = retrieveBm25(index, "cash diesel", budget).chunks.map(
				(c) => c.chunkId,
			);
			for (const id of previous) expect(ids).toContain(id);
			previous = ids;
		}
	});
});

describe("renderContext", () => {
	it("labels every block with the id a citation must quote", () => {
		const chunks = chunksOf("# Liquidity\n\ncash 512.7");
		const text = renderContext(
			retrieveFull({ root: "", documents: [], chunks }),
		);
		expect(text).toContain(`[${chunks[0]?.chunkId}]`);
		expect(text).toContain("Liquidity");
	});

	it("renders an empty retrieval as an empty string", () => {
		expect(
			renderContext({ strategy: "bm25", chunks: [], tokens: 0, dropped: 0 }),
		).toBe("");
	});
});

describe("retrieve", () => {
	const chunks = chunksOf("# S\n\nalpha 512.7");
	const index = buildIndex(chunks);
	const corpus = { root: "", documents: [], chunks };

	it("dispatches each measured architecture to its own retriever", () => {
		for (const s of ["full", "bm25", "section"] as const) {
			expect(retrieve(s, corpus, index, "alpha", 1000).strategy).toBe(s);
		}
	});

	it("THROWS on an unvalidated strategy rather than answering as bm25", () => {
		// The dispatcher used to end in a bare `return retrieveBm25(...)`, so an
		// unknown name was silently answered by bm25 and labelled with whatever it
		// asked for -- a wrong number wearing the right label.
		expect(() =>
			retrieve("embeddings" as never, corpus, index, "alpha", 1000),
		).toThrow(/unknown retrieval strategy: embeddings/);
	});
});
