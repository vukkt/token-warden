/**
 * Agent-based corpus interrogation: the multi-hop arm.
 *
 * ## Why a third architecture
 *
 * `full` and `bm25` both assemble context ONCE, from the question as asked. That
 * is sufficient for a lookup and structurally insufficient for a question whose
 * two halves share no vocabulary. The shipped suite has such a question
 * (`fin-06`): the covenant document says "Restricted Payments" and "3.25 to
 * 1.00", the annual report says "repurchased 4.1 million shares" and "2.6x", and
 * no single query retrieves both. Answering it requires reading the covenant,
 * learning the threshold, and THEN searching for the leverage ratio — a second
 * query that could not have been written before the first one returned.
 *
 * That is the whole case for an agentic pipeline, and it is narrower than the
 * usual pitch. Multi-hop wins where the second query depends on the first
 * result. Everywhere else it pays extra model round-trips for nothing, which is
 * why this is measured against the cheaper arms rather than assumed better.
 *
 * ## Cost honesty
 *
 * A multi-hop run costs more than its retrieved context: every hop is a model
 * call with its own input and output tokens, and the conversation grows as hops
 * accumulate. `InterrogationResult.contextTokens` counts retrieved context so it
 * is comparable with the single-shot arms, and `hops` is reported alongside so
 * the extra round-trips are never hidden inside a context-token figure that
 * looks competitive. Comparing a 4-hop agent's context tokens against a
 * mega-prompt's without mentioning the hop count would be exactly the kind of
 * flattering accounting this project exists to refuse.
 */
import { spawnSync } from "node:child_process";
import type { Corpus } from "./corpus.js";
import {
	buildExtractionPrompt,
	type GroundingReport,
	parseFacts,
	verifyGrounding,
} from "./extract.js";
import { distillModel, parseClaudeEnvelope } from "./model-call.js";
import {
	buildIndex,
	type LexicalIndex,
	renderContext,
	retrieveBm25,
} from "./retrieve.js";

/**
 * Hard ceiling on hops.
 *
 * Four is enough for the deepest question in the shipped suite (read covenant ->
 * find threshold -> search leverage -> answer) with one hop of slack. The cap is
 * a COST control, not a quality tuning knob: an agent that has not converged in
 * four hops is looping, and each additional hop costs a full model call whose
 * value is unproven. It is deliberately low.
 */
export const MAX_HOPS = 4;

/** Per-hop retrieval budget, in tokens. Lower than the single-shot budget
 * because a multi-hop run pays it several times over. */
const HOP_BUDGET = 800;

const HOP_TIMEOUT_MS = 120_000;

/** What one interrogation produced. */
export interface InterrogationResult {
	question: string;
	/** Queries the agent actually issued, in order. Recorded because the
	 * second query is the entire justification for this architecture, and an
	 * agent that only ever re-asks the original question is not multi-hop —
	 * it is a single-shot pipeline with extra round-trips. */
	queries: string[];
	hops: number;
	/** Retrieved context tokens, summed across hops. Comparable with the
	 * single-shot arms; see the module header on why `hops` must be read
	 * alongside it. */
	contextTokens: number;
	report: GroundingReport | null;
	/** Set when the run failed. Failing closed with a reason, never a throw. */
	error: string | null;
}

/** The subset of `spawnSync` this module depends on, narrowed so tests can
 * drive the loop deterministically without a real `claude` — the same seam
 * `bench.ts` uses for `runOnce`. */
export type SpawnLike = (
	command: string,
	args: string[],
	options: Record<string, unknown>,
) => { status: number | null; stdout?: string; error?: Error };

/**
 * Ask the model what to search for next, given what it has seen.
 *
 * The reply is one of two shapes — another search, or a declaration that it has
 * enough. Both are parsed strictly; anything else ends the loop rather than
 * being guessed at, because a misparsed control reply would silently turn a
 * multi-hop run into an infinite one.
 */
export function parsePlan(
	replyText: string,
):
	| { kind: "search"; query: string }
	| { kind: "answer" }
	| { kind: "invalid" } {
	let raw: unknown;
	try {
		raw = JSON.parse(
			replyText
				.trim()
				.replace(/^```(?:json)?/i, "")
				.replace(/```$/, ""),
		);
	} catch {
		return { kind: "invalid" };
	}
	if (typeof raw !== "object" || raw === null) return { kind: "invalid" };
	const obj = raw as Record<string, unknown>;
	if (obj.done === true) return { kind: "answer" };
	if (typeof obj.search === "string" && obj.search.trim() !== "") {
		return { kind: "search", query: obj.search.slice(0, 400) };
	}
	return { kind: "invalid" };
}

/** The planning instruction for one hop. */
export function buildPlanPrompt(
	question: string,
	seen: string,
	hopsLeft: number,
): string {
	return `You are answering a question from a document corpus by searching it.

Question: ${question}

Excerpts retrieved so far:

${seen === "" ? "(nothing yet)" : seen}

You have ${hopsLeft} search(es) left. Reply with JSON only, one of:
{"search":"<keywords for the next search>"} - to retrieve more
{"done":true} - when the excerpts above already contain everything needed

Search again ONLY if the excerpts are missing something specific you can name. If the excerpts answer the question, or if the corpus plainly does not cover it, reply {"done":true}.`;
}

/** `spawnSync` adapted to `SpawnLike`. The cast is confined to this one line:
 * `encoding: "utf8"` is passed at every call site, so `stdout` is a string at
 * runtime, but the overload the compiler picks for a `Record<string, unknown>`
 * options bag cannot know that. */
export const defaultSpawn: SpawnLike = (command, args, options) => {
	const r = spawnSync(command, args, options);
	return {
		status: r.status,
		stdout: typeof r.stdout === "string" ? r.stdout : r.stdout?.toString(),
		error: r.error,
	};
};

function callClaude(spawn: SpawnLike, prompt: string): string | null {
	const result = spawn(
		"claude",
		[
			"-p",
			prompt,
			"--model",
			distillModel(),
			"--max-turns",
			"1",
			"--output-format",
			"json",
		],
		{ encoding: "utf8", timeout: HOP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
	);
	// Exit code, not output tail, is the failure signal — the repo's error
	// ledger records this lesson explicitly.
	if (result.error !== undefined || result.status !== 0) return null;
	const envelope = parseClaudeEnvelope(result.stdout);
	return envelope.ok ? envelope.result : null;
}

/**
 * Run one multi-hop interrogation.
 *
 * The loop is bounded twice over — by `MAX_HOPS` and by a strict parse of the
 * control reply — so it terminates on a model that never says it is done and on
 * a model that returns garbage.
 */
export function interrogate(
	corpus: Corpus,
	question: string,
	options: { spawn?: SpawnLike; index?: LexicalIndex; maxHops?: number } = {},
): InterrogationResult {
	const spawn = options.spawn ?? defaultSpawn;
	const index = options.index ?? buildIndex(corpus.chunks);
	const maxHops = options.maxHops ?? MAX_HOPS;

	const queries: string[] = [];
	const seenIds = new Set<string>();
	let seen = "";
	let contextTokens = 0;
	let hops = 0;

	// The first query is always the question itself: there is nothing yet to
	// base a smarter one on, and spending a model call to rephrase a question
	// before any evidence exists is a round-trip that buys nothing.
	let query = question;

	while (hops < maxHops) {
		hops++;
		queries.push(query);
		const retrieval = retrieveBm25(index, query, HOP_BUDGET);
		// Deduplicate across hops: re-retrieving a chunk the agent has already
		// read costs tokens and adds no information, and without this an agent
		// that repeats a query pays for the same context twice.
		const fresh = retrieval.chunks.filter((c) => !seenIds.has(c.chunkId));
		for (const c of fresh) seenIds.add(c.chunkId);
		const freshTokens = fresh.reduce((a, c) => a + c.tokens, 0);
		contextTokens += freshTokens;
		if (fresh.length > 0) {
			seen += `${seen === "" ? "" : "\n\n"}${renderContext({ ...retrieval, chunks: fresh, tokens: freshTokens })}`;
		}

		if (hops >= maxHops) break;
		const plan = callClaude(
			spawn,
			buildPlanPrompt(question, seen, maxHops - hops),
		);
		if (plan === null) {
			return {
				question,
				queries,
				hops,
				contextTokens,
				report: null,
				error: "planning call failed",
			};
		}
		const parsed = parsePlan(plan);
		if (parsed.kind !== "search") break;
		query = parsed.query;
	}

	const answer = callClaude(spawn, buildExtractionPrompt(question, seen));
	if (answer === null) {
		return {
			question,
			queries,
			hops,
			contextTokens,
			report: null,
			error: "extraction call failed",
		};
	}
	const facts = parseFacts(answer);
	if (!facts.ok) {
		return {
			question,
			queries,
			hops,
			contextTokens,
			report: null,
			error: facts.reason,
		};
	}
	return {
		question,
		queries,
		hops,
		contextTokens,
		report: verifyGrounding(facts.facts, corpus.chunks),
		error: null,
	};
}
