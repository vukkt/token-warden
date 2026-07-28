import { describe, expect, it } from "vitest";
import { type Chunk, chunkDocument, parseDocument } from "../src/corpus.js";
import {
	bm25,
	buildIndex,
	isStrategy,
	renderContext,
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
		expect(r.tokens).toBe(chunks.reduce((a, c) => a + c.tokens, 0));
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

describe("isStrategy", () => {
	it("accepts the three measured architectures and nothing else", () => {
		expect(isStrategy("full")).toBe(true);
		expect(isStrategy("bm25")).toBe(true);
		expect(isStrategy("section")).toBe(true);
		expect(isStrategy("embeddings")).toBe(false);
	});
});
