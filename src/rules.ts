/**
 * The rule vocabulary: what a rule body IS, what it costs, and when two of
 * them are the same rule.
 *
 * Extracted from `distill.ts` because that module had become a hub by
 * accident. `adopt.ts`, `compress.ts`, `protect.ts`, `sample-tasks.ts` and
 * `scope.ts` all imported the distiller solely to reach these pure text
 * helpers, and thereby took a dependency on `spawnSync`, the prompt builder
 * and the DB layer.
 *
 * ALL FIVE OF THOSE CALLERS WERE DELETED IN v1.0.0, and the history is kept
 * only because it is why the seam is here. The current importers are
 * `distill.ts` and `memory.ts` — the second one is the reason the split still
 * earns its place, since `memory.ts` reaches `trigramSimilarity` for the
 * packer and must not pull the distiller's subprocess machinery in to do it.
 * Nothing here touches the database, the filesystem, the environment, or a
 * subprocess.
 */
import { z } from "zod";
import { CHARS_PER_TOKEN } from "./stats.js";

/** Jaccard similarity above which two bodies are treated as the same rule. */
export const SIMILARITY_THRESHOLD = 0.85;

function characterTrigrams(text: string): Set<string> {
	const normalized = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	const padded = `  ${normalized} `;
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= padded.length; i++) {
		grams.add(padded.slice(i, i + 3));
	}
	return grams;
}

/**
 * Jaccard similarity over character trigrams, in [0, 1].
 *
 * There is no empty-gram-set case to guard. `characterTrigrams` pads to
 * `"  " + normalized + " "`, so `padded.length` is always `normalized.length + 3`
 * and the loop always adds at least one gram -- a string that normalises to
 * nothing still yields `{"   "}`. An `if (size === 0)` branch stood here and was
 * unreachable.
 *
 * It also disagreed with the code around it, which is why it is deleted rather
 * than left as harmless defence. For `("!!!", "???")` the dead branch would have
 * returned 0, comparing the trimmed strings and finding them different; the live
 * path returns 1, because both normalise to the same single padding trigram. The
 * live answer is the right one for the two callers: content-free strings carry no
 * distinguishing information, so treating them as maximally similar is what the
 * distiller's dedupe and the packer's redundancy signal both want.
 */
export function trigramSimilarity(a: string, b: string): number {
	const gramsA = characterTrigrams(a);
	const gramsB = characterTrigrams(b);
	let intersection = 0;
	for (const gram of gramsA) {
		if (gramsB.has(gram)) intersection++;
	}
	return intersection / (gramsA.size + gramsB.size - intersection);
}

/** Shortest and longest acceptable rule body, in characters. The floor keeps
 * a truncated fragment from becoming a rule; the ceiling bounds rent. */
const MIN_RULE_BODY_CHARS = 10;
const MAX_RULE_BODY_CHARS = 200;

/**
 * Code-point ranges (inclusive) a rule body must never contain.
 *
 * A body is rendered into the compiled MEMORY.md that goes into the agent's
 * prompt, into log lines, into the status report, and back into the distiller
 * prompt as feedback. So anything that can fake structure, hide its real
 * content, or corrupt on write is rejected at the boundary rather than
 * sanitized: a rule the model cannot state in plain printable text is not a
 * rule worth spending a benchmark on.
 *
 * Expressed as numeric ranges rather than a regex literal on purpose — the
 * characters guarded against are exactly the ones that would be invisible,
 * or unrepresentable, in this source file.
 */
const FORBIDDEN_BODY_RANGES: readonly (readonly [number, number])[] = [
	// C0 controls: newline (a body must stay one line), tab, ANSI ESC.
	[0x00, 0x1f],
	// DEL plus the C1 control block.
	[0x7f, 0x9f],
	// Zero-width space/non-joiner/joiner and the LTR/RTL marks.
	[0x200b, 0x200f],
	// LINE SEPARATOR / PARAGRAPH SEPARATOR: real line terminators to JS and
	// to many renderers, so they fake structure exactly as a newline would.
	[0x2028, 0x2029],
	// Bidi embeddings and overrides, and bidi isolates (Trojan Source): the
	// rule a human reviews in the status report would differ from the rule
	// the agent is actually given.
	[0x202a, 0x202e],
	[0x2066, 0x2069],
	// Surrogate code units. Unpaired ones corrupt when written to MEMORY.md;
	// paired ones are astral-plane characters, which for a one-sentence
	// English efficiency rule means emoji — banned project-wide.
	[0xd800, 0xdfff],
	// ZERO WIDTH NO-BREAK SPACE / BOM: invisible, and it inflates rent.
	[0xfeff, 0xfeff],
	// REPLACEMENT CHARACTER: the reply was not valid UTF-8, so the text is
	// already corrupt and must not become a rule.
	[0xfffd, 0xfffd],
];

/** True when `body` contains any character a rule body may not carry. */
export function hasForbiddenChar(body: string): boolean {
	for (let i = 0; i < body.length; i++) {
		const code = body.charCodeAt(i);
		for (const [low, high] of FORBIDDEN_BODY_RANGES) {
			if (code >= low && code <= high) return true;
		}
	}
	return false;
}

/**
 * The single definition of a well-formed rule body: one trimmed, printable,
 * length-bounded line. Every path that can put a rule into the ledger imports
 * this — the distiller, the compression rewriter, the ledger importer, and
 * `/warden-protect --add` — so they cannot drift on what counts as a valid
 * rule. That drift was a real defect: the rewriter once accepted bidi
 * overrides and zero-width characters the distiller rejected, on the path with
 * the higher consequence.
 */
export const ruleBodySchema = z
	.string()
	.trim()
	.min(MIN_RULE_BODY_CHARS)
	.max(MAX_RULE_BODY_CHARS)
	.refine((body) => !hasForbiddenChar(body), {
		message:
			"rule body must be a single printable line (no control, zero-width, bidi, or astral characters)",
	});

/**
 * A rule's context rent: the tokens it costs merely to sit in the prompt,
 * estimated at four characters per token.
 *
 * This is the denominator of the entire product. The gate compares a measured
 * saving against `effectiveRent` (`stats.ts`), which builds on this.
 */
export function contextCost(body: string): number {
	return Math.ceil(body.length / CHARS_PER_TOKEN);
}
