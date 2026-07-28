/**
 * Unstructured-document ingestion: parse, section, chunk.
 *
 * ## Why this lives in token-warden
 *
 * This project's one idea is that context must pay for itself. Until now the
 * unit of context was a memory RULE. A retrieved document chunk is the same
 * kind of object: it occupies context, it costs tokens on every call that
 * carries it, and somebody is asserting — usually without evidence — that it
 * earns its place. Retrieval is therefore not a new product bolted on the side;
 * it is a second `ContextSource` for the gate that already exists.
 *
 * ## Why parsing is deterministic and zero-token
 *
 * No model is called anywhere in this file, and that is a correctness
 * requirement rather than a cost saving. The corpus is the GROUND TRUTH that
 * extracted facts are checked against (`extract.ts` rejects any fact whose cited
 * span does not contain the value it claims). If a model produced the spans,
 * the check would be circular: the thing being verified would also be the
 * verifier. Parsing stays mechanical so the citation check has something
 * independent to stand on.
 *
 * ## Why sections, not fixed windows
 *
 * The usual chunker slices every N tokens with an overlap. On financial
 * documents that is actively wrong: a fixed window routinely severs a table
 * from the header row that names its units and period, and "1,204" with no
 * header is not a fact, it is a number. Filings, earnings transcripts and term
 * sheets are already heavily sectioned by their authors, so this splits on the
 * structure the document declares and falls back to windows only inside a
 * section that is too large to carry whole.
 *
 * The cost of that choice is variable chunk size, which the retriever has to
 * handle (see `retrieve.ts` — its budget is denominated in tokens, not in a
 * count of chunks, for exactly this reason).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * Token estimate for a string: `chars / 4`, the same crude divisor already used
 * by `rules.ts#contextCost` and `status.ts`.
 *
 * It is deliberately the SAME crude divisor. A better tokenizer here would make
 * retrieval budgets disagree with rule rents, and the whole point is that a
 * chunk and a rule are priced on one scale so the gate can compare them. When
 * this is upgraded it must be upgraded everywhere at once, and every recorded
 * verdict re-baselined — see DECISIONS.md.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** A parsed source document, normalized to plain text. */
export interface CorpusDocument {
	/** Stable identifier — the path relative to the corpus root. */
	docId: string;
	/** Original file extension, lowercased, without the dot. */
	format: string;
	/** Normalized plain text. Char offsets in chunks index into THIS. */
	text: string;
}

/**
 * A retrievable unit of a document.
 *
 * `charStart`/`charEnd` index into the parent document's normalized `text` and
 * are what make a citation checkable: given a `docId` and a span, any consumer
 * can re-read the exact bytes a claim was drawn from without trusting the
 * component that produced the claim.
 */
export interface Chunk {
	docId: string;
	/** `<docId>#<ordinal>` — unique across the corpus. */
	chunkId: string;
	/** Heading trail, outermost first, e.g. `["Item 7", "Liquidity"]`. Empty
	 * for a document with no detected structure. */
	sectionPath: string[];
	text: string;
	charStart: number;
	charEnd: number;
	/** `estimateTokens(text)`, precomputed because the retriever's budget
	 * arithmetic runs over every chunk on every query. */
	tokens: number;
}

/** File extensions ingested. Anything else in the corpus tree is ignored
 * rather than guessed at — a binary read as UTF-8 produces plausible-looking
 * garbage that would silently pollute retrieval. */
const SUPPORTED = new Set([
	"md",
	"markdown",
	"txt",
	"text",
	"csv",
	"html",
	"htm",
]);

/**
 * Largest section carried as a single chunk, in tokens. Sections above this are
 * window-split as a fallback.
 *
 * 1,200 is chosen so that a whole typical filing subsection or one earnings-call
 * answer survives intact — the unit a human analyst would actually quote. It is
 * not tuned against a retrieval benchmark, because tuning it against the same
 * suite used to report results would be fitting the instrument to the exam.
 */
const MAX_SECTION_TOKENS = 1200;

/** Overlap between window-split fragments of an oversized section, in tokens.
 * Only ever applies within one section, so it can never bridge two topics. */
const WINDOW_OVERLAP_TOKENS = 80;

/**
 * Strip HTML to text without a DOM.
 *
 * `<script>` and `<style>` bodies are dropped entirely (their contents are not
 * prose and would otherwise dominate the lexical index), block-level tags become
 * newlines so section detection still has line structure to work with, and the
 * five standard entities are decoded. This is not a spec-compliant parser and
 * does not pretend to be — it handles the exported-filing and saved-page cases
 * that appear in a document corpus.
 */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|h[1-6]|li|table|section)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Render CSV as aligned text with the header repeated per row group.
 *
 * A naive ingest drops the CSV in raw, and then a chunk boundary or a top-k
 * retrieval hands the model rows with no header — the exact severed-table
 * failure this module exists to avoid. Emitting `header: value` pairs costs more
 * tokens and is worth it: an unlabeled column of numbers is not retrievable and
 * not extractable, so the cheaper version is cheaper at doing nothing.
 */
export function csvToText(csv: string): string {
	const rows = csv
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map(splitCsvLine);
	const header = rows[0];
	if (header === undefined) return "";
	if (rows.length === 1) return header.join(" | ");
	const out: string[] = [];
	for (let r = 1; r < rows.length; r++) {
		const row = rows[r] as string[];
		const pairs = header.map((h, c) => `${h}: ${row[c] ?? ""}`);
		out.push(pairs.join(", "));
	}
	return out.join("\n");
}

/** Split one CSV line, honoring double-quoted fields and `""` escapes. */
function splitCsvLine(line: string): string[] {
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					current += '"';
					i++;
				} else inQuotes = false;
			} else current += ch;
		} else if (ch === '"') inQuotes = true;
		else if (ch === ",") {
			fields.push(current.trim());
			current = "";
		} else current += ch;
	}
	fields.push(current.trim());
	return fields;
}

/** Normalize one file's bytes to plain text according to its extension. */
export function parseDocument(
	docId: string,
	format: string,
	raw: string,
): CorpusDocument {
	let text: string;
	if (format === "html" || format === "htm") text = htmlToText(raw);
	else if (format === "csv") text = csvToText(raw);
	else text = raw.replace(/\r\n/g, "\n").trim();
	return { docId, format, text };
}

/** A detected heading: where it starts, its depth, and its title. */
interface Heading {
	index: number;
	depth: number;
	title: string;
}

/**
 * Locate headings in normalized text.
 *
 * Three forms are recognized, in priority order: markdown ATX (`## Title`),
 * a numbered filing item (`Item 7.`, `PART II`), and an ALL-CAPS standalone
 * line. The latter two exist because plain-text filings and transcripts carry
 * real structure without any markdown in them, and treating such a document as
 * one undifferentiated blob is what forces the fixed-window fallback this module
 * is trying to avoid.
 */
export function findHeadings(text: string): Heading[] {
	const headings: Heading[] = [];
	const lines = text.split("\n");
	let offset = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		const atx = /^(#{1,6})\s+(.*\S)\s*$/.exec(trimmed);
		if (atx !== null) {
			headings.push({
				index: offset,
				depth: (atx[1] as string).length,
				title: atx[2] as string,
			});
		} else if (/^(item|part)\s+[0-9ivx]+[.:)]?\s*/i.test(trimmed)) {
			headings.push({ index: offset, depth: 1, title: trimmed });
		} else if (
			trimmed.length >= 4 &&
			trimmed.length <= 80 &&
			trimmed === trimmed.toUpperCase() &&
			/[A-Z]{3}/.test(trimmed) &&
			!/[.!?]$/.test(trimmed)
		) {
			headings.push({ index: offset, depth: 2, title: trimmed });
		}
		offset += line.length + 1;
	}
	return headings;
}

/** Build the heading trail for a heading at `i`, outermost first. */
function pathFor(headings: Heading[], i: number): string[] {
	const current = headings[i] as Heading;
	const trail = [current.title];
	let depth = current.depth;
	for (let j = i - 1; j >= 0; j--) {
		const h = headings[j] as Heading;
		if (h.depth < depth) {
			trail.unshift(h.title);
			depth = h.depth;
		}
	}
	return trail;
}

/**
 * Split a document into chunks along its own declared structure.
 *
 * A document with no detected headings yields one chunk if it fits, or windowed
 * fragments if it does not — never an empty result for non-empty input, because
 * a silently unindexed document is worse than a badly chunked one.
 */
export function chunkDocument(doc: CorpusDocument): Chunk[] {
	if (doc.text.trim() === "") return [];
	const headings = findHeadings(doc.text);
	const chunks: Chunk[] = [];
	let ordinal = 0;

	const push = (start: number, end: number, sectionPath: string[]): void => {
		const slice = doc.text.slice(start, end);
		if (slice.trim() === "") return;
		if (estimateTokens(slice) <= MAX_SECTION_TOKENS) {
			chunks.push(makeChunk(doc, ordinal++, sectionPath, start, end));
			return;
		}
		// Oversized section: window-split, but keep the section path on every
		// fragment so a retrieved fragment still says where it came from.
		const size = MAX_SECTION_TOKENS * 4;
		const step = size - WINDOW_OVERLAP_TOKENS * 4;
		for (let p = start; p < end; p += step) {
			const stop = Math.min(p + size, end);
			if (doc.text.slice(p, stop).trim() !== "") {
				chunks.push(makeChunk(doc, ordinal++, sectionPath, p, stop));
			}
			if (stop === end) break;
		}
	};

	if (headings.length === 0) {
		push(0, doc.text.length, []);
		return chunks;
	}
	const first = headings[0] as Heading;
	// Front matter before the first heading is content too (cover pages carry
	// the company, period and currency that every later fact is relative to).
	if (first.index > 0) push(0, first.index, []);
	for (let i = 0; i < headings.length; i++) {
		const start = (headings[i] as Heading).index;
		const next = headings[i + 1];
		push(
			start,
			next === undefined ? doc.text.length : next.index,
			pathFor(headings, i),
		);
	}
	return chunks;
}

function makeChunk(
	doc: CorpusDocument,
	ordinal: number,
	sectionPath: string[],
	charStart: number,
	charEnd: number,
): Chunk {
	const text = doc.text.slice(charStart, charEnd);
	return {
		docId: doc.docId,
		chunkId: `${doc.docId}#${ordinal}`,
		sectionPath,
		text,
		charStart,
		charEnd,
		tokens: estimateTokens(text),
	};
}

/** An ingested corpus: the documents and their chunks. */
export interface Corpus {
	root: string;
	documents: CorpusDocument[];
	chunks: Chunk[];
}

/** Directories never descended into. */
const SKIP_DIRS = new Set([".git", "node_modules", ".token-warden"]);

/** Recursively list ingestible files under `dir`, sorted for determinism.
 *
 * Sorted because chunk ordinals become chunk ids, ids appear in citations, and
 * citations appear in recorded results — a directory-order-dependent id would
 * make two ingests of the same corpus disagree. */
function walk(dir: string, root: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir).sort();
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) walk(full, root, out);
		else if (SUPPORTED.has(extname(entry).slice(1).toLowerCase()))
			out.push(full);
	}
}

/**
 * Ingest every supported document under `root`.
 *
 * Unreadable files are skipped rather than fatal: a corpus is user data, and one
 * permission-denied PDF export should not abort an otherwise valid ingest.
 */
export function ingestCorpus(root: string): Corpus {
	const files: string[] = [];
	walk(root, root, files);
	const documents: CorpusDocument[] = [];
	const chunks: Chunk[] = [];
	for (const file of files) {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const docId = relative(root, file).split("\\").join("/");
		const format = extname(file).slice(1).toLowerCase();
		const doc = parseDocument(docId, format, raw);
		documents.push(doc);
		chunks.push(...chunkDocument(doc));
	}
	return { root, documents, chunks };
}

/** Total token cost of carrying an entire corpus in context — the denominator
 * every retrieval strategy is scored against. */
export function corpusTokens(corpus: Corpus): number {
	return corpus.chunks.reduce((acc, c) => acc + c.tokens, 0);
}
