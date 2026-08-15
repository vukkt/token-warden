/**
 * Retrieval strategies, expressed as things the gate can measure.
 *
 * ## The framing
 *
 * A retrieval strategy is a CONTEXT SOURCE: given a question, it decides which
 * tokens to put in front of the model. Every strategy in this file therefore
 * reports the same two numbers — what it retrieved and what that cost — so the
 * existing verdict machinery can compare them the way it compares memory rules.
 * "Which retrieval architecture is better" stops being an opinion and becomes a
 * measurement with a standard error.
 *
 * ## Why lexical (BM25) and not embeddings
 *
 * This is a deliberate choice, not a missing feature.
 *
 * 1. **Financial questions are dominated by exact identifiers.** Tickers, line
 *    items, section numbers and — above all — PERIODS. An embedding places
 *    "Q3 2023 revenue" and "Q3 2024 revenue" almost on top of each other, which
 *    is precisely the distinction the answer turns on. Lexical scoring keeps
 *    `2024` and `2023` as different tokens.
 * 2. **It is deterministic and zero-token.** Retrieval cost must be measurable
 *    without a second vendor in the loop; an embedding API would put a priced,
 *    versioned, non-reproducible dependency underneath the thing being measured.
 *    Re-running last month's benchmark has to give last month's retrieval.
 * 3. **It is a floor, not a ceiling.** The honest use of this module is as the
 *    baseline a semantic retriever must BEAT on the same suite. If a vector
 *    index cannot clear BM25 by more than its own noise, it has not earned the
 *    infrastructure.
 *
 * The cost is real and stated: lexical retrieval misses paraphrase. A question
 * asking about "borrowing capacity" will not match a section that only ever says
 * "undrawn revolver" unless a shared term survives. Hybrid retrieval is the
 * documented next step (ROADMAP), and it should be admitted the same way
 * anything else here is — by measurement.
 */
import { type Chunk, type Corpus, tokensForLength } from "./corpus.js";

/** BM25 term-frequency saturation. 1.2 is the standard default; above it, term
 * repetition keeps paying, which favors boilerplate-heavy filings. */
const BM25_K1 = 1.2;

/** BM25 length normalization. 0.75 is the standard default. Section chunks vary
 * a lot in length here, so this term is doing real work. */
const BM25_B = 0.75;

/**
 * Tokenizer for the lexical index.
 *
 * Numbers keep their internal separators (`1,204.5`, `10-K`, `2024-Q3`) instead
 * of being shattered into `1`, `204`, `5`. That is the single most important
 * decision in this file for financial text: a shattered number matches every
 * document containing the digit 5, which is all of them, and the resulting
 * retrieval is noise wearing a relevance score.
 */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9$%.,-]+/)) {
		// Trim punctuation that is sentence structure rather than part of the
		// token, but only at the edges — `1,204.5` must survive intact.
		const t = raw.replace(/^[.,-]+/, "").replace(/[.,-]+$/, "");
		if (t !== "" && t !== "$" && t !== "%") out.push(t);
	}
	return out;
}

/** Inverted index over a corpus's chunks. Built once, queried many times. */
export interface LexicalIndex {
	chunks: Chunk[];
	/** term -> chunk ordinal -> term frequency. */
	postings: Map<string, Map<number, number>>;
	/** Token length of each chunk, by ordinal. */
	lengths: number[];
	avgLength: number;
}

/** Build the inverted index. O(total terms); no I/O, no model. */
export function buildIndex(chunks: Chunk[]): LexicalIndex {
	const postings = new Map<string, Map<number, number>>();
	const lengths: number[] = [];
	chunks.forEach((chunk, i) => {
		const terms = tokenize(chunk.text);
		lengths.push(terms.length);
		for (const term of terms) {
			let byChunk = postings.get(term);
			if (byChunk === undefined) {
				byChunk = new Map();
				postings.set(term, byChunk);
			}
			byChunk.set(i, (byChunk.get(i) ?? 0) + 1);
		}
	});
	const total = lengths.reduce((a, b) => a + b, 0);
	return {
		chunks,
		postings,
		lengths,
		avgLength: lengths.length === 0 ? 0 : total / lengths.length,
	};
}

/** A scored chunk. */
export interface ScoredChunk {
	chunk: Chunk;
	score: number;
}

/**
 * Score every chunk against a query with Okapi BM25.
 *
 * The IDF form is the standard `log(1 + (N - df + 0.5) / (df + 0.5))`, whose
 * `1 +` keeps the value non-negative — the textbook form goes negative for terms
 * appearing in more than half the corpus, which on a single-company filing set
 * means common terms actively PENALIZE the documents containing them.
 */
export function bm25(index: LexicalIndex, query: string): ScoredChunk[] {
	const n = index.chunks.length;
	if (n === 0) return [];
	const scores = new Map<number, number>();
	for (const term of new Set(tokenize(query))) {
		const byChunk = index.postings.get(term);
		if (byChunk === undefined) continue;
		const df = byChunk.size;
		const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
		for (const [i, tf] of byChunk) {
			const len = index.lengths[i] as number;
			const norm =
				(tf * (BM25_K1 + 1)) /
				(tf + BM25_K1 * (1 - BM25_B + BM25_B * (len / (index.avgLength || 1))));
			scores.set(i, (scores.get(i) ?? 0) + idf * norm);
		}
	}
	return (
		[...scores.entries()]
			.map(([i, score]) => ({ chunk: index.chunks[i] as Chunk, score }))
			// Tie-break on chunkId so equal scores order deterministically rather
			// than by Map insertion, which depends on corpus traversal order.
			.sort((a, b) =>
				b.score !== a.score
					? b.score - a.score
					: a.chunk.chunkId.localeCompare(b.chunk.chunkId),
			)
	);
}

/** The retrieval architectures this project measures against each other. */
export const STRATEGIES = ["full", "bm25", "section"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** What a strategy returned, and what carrying it costs. */
export interface Retrieval {
	strategy: Strategy;
	chunks: Chunk[];
	/**
	 * Cost of the ASSEMBLED PROMPT — every chunk in its rendered form, separators
	 * included. What `renderContext` emits, priced by the same estimator.
	 *
	 * ## Corrected 2026-08-15 (previously the sum of chunk bodies)
	 *
	 * This field used to sum `chunk.tokens`, the bare bodies. What the pipeline
	 * actually sends is `renderContext(retrieval)`, which prefixes every chunk
	 * with `[chunkId] — section > path` and joins on a blank line. That label is
	 * load-bearing, not decoration: it is the handle a citation must quote, and
	 * `extract.ts` rejects any fact whose citation does not resolve. So it could
	 * not be dropped to close the gap — it is real context that was going
	 * unpriced, by 17.6% to 20.8% depending on the arm.
	 *
	 * Two things were wrong as a result, and both are fixed:
	 *
	 * 1. Every reported cost understated true spend by roughly a fifth.
	 * 2. `underBudget` packed against the same unpriced metric, so the assembled
	 *    context EXCEEDED its stated budget on 12 of 12 questions in every arm at
	 *    every swept budget. The budget was a bound on chunk bodies, not on
	 *    context. It is now a real bound.
	 *
	 * `renderChunk` is the single source of truth both the packer and the
	 * renderer use, so this cannot drift apart again by editing one of them.
	 */
	tokens: number;
	/** Chunks the strategy considered and dropped for budget. Reported because
	 * a strategy that is constantly truncating is under-budgeted, and that is
	 * invisible if only the kept set is shown. */
	dropped: number;
}

/** Separator between rendered chunks. Part of what is sent, so part of the price. */
const CHUNK_JOIN = "\n\n";

/**
 * One chunk's prompt form — the SINGLE source of truth for what the model
 * receives.
 *
 * `renderContext` and `underBudget` must agree exactly: when they were separate
 * expressions the packer priced the bare body while the renderer added a label,
 * and the budget silently became a bound on chunk text rather than on context.
 * Anything added here is priced by the packer in the same commit, by
 * construction rather than by remembering.
 */
function renderChunk(c: Chunk): string {
	const where =
		c.sectionPath.length > 0 ? ` — ${c.sectionPath.join(" > ")}` : "";
	return `[${c.chunkId}]${where}\n${c.text.trim()}`;
}

/**
 * Assemble a context under a token budget.
 *
 * Budget is in TOKENS rather than a top-k count because section chunks vary in
 * size by an order of magnitude; `k = 5` can mean 400 tokens or 6,000, and a
 * comparison between strategies whose context sizes differ by 15x is not a
 * comparison of retrieval quality. Fixing the budget and varying what fills it
 * is what makes the arms commensurable.
 *
 * ## Why this takes a PREFIX and stops, rather than skipping on to fill
 *
 * The packer previously kept scanning after a chunk failed to fit, taking any
 * later chunk small enough for the remaining room. That fills the budget better
 * — and it made recall NON-MONOTONE in budget: measured on the shipped suite,
 * bm25 scored 77.8% at 400 tokens and 66.7% at 600. More budget, fewer answers.
 *
 * That is not noise, it is the shape of the rule. `sweepBudgets` exists to draw
 * a budget-versus-recall curve and locate its knee, and a curve that can fall as
 * its input rises has no well-defined knee — the headline ratio would depend on
 * which budgets happened to be sampled.
 *
 * The choice is forced, not a preference. Monotone recall requires the selected
 * sets to NEST as the budget grows (that is exactly the invariant
 * `test/ragbench.test.ts` states: "a violation means the budget packer is
 * dropping a chunk it previously kept"). A nested family under a fixed score
 * order is precisely the set of prefixes of that order. Any rule that ever skips
 * an item produces two selections neither of which contains the other, so
 * "monotone AND budget-filling" is not available to choose.
 *
 * The cost is real and paid knowingly: below the knee this leaves room unused
 * and retrieves less (66.7% vs 77.8% at 400 tokens). AT the knee it is strictly
 * better on both axes — 100% recall for 1,281 tokens against 1,393 — because
 * the chunks it skipped were being paid for without carrying answers.
 */
function underBudget(
	scored: ScoredChunk[],
	budgetTokens: number,
	strategy: Strategy,
): Retrieval {
	const chunks: Chunk[] = [];
	let chars = 0;
	let dropped = 0;
	for (const { chunk } of scored) {
		// Price what is actually sent, label and separator included. Packing
		// against the bare body made the budget a bound on chunk text only, and
		// the assembled context exceeded it on every question in every arm.
		const add =
			(chunks.length > 0 ? CHUNK_JOIN.length : 0) + renderChunk(chunk).length;
		if (tokensForLength(chars + add) > budgetTokens) {
			dropped = scored.length - chunks.length;
			break;
		}
		chunks.push(chunk);
		chars += add;
	}
	return { strategy, chunks, tokens: tokensForLength(chars), dropped };
}

/**
 * `full` — put the entire corpus in the prompt. The mega-prompt arm.
 *
 * Kept as a first-class strategy rather than a straw man: below some corpus
 * size it genuinely wins, because it has zero retrieval risk (the answer is
 * always present) and modern context windows are large. The point of measuring
 * it is to find where that stops being true FOR A GIVEN CORPUS, rather than
 * assuming retrieval is always correct. It ignores the budget by construction,
 * and reporting its token count against the others is the whole comparison.
 */
export function retrieveFull(corpus: Corpus): Retrieval {
	const chunks = corpus.chunks;
	// Priced on the same rendered basis as every other arm. The mega-prompt
	// ratio is a comparison, so both sides must be counted the same way; the
	// denominator being cheaper than the numerator by an accounting difference
	// would flatter retrieval by exactly the size of the discrepancy.
	return {
		strategy: "full",
		chunks,
		tokens: tokensForLength(chunks.map(renderChunk).join(CHUNK_JOIN).length),
		dropped: 0,
	};
}

/** `bm25` — the highest-scoring chunks that fit the budget. */
export function retrieveBm25(
	index: LexicalIndex,
	query: string,
	budgetTokens: number,
): Retrieval {
	return underBudget(bm25(index, query), budgetTokens, "bm25");
}

/**
 * `section` — score chunks, then expand each hit to its whole section.
 *
 * This exists because top-k lexical retrieval has a specific, repeatable failure
 * on structured documents: the query terms land on the row of a table, and the
 * chunk returned is the row without the surrounding paragraph that says what
 * period and currency it is in. Expanding a hit to its section siblings buys
 * back that context at a token cost the budget then has to justify — which is
 * exactly the trade the measurement is for.
 */
export function retrieveSection(
	index: LexicalIndex,
	query: string,
	budgetTokens: number,
): Retrieval {
	// One expression answers both "have I already expanded this section" and "is
	// this chunk a sibling". The two MUST agree, and previously agreed only by
	// inspection: the dedupe key was a joined string while the sibling test
	// compared docId and joined path as separate operands. NUL-joined because it
	// occurs in neither a path nor a heading, so distinct sections cannot collide.
	const sectionKey = (c: Chunk): string =>
		`${c.docId}\u0000${c.sectionPath.join("\u0000")}`;
	const seen = new Set<string>();
	const expanded: ScoredChunk[] = [];
	for (const hit of bm25(index, query)) {
		const key = sectionKey(hit.chunk);
		if (seen.has(key)) continue;
		seen.add(key);
		// Siblings keep document order so a reassembled section reads correctly.
		const siblings = index.chunks
			.filter((c) => sectionKey(c) === key)
			.sort((a, b) => a.charStart - b.charStart);
		for (const sibling of siblings)
			expanded.push({ chunk: sibling, score: hit.score });
	}
	return underBudget(expanded, budgetTokens, "section");
}

/**
 * Dispatch by strategy name.
 *
 * Throws on an unknown name rather than falling through to a default arm. The
 * earlier form ended in a bare `return retrieveBm25(...)`, so a strategy string
 * that had not been validated — from a flag, a config file, a persisted row —
 * was silently ANSWERED BY BM25 AND LABELLED with whatever it asked for. That is
 * the repo's recurring failure shape: not a crash, a wrong number wearing the
 * right label.
 */
export function retrieve(
	strategy: Strategy,
	corpus: Corpus,
	index: LexicalIndex,
	query: string,
	budgetTokens: number,
): Retrieval {
	if (strategy === "full") return retrieveFull(corpus);
	if (strategy === "bm25") return retrieveBm25(index, query, budgetTokens);
	if (strategy === "section")
		return retrieveSection(index, query, budgetTokens);
	throw new Error(`unknown retrieval strategy: ${String(strategy)}`);
}

/**
 * Render a retrieval as prompt text.
 *
 * Every chunk is labeled with its `chunkId` and section path, and that label is
 * load-bearing rather than decorative: it is the handle the model must quote to
 * cite a fact, and `extract.ts` refuses any claim whose citation does not
 * resolve. Dropping the labels to save tokens would remove the only mechanism
 * that makes an extracted number checkable.
 */
export function renderContext(retrieval: Retrieval): string {
	return retrieval.chunks.map(renderChunk).join(CHUNK_JOIN);
}
