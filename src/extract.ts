/**
 * Structured extraction with a groundedness gate.
 *
 * ## The claim this module makes
 *
 * A model asked to pull figures out of a filing will return well-formed JSON
 * containing numbers that are not in the filing. Schema validation does not
 * catch this — a fabricated number is a perfectly valid `number`. What catches
 * it is requiring every extracted fact to carry a CITATION, and then checking
 * the citation mechanically against the source text.
 *
 * So extraction here is two gates, not one:
 *
 * 1. **Shape** — validated by zod at the boundary, like every other model output
 *    in this repo (`model-call.ts`). Malformed replies are dropped, not repaired.
 * 2. **Grounding** — the cited chunk must exist, the quoted span must appear
 *    verbatim inside that chunk, and the claimed value must appear inside the
 *    quote. A fact that fails is REJECTED and counted, never merely flagged.
 *
 * The second gate is deterministic and runs without a model, which is the only
 * reason it is worth anything: a verifier that asks a model whether the model
 * was right is just the same coin flipped twice.
 *
 * ## What this does and does not prove
 *
 * It proves the number was COPIED rather than invented, and it localizes it to a
 * span a human can audit in one click. It does not prove the number was
 * INTERPRETED correctly — a value truthfully quoted from the wrong column, or
 * from the prior-year comparative, passes every check here. That failure mode is
 * real and is left explicitly out of scope rather than papered over; catching it
 * needs the golden question set in `benchmarks/finance/`, where the right answer
 * is known independently.
 *
 * Stating it plainly: this converts hallucination from an invisible failure into
 * a counted one. The counter is `GroundingReport.rejected`, and it is reported
 * on every run rather than only when it is flattering.
 */
import { z } from "zod";
import type { Chunk } from "./corpus.js";
import { parseClaudeEnvelope, stripJsonFence } from "./model-call.js";

/**
 * One extracted financial fact.
 *
 * `quote` is mandatory and is the load-bearing field. Making it optional — or
 * letting the model summarize instead of quote — removes the only evidence the
 * verifier has, and an unverifiable extraction pipeline is the thing this module
 * exists to not be.
 */
export const factSchema = z.object({
	/** What was measured, e.g. "total revenue", "operating margin". */
	metric: z.string().min(1).max(120),
	/**
	 * The reporting period the value belongs to, e.g. "Q3 2024", "FY2023".
	 * Free text: filings label periods inconsistently and normalizing here would
	 * silently discard the document's own wording, which is what a human auditor
	 * needs to see.
	 *
	 * OPTIONAL, and the bound is generous — both learned from a real burn. The
	 * original `min(1).max(60)` was designed for income-statement facts, which
	 * always have a period, and then applied to every fact. It rejected the two
	 * cross-document questions outright:
	 *
	 * - `fin-06` returned `period: ""` because a COVENANT THRESHOLD has no
	 *   period. "Restricted Payments are permitted below 3.25 to 1.00" is a
	 *   standing limit, not a quarterly figure. Demanding a period there forces
	 *   the model to invent one, which is the opposite of what this module wants.
	 * - `fin-11` exceeded 60 characters, because covenant periods are phrases
	 *   ("as of the last day of any fiscal quarter following a Material
	 *   Acquisition") rather than labels.
	 *
	 * So the schema was rejecting the answer SHAPE that the multi-hop questions
	 * require — a validation bound doubling as an unstated domain assumption.
	 */
	period: z.string().max(160).default(""),
	value: z.number().finite(),
	/** Scale/unit as stated by the document: "millions", "%", "x", "bps". */
	unit: z.string().max(40).default(""),
	currency: z.string().max(10).default(""),
	/** The `chunkId` this came from — must resolve against the corpus. */
	chunkId: z.string().min(1).max(400),
	/** Verbatim span from that chunk containing the value. */
	quote: z.string().min(1).max(600),
});

export type Fact = z.infer<typeof factSchema>;

/**
 * The model is asked for this envelope. A bare array is also tolerated on
 * parse, because that is the single most common shape drift and rejecting it
 * would discard good extractions over punctuation.
 *
 * `facts` is validated PER ELEMENT rather than as a whole (see `parseFacts`),
 * so this shape only pins the envelope.
 */
const envelopeShape = z.object({ facts: z.array(z.unknown()).max(200) });

/** Why a fact was rejected. Kept as a closed set so the report can aggregate
 * failure MODES rather than just a count — "the citations do not resolve" and
 * "the numbers are not in the quotes" call for different fixes. */
export type RejectionReason =
	| "unknown-chunk"
	| "quote-not-in-chunk"
	| "value-not-in-quote";

export interface RejectedFact {
	fact: Fact;
	reason: RejectionReason;
}

export interface GroundingReport {
	accepted: Fact[];
	rejected: RejectedFact[];
	/** Facts dropped by the SCHEMA before grounding could be checked. Reported
	 * separately from `rejected` because the two mean different things: a
	 * malformed fact is a shape problem (often ours — see `period`), an
	 * ungrounded one is a truth problem. Folding them together would hide a
	 * schema bug inside a hallucination metric. */
	malformed: number;
	/** `accepted / (accepted + rejected)`; 1 when nothing was extracted, since
	 * an empty extraction has no ungrounded claims in it. Reported alongside the
	 * counts precisely so an empty result cannot masquerade as a perfect one. */
	groundedness: number;
}

/**
 * Normalize text for verbatim comparison.
 *
 * Whitespace is collapsed and case is folded, because a model re-wrapping a
 * quote across lines is a formatting artifact and not a fabrication. Nothing
 * else is normalized: digits, currency symbols and minus signs are compared as
 * written, since those are the parts a fabrication would get wrong.
 */
export function normalizeForMatch(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Does `value` appear in `text` as a human would have written it?
 *
 * Documents write one number many ways — `1204.5`, `1,204.5`, `$1,204.5`,
 * `(1,204.5)` for negatives in accounting notation, or `1.2045` under a
 * "billions" column header. Each accepted rendering is enumerated rather than
 * approximated with a tolerance window, because a tolerance is exactly how a
 * verifier starts accepting numbers that are merely CLOSE to something in the
 * document, which is the failure it is meant to catch.
 *
 * Accounting parentheses are honored for negatives only — `(500)` matches -500,
 * never +500 — so the sign convention cannot be laundered by the check itself.
 *
 * ## The rounding hole, closed 2026-08-13
 *
 * The trailing-zero variants were generated with `toFixed(dp)` under the single
 * guard `n >= 10 ** -dp`, which admits every rendering the value ROUNDS to as
 * well as every rendering it pads to. That is a tolerance window of half a unit
 * in the last place — exactly the thing the paragraph above says this function
 * refuses to have — and it was doing real damage:
 *
 * - `valueAppearsIn(3.25, ...)` matched `3.0x` (via `"3"`)
 * - `valueAppearsIn(3.75, ...)` matched `4.1 million shares` (via `"4"`)
 * - `valueAppearsIn(14.5, ...)` matched `roughly 15 to 18` (via `"15"`)
 *
 * All three are from the shipped `benchmarks/finance` suite, and all three were
 * being counted as "the answer was retrieved". A rendering is now kept only when
 * it round-trips to the exact value, so `1.2` still matches `1.20` (padding is
 * lossless) and no longer matches `1` (rounding is not).
 */
export function valueAppearsIn(value: number, text: string): boolean {
	const hay = text.replace(/,/g, "");
	const abs = Math.abs(value);
	const renderings = new Set<string>();
	for (const n of [abs, abs / 1_000, abs / 1_000_000, abs / 1_000_000_000]) {
		if (!Number.isFinite(n)) continue;
		renderings.add(String(n));
		// Trailing-zero variants: a document writing "1.20" is the same figure
		// as a model reporting 1.2. Kept only when the rendering reads back as the
		// same number, so padding is admitted and rounding is not.
		for (const dp of [0, 1, 2, 3]) {
			const padded = n.toFixed(dp);
			if (Number(padded) === n) renderings.add(padded);
		}
	}
	for (const r of renderings) {
		if (r === "" || r === "0") continue;
		// Bounded by non-digit context so 20.4 does not match inside 120.45.
		const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(`(^|[^0-9.])${escaped}([^0-9]|$)`);
		if (re.test(hay)) {
			if (value >= 0) return true;
			// Negative: require an explicit minus or accounting parentheses.
			const neg = new RegExp(`(-\\s*|\\(\\s*)${escaped}`);
			if (neg.test(hay)) return true;
		}
	}
	return value === 0 && /(^|[^0-9.])0([^0-9]|$)/.test(hay);
}

/**
 * Check every fact against the corpus it claims to come from.
 *
 * Pure and model-free by design — see the module header.
 */
export function verifyGrounding(
	facts: Fact[],
	chunks: Chunk[],
	malformed = 0,
): GroundingReport {
	const byId = new Map(chunks.map((c) => [c.chunkId, c]));
	const accepted: Fact[] = [];
	const rejected: RejectedFact[] = [];
	for (const fact of facts) {
		const chunk = byId.get(fact.chunkId);
		if (chunk === undefined) {
			rejected.push({ fact, reason: "unknown-chunk" });
			continue;
		}
		if (
			!normalizeForMatch(chunk.text).includes(normalizeForMatch(fact.quote))
		) {
			rejected.push({ fact, reason: "quote-not-in-chunk" });
			continue;
		}
		if (!valueAppearsIn(fact.value, fact.quote)) {
			rejected.push({ fact, reason: "value-not-in-quote" });
			continue;
		}
		accepted.push(fact);
	}
	const total = accepted.length + rejected.length;
	return {
		accepted,
		rejected,
		malformed,
		groundedness: total === 0 ? 1 : accepted.length / total,
	};
}

/**
 * Parse a model reply into facts. Fails closed with a reason, never throws.
 *
 * Tolerates a bare array and a markdown fence — both are shape drift rather than
 * content problems, and rejecting them would throw away sound extractions. It
 * does NOT tolerate anything that changes meaning: a fact missing its citation
 * is dropped by the schema, because an uncitable fact cannot be verified and an
 * unverified fact is what this module refuses to emit.
 */
export function parseFacts(
	replyText: string,
):
	| { ok: true; facts: Fact[]; malformed: number }
	| { ok: false; reason: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(stripJsonFence(replyText));
	} catch {
		return { ok: false, reason: "extraction reply was not JSON" };
	}
	const envelope = envelopeShape.safeParse(
		Array.isArray(raw) ? { facts: raw } : raw,
	);
	if (!envelope.success) {
		return { ok: false, reason: "extraction reply was not a facts envelope" };
	}
	// PER-FACT validation. The all-or-nothing version discarded every fact in a
	// reply because ONE of them had a malformed field, which is how a single
	// over-long `period` string threw away correctly cited figures alongside it.
	// Dropping the bad element and keeping the rest is not leniency — it is the
	// same rule `verifyGrounding` already applies, which rejects individual
	// facts rather than the batch. A malformed fact is still never repaired and
	// never emitted; it is counted.
	const facts: Fact[] = [];
	let malformed = 0;
	for (const candidate of envelope.data.facts) {
		const parsed = factSchema.safeParse(candidate);
		if (parsed.success) facts.push(parsed.data);
		else malformed++;
	}
	return { ok: true, facts, malformed };
}

/** Parse a raw `claude -p --output-format json` stdout straight through to
 * verified facts — the envelope boundary and the fact boundary in one call, so
 * no caller is tempted to skip one of them. */
export function extractFromStdout(
	stdout: string | undefined,
	chunks: Chunk[],
): { ok: true; report: GroundingReport } | { ok: false; reason: string } {
	const envelope = parseClaudeEnvelope(stdout);
	if (!envelope.ok) return { ok: false, reason: envelope.reason };
	const parsed = parseFacts(envelope.result);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	return {
		ok: true,
		report: verifyGrounding(parsed.facts, chunks, parsed.malformed),
	};
}

/**
 * The extraction instruction.
 *
 * Two things in here are deliberate. It demands the citation and the verbatim
 * quote FIRST, before the value, because asking for evidence after the claim
 * invites the evidence to be written to fit. And it explicitly licenses an empty
 * answer: a pipeline that cannot say "not in these documents" will always find
 * something, and on a retrieval miss that something is invented.
 */
export function buildExtractionPrompt(
	question: string,
	context: string,
): string {
	return `You are extracting financial facts from source documents. Answer ONLY from the documents below.

Documents (each block is labeled with its chunk id in square brackets):

${context}

Question: ${question}

Return JSON only, no prose, in this exact shape:
{"facts":[{"chunkId":"<the [id] of the block you used>","quote":"<verbatim text from that block containing the number>","metric":"<what was measured>","period":"<period as the document labels it>","value":<number>,"unit":"<millions|%|x|bps|empty>","currency":"<USD|EUR|empty>"}]}

Rules:
- Every fact MUST cite the chunkId it came from and quote the source text verbatim. Facts without a resolvable citation are discarded.
- The value MUST appear inside your quote. Do not compute, convert, or infer values that are not written in the documents.
- If the documents do not answer the question, return {"facts":[]}. An empty answer is correct and expected when the documents are silent.`;
}
