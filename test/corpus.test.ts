import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	chunkDocument,
	corpusTokens,
	csvToText,
	estimateTokens,
	findHeadings,
	htmlToText,
	ingestCorpus,
	parseDocument,
} from "../src/corpus.js";

describe("estimateTokens", () => {
	it("matches the chars/4 convention used by rules.ts", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		// Rounds up: a partial token still occupies a token.
		expect(estimateTokens("abcde")).toBe(2);
	});
});

describe("htmlToText", () => {
	it("drops script and style bodies entirely", () => {
		const text = htmlToText(
			"<style>body{color:red}</style><script>var secret='tracking-id'</script><p>Revenue was 4,182.6</p>",
		);
		expect(text).not.toContain("tracking-id");
		expect(text).not.toContain("color:red");
		expect(text).toContain("Revenue was 4,182.6");
	});

	it("turns block tags into line breaks so headings stay detectable", () => {
		expect(htmlToText("<h2>Article VI</h2><p>Covenants</p>")).toContain("\n");
	});

	it("decodes the standard entities", () => {
		expect(
			htmlToText("<p>A &amp; B &lt;x&gt; &quot;q&quot; &#39;s&#39;</p>"),
		).toBe("A & B <x> \"q\" 's'");
	});
});

describe("csvToText", () => {
	it("repeats the header on every row so a chunk can never lose it", () => {
		const text = csvToText("segment,revenue\nCold Chain,1388.9\nGround,2140.3");
		expect(text).toContain("segment: Cold Chain, revenue: 1388.9");
		expect(text).toContain("segment: Ground, revenue: 2140.3");
	});

	it("honors quoted fields containing commas", () => {
		const text = csvToText('name,note\n"Northwind, Inc.",ok');
		expect(text).toContain("name: Northwind, Inc.");
	});

	it("honors doubled quotes as an escaped quote", () => {
		expect(csvToText('a\n"He said ""hi"""')).toContain('a: He said "hi"');
	});

	it("returns empty for empty input rather than throwing", () => {
		expect(csvToText("")).toBe("");
	});

	it("renders a header-only file as the header", () => {
		expect(csvToText("a,b,c")).toBe("a | b | c");
	});
});

describe("findHeadings", () => {
	it("detects markdown ATX headings with their depth", () => {
		const h = findHeadings("# Top\n\ntext\n\n## Sub\n\nmore");
		expect(h.map((x) => [x.depth, x.title])).toEqual([
			[1, "Top"],
			[2, "Sub"],
		]);
	});

	it("detects filing item headings in documents with no markdown", () => {
		const h = findHeadings("Item 7. Management's Discussion\n\nbody");
		expect(h[0]?.title).toContain("Item 7.");
	});

	it("detects ALL-CAPS speaker lines in transcripts", () => {
		// The earnings-call format carries all its structure this way; without
		// this the whole transcript becomes one chunk.
		const h = findHeadings("MARCUS OHL\n\nThank you Dana.");
		expect(h[0]?.title).toBe("MARCUS OHL");
	});

	it("does not treat a shouted sentence as a heading", () => {
		// Trailing punctuation is the discriminator — a heading is not a sentence.
		expect(findHeadings("THIS IS NOT A HEADING.")).toEqual([]);
	});

	it("reports offsets that index into the source text", () => {
		const text = "intro\n## Sub\nbody";
		const h = findHeadings(text);
		expect(text.slice(h[0]?.index ?? 0, (h[0]?.index ?? 0) + 5)).toBe("## Su");
	});
});

describe("chunkDocument", () => {
	it("splits on the document's own sections and records the heading trail", () => {
		const doc = parseDocument(
			"d.md",
			"md",
			"# Item 7\n\nlead\n\n## Liquidity\n\ncash was 512.7",
		);
		const chunks = chunkDocument(doc);
		const liquidity = chunks.find((c) => c.text.includes("512.7"));
		expect(liquidity?.sectionPath).toEqual(["Item 7", "Liquidity"]);
	});

	it("keeps front matter that precedes the first heading", () => {
		// Cover pages carry the currency and period every later fact depends on.
		const doc = parseDocument(
			"d.md",
			"md",
			"All amounts in millions.\n\n# Item 1\n\nbody",
		);
		expect(chunkDocument(doc)[0]?.text).toContain("All amounts in millions");
	});

	it("produces spans that slice back to the chunk text exactly", () => {
		// This is the property citations rest on: given a span, a verifier must be
		// able to re-read the same bytes independently.
		const doc = parseDocument("d.md", "md", "# A\n\none\n\n## B\n\ntwo");
		for (const chunk of chunkDocument(doc)) {
			expect(doc.text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
		}
	});

	it("window-splits a section too large to carry whole", () => {
		const huge = "x".repeat(4 * 1200 * 3);
		const doc = parseDocument("d.md", "md", `# Big\n\n${huge}`);
		const chunks = chunkDocument(doc);
		expect(chunks.length).toBeGreaterThan(1);
		// The section path survives onto every fragment, so a retrieved fragment
		// still says where it came from.
		for (const c of chunks) expect(c.sectionPath).toEqual(["Big"]);
	});

	it("returns one chunk for an unstructured document that fits", () => {
		expect(
			chunkDocument(parseDocument("d.txt", "txt", "plain body")).length,
		).toBe(1);
	});

	it("returns nothing for an empty document", () => {
		expect(chunkDocument(parseDocument("d.txt", "txt", "   "))).toEqual([]);
	});

	it("assigns unique chunk ids within a document", () => {
		const doc = parseDocument(
			"d.md",
			"md",
			"# A\n\none\n\n# B\n\ntwo\n\n# C\n\nthree",
		);
		const ids = chunkDocument(doc).map((c) => c.chunkId);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("ingestCorpus", () => {
	function fixture(): string {
		const root = mkdtempSync(join(tmpdir(), "warden-corpus-"));
		writeFileSync(join(root, "a.md"), "# A\n\nrevenue was 100.5");
		writeFileSync(join(root, "b.csv"), "k,v\nx,1");
		writeFileSync(join(root, "ignore.bin"), "not a supported extension");
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "c.txt"), "nested body");
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "node_modules", "d.md"), "should not be ingested");
		return root;
	}

	it("ingests supported formats and ignores everything else", () => {
		const corpus = ingestCorpus(fixture());
		const ids = corpus.documents.map((d) => d.docId).sort();
		expect(ids).toEqual(["a.md", "b.csv", "sub/c.txt"]);
	});

	it("does not descend into node_modules", () => {
		const corpus = ingestCorpus(fixture());
		expect(corpus.documents.some((d) => d.docId.includes("node_modules"))).toBe(
			false,
		);
	});

	it("uses forward-slash relative ids so chunk ids are portable", () => {
		const corpus = ingestCorpus(fixture());
		expect(corpus.documents.some((d) => d.docId === "sub/c.txt")).toBe(true);
	});

	it("is deterministic across repeated ingests", () => {
		// Chunk ids appear in citations and citations appear in recorded results,
		// so directory-order dependence would make two ingests disagree.
		const root = fixture();
		const a = ingestCorpus(root).chunks.map((c) => c.chunkId);
		const b = ingestCorpus(root).chunks.map((c) => c.chunkId);
		expect(a).toEqual(b);
	});

	it("returns an empty corpus for a missing directory rather than throwing", () => {
		const corpus = ingestCorpus(join(tmpdir(), "warden-does-not-exist-xyz"));
		expect(corpus.documents).toEqual([]);
		expect(corpusTokens(corpus)).toBe(0);
	});
});
