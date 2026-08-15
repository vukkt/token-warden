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
import { benchChildEnv } from "./bench.js";
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
	/** True when the failure was the environment refusing work rather than a
	 * bad answer. A run with this set must never be scored. */
	environmentFailure: boolean;
}

/** The subset of `spawnSync` this module depends on, narrowed so tests can
 * drive the loop deterministically without a real `claude` — the same seam
 * `bench.ts` uses for `runOnce`. */
export type SpawnLike = (
	command: string,
	args: string[],
	options: Record<string, unknown>,
) => {
	status: number | null;
	stdout?: string;
	stderr?: string;
	error?: Error;
};

/**
 * A model call that failed, with enough detail to tell WHY.
 *
 * The first end-to-end burn returned the bare string "model call failed" 24
 * times, which was true and useless: it could not distinguish a rate limit from
 * a bad flag from a crash. The exit status and the head of stderr are what turn
 * a failed run into a diagnosable one, so they are carried rather than dropped.
 */
export interface CallFailure {
	reason: string;
	/** True when the failure looks like the ENVIRONMENT dying (rate limit,
	 * overload, auth, quota) rather than this particular request being bad.
	 * Callers use it to abort a whole run instead of scoring it. */
	environmental: boolean;
}

/** Signatures that mean "the environment is refusing work", not "this request
 * was wrong". Matched case-insensitively against the CLI's own stderr. */
const ENVIRONMENTAL_SIGNATURES = [
	"rate limit",
	"rate_limit",
	"429",
	"overloaded",
	"529",
	"quota",
	"usage limit",
	"insufficient credit",
	"authentication",
	"401",
	"503",
	"econnreset",
	"etimedout",
	"socket hang up",
];

/**
 * Classify a failed call.
 *
 * Two ways to be environmental:
 *
 * 1. A known signature in the diagnostic text (rate limit, 429/529, quota,
 *    auth, socket errors).
 * 2. **A non-zero exit with NO diagnostic output at all.** Added after the third
 *    agent burn, where 6 of 12 calls died as `exited 1 with no stderr` and the
 *    guard stayed silent because nothing matched a signature — so the run
 *    neither retried nor aborted, and produced a half-empty table that looked
 *    like a measurement. A CLI rejecting a genuinely bad request SAYS SO; silence
 *    plus a non-zero status is infrastructure, not an argument error. The same
 *    prompt shape succeeded on other questions in the same run, which is the
 *    evidence for reading it that way.
 *
 * The default remains environmental=false for anything that produced a real
 * error message, so a genuine defect is never laundered into "the environment
 * died".
 */
export function classifyFailure(
	status: number | null,
	stderr: string | undefined,
	error: Error | undefined,
): CallFailure {
	const text = `${error?.message ?? ""} ${stderr ?? ""}`.toLowerCase();
	const detail = (stderr ?? error?.message ?? "").trim().slice(0, 300);
	const silentFailure = detail === "" && status !== 0;
	const environmental =
		silentFailure || ENVIRONMENTAL_SIGNATURES.some((sig) => text.includes(sig));
	return {
		reason:
			detail === ""
				? `claude exited ${status ?? "on a signal"} with no stderr`
				: `claude exited ${status ?? "on a signal"}: ${detail}`,
		environmental,
	};
}

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

/**
 * The planning instruction for one hop.
 *
 * ## Why this was rewritten (2026-07-28, after the first real burn)
 *
 * The original ended with "Search again ONLY if the excerpts are missing
 * something specific you can name", which read as an instruction to stop. It
 * worked exactly as written: across all 12 golden questions the agent replied
 * `{"done":true}` on the first hop, every time. `hops` was 1.0 for the whole
 * suite. The multi-hop arm had degenerated into single-shot bm25 plus one wasted
 * planning call — it was being BILLED as an architecture and was not running as
 * one, which is worse than not having it.
 *
 * The fix is not "encourage searching". An arm biased toward hopping would burn
 * a model call per question to reach the same answer, and this project does not
 * get to buy a nicer number with tokens it did not need. The fix is to make the
 * decision CONCRETE: name what the question requires, then check each required
 * part against what has actually been retrieved. A question whose parts are all
 * present still stops on the first hop, which is correct and cheap.
 *
 * Two specifics carry most of the weight:
 *
 * - **Questions can have more than one part, in different vocabulary.** This is
 *   the case single-shot retrieval structurally cannot serve, and it is invisible
 *   unless the model is asked to decompose first. The example given is concrete
 *   rather than abstract because "check if anything is missing" is exactly the
 *   instruction that produced 12 first-hop stops.
 * - **Search in the language of the MISSING document, not the question.** A
 *   follow-up that re-uses the question's words re-retrieves the chunks already
 *   read; the dedupe then makes that hop free of information but not of cost.
 *
 * The decline path is preserved deliberately: `{"done":true}` remains correct
 * when the corpus does not cover the question. Two of the twelve golden
 * questions are unanswerable, and an agent that cannot stop will search four
 * times and then fabricate.
 */
export function buildPlanPrompt(
	question: string,
	seen: string,
	hopsLeft: number,
): string {
	return `You are answering a question from a document corpus by searching it.

Question: ${question}

Excerpts retrieved so far:

${seen === "" ? "(nothing yet)" : seen}

You have ${hopsLeft} search(es) left.

First, work out what the question REQUIRES. A question often needs more than one fact, and the parts are frequently stated in different documents using different vocabulary — a credit agreement may say "Restricted Payments" and "3.25 to 1.00" where an annual report says "repurchased shares" and "2.6x". Take each required part in turn and check whether it is actually present in the excerpts above.

Reply with JSON only, one of:
{"search":"<keywords for the part that is missing>"} - if any required part is NOT in the excerpts above
{"done":true} - if every required part is present, or the corpus plainly does not cover this question

When you search, use the words the MISSING document would use, not the words of the question. Repeating the question's own wording returns the excerpts you have already read.`;
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

/** Delay before retry N, in ms. Exponential with a fixed base — a transient
 * rate limit clears on a timescale of seconds, and the first burn showed that
 * ZERO backoff turns one 429 into a cascade that kills every remaining call. */
export function backoffMs(attempt: number): number {
	return 2000 * 2 ** (attempt - 1);
}

/** Attempts per call, including the first. Three is enough to ride out a brief
 * limit and few enough that a genuinely dead environment fails fast rather than
 * spending minutes proving it. */
export const MAX_ATTEMPTS = 3;

/** Block the calling thread. Deliberately synchronous: this whole module is
 * sync (spawnSync), and making it async to sleep would restructure the loop
 * for no measurement benefit. Only ever reached on a retry path. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type CallResult =
	| { ok: true; text: string }
	| { ok: false; failure: CallFailure };

/**
 * One `claude -p` call, with bounded retry on ENVIRONMENTAL failures only.
 *
 * Retrying is deliberately narrow. A rate limit or an overloaded upstream is
 * worth waiting out; a malformed prompt or a bad flag will fail identically
 * three times and only wastes wall-clock. So a non-environmental failure
 * returns immediately, and only the signatures in `ENVIRONMENTAL_SIGNATURES`
 * buy another attempt.
 *
 * Exported so the burn path and the tests exercise the same call, and so the
 * retry behaviour is testable without a real `claude`.
 */
export function callClaude(
	spawn: SpawnLike,
	prompt: string,
	sleep: ((ms: number) => void) | undefined = sleepSync,
): CallResult {
	let last: CallFailure = { reason: "never attempted", environmental: false };
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
			{
				encoding: "utf8",
				timeout: HOP_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				// Strip the parent Claude Code session identity. bench.ts learned
				// this the expensive way: an inherited session let a child bind to
				// the parent transcript and froze a 30.4M-token false baseline.
				// Nothing here is measured in child token counts, so the blast
				// radius is smaller — but a benchmark child that can see the parent
				// conversation is not answering from the retrieved context alone,
				// which would silently invalidate the accuracy number.
				env: benchChildEnv(),
			},
		);
		// Exit code, not output tail, is the failure signal — the repo's error
		// ledger records this lesson explicitly.
		if (result.error === undefined && result.status === 0) {
			const envelope = parseClaudeEnvelope(result.stdout);
			if (envelope.ok) return { ok: true, text: envelope.result };
			// A well-formed process that returned an error envelope (quota death
			// reports this way) is still an environment signal, so it is
			// classified rather than treated as a bad reply.
			last = classifyFailure(0, envelope.reason, undefined);
		} else {
			last = classifyFailure(result.status, result.stderr, result.error);
		}
		if (!last.environmental || attempt === MAX_ATTEMPTS) break;
		sleep(backoffMs(attempt));
	}
	return { ok: false, failure: last };
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
	options: {
		spawn?: SpawnLike;
		index?: LexicalIndex;
		maxHops?: number;
		/** Injected so tests exercise the retry path without real backoff. */
		sleep?: (ms: number) => void;
	} = {},
): InterrogationResult {
	const spawn = options.spawn ?? defaultSpawn;
	const sleep = options.sleep ?? sleepSync;
	const index = options.index ?? buildIndex(corpus.chunks);
	const maxHops = options.maxHops ?? MAX_HOPS;

	const queries: string[] = [];
	const seenIds = new Set<string>();
	let seen = "";
	let contextTokens = 0;
	let hops = 0;

	/** Fail closed, carrying the work already paid for. The counters are read at
	 * call time, so a failure still reports the hops and context it spent. */
	const failed = (
		error: string,
		environmentFailure: boolean,
	): InterrogationResult => ({
		question,
		queries,
		hops,
		contextTokens,
		report: null,
		error,
		environmentFailure,
	});

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
			sleep,
		);
		if (!plan.ok) {
			return failed(
				`planning call failed: ${plan.failure.reason}`,
				plan.failure.environmental,
			);
		}
		const parsed = parsePlan(plan.text);
		if (parsed.kind !== "search") break;
		query = parsed.query;
	}

	const answer = callClaude(
		spawn,
		buildExtractionPrompt(question, seen),
		sleep,
	);
	if (!answer.ok) {
		return failed(
			`extraction call failed: ${answer.failure.reason}`,
			answer.failure.environmental,
		);
	}
	const facts = parseFacts(answer.text);
	if (!facts.ok) {
		// A process that ran fine but returned unparseable CONTENT is a model
		// problem, not an environment one.
		return failed(facts.reason, false);
	}
	return {
		question,
		queries,
		hops,
		contextTokens,
		report: verifyGrounding(facts.facts, corpus.chunks, facts.malformed),
		error: null,
		environmentFailure: false,
	};
}
