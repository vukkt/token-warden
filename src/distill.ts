/**
 * Distiller: turn one unusually expensive run into 0–2 candidate rules.
 *
 * CLI: npx tsx src/distill.ts --run <runs.id> --transcript <path> [--k <1-3>]
 *
 * Spawned detached by collect.ts when a run's total tokens exceed the
 * agent's rolling p75 (minimum 5 prior runs). One headless model call
 * (distillModel(), default sonnet),
 * strict-JSON output, zod-validated; invalid output is logged and dropped —
 * never retried (spec §3.1). Candidates land in SQLite with
 * context_cost = ceil(len/4); near-duplicates (>0.85 trigram similarity to
 * any existing rule for the agent) are skipped.
 *
 * Best-of-K (--k, or TOKEN_WARDEN_DISTILL_K): sample the distiller K times
 * and pool the distinct proposals, exploiting proposal stochasticity. K is
 * capped at 3 because every distinct candidate costs a full benchmark to
 * measure; near-identical samples are collapsed before any insert.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
	defaultDbPath,
	getActiveRules,
	insertRule,
	listRulesByAgent,
	openDb,
	RUN_TOTAL_TOKENS_SQL,
	type RunRow,
	recentEvictedRules,
	recentQuestionsFrom,
	type WardenDb,
} from "./db.js";
import { knownAgents } from "./registry.js";
import { digestTranscript } from "./transcript.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SIMILARITY_THRESHOLD = 0.85;
const MIN_PRIOR_RUNS = 5;
/** Most recent evicted rules fed back into the distiller prompt as measured
 * negative examples. Bounded so the feedback block cannot grow without limit
 * as the negative dataset accumulates. */
const MAX_EVICTED_FEEDBACK = 8;
/** Rolling window of most recent runs used for the p75. */
const ROLLING_WINDOW = 50;
const MAX_DIGEST_CHARS = 8000;
const DISTILL_TIMEOUT_MS = 2 * 60 * 1000;
/**
 * Model for proposing rules — used by the distiller and by the compression
 * rewriter. Defaults to sonnet: candidate quality is the loop's bottleneck
 * (haiku proposed narrow, low-impact rules — see FINDINGS.md), and a better
 * rule is worth far more than the extra cost of an infrequent call. Override
 * with TOKEN_WARDEN_DISTILL_MODEL=haiku to economize.
 *
 * Read per call, not frozen at module load: every other config value in the
 * repo is read per call, and a module-level const silently ignores any
 * process.env set after import — which made the override untestable and made
 * import order decide the model.
 */
export function distillModel(): string {
	return process.env.TOKEN_WARDEN_DISTILL_MODEL ?? "sonnet";
}
/** Hard ceiling on samples per distillation and on candidates inserted per
 * batch — the selector measures at most 3 candidates per invocation, so
 * proposing more than 3 would only queue unmeasured rules. */
const MAX_K = 3;
const MAX_CANDIDATES_PER_BATCH = 3;

/** Default sample count. TOKEN_WARDEN_DISTILL_K raises it for hook-spawned
 * distills (collect.ts passes no --k); anything out of range falls back to 1. */
function defaultK(): number {
	const raw = Number(process.env.TOKEN_WARDEN_DISTILL_K ?? 1);
	return Number.isInteger(raw) && raw >= 1 && raw <= MAX_K ? raw : 1;
}

function logLine(message: string): void {
	try {
		const logPath = join(dirname(defaultDbPath()), "distill.log");
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never take the distiller down.
	}
}

/** Nearest-rank 75th percentile. */
export function p75(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.ceil(0.75 * sorted.length) - 1;
	return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Distill only when the run is expensive relative to the agent's recent
 * history: total above the rolling p75 of the last ROLLING_WINDOW runs,
 * with at least MIN_PRIOR_RUNS prior runs (otherwise there is no
 * meaningful distribution yet).
 */
export function shouldDistill(
	db: WardenDb,
	agent: string,
	runId: number,
	totalTokens: number,
): boolean {
	// Completed real-work sessions only. Both predicates are about cost
	// profile: golden/bench runs (task_hash IS NOT NULL) and aborted or
	// API-errored runs (completed = 0) are truncated or otherwise unlike an
	// ordinary session, so they would drag the percentile and over- or
	// under-trigger distillation. This is the same "real-work predicate" the
	// sibling `recentRealWorkTotals` uses.
	//
	// PERFORMANCE: `completed = 1` is also load-bearing. It is exactly the
	// WHERE clause of the v16 partial index
	//   idx_runs_realwork ON runs(agent, ts DESC)
	//     WHERE task_hash IS NULL AND completed = 1
	// so this query is index-served and the ORDER BY needs no sort. Drop the
	// predicate and SQLite falls back to a full SCAN plus a temp B-tree over
	// every session the agent has ever run — measured at 8.9ms vs 0.03ms on a
	// 100k-row ledger, growing forever, on the 2-second Stop-hook path.
	//
	// COALESCE matches the discipline at every other aggregate site: if a
	// nullable token column is ever added to RUN_TOTAL_TOKENS_SQL, a NULL
	// component would make each row's total NULL, p75 NaN, and `totalTokens >
	// NaN` false — silently disabling distillation forever rather than failing.
	const priors = db
		.prepare<unknown[], { total: number }>(
			`SELECT COALESCE(${RUN_TOTAL_TOKENS_SQL}, 0) AS total
			 FROM runs
			 WHERE agent = ? AND id != ? AND task_hash IS NULL AND completed = 1
			 ORDER BY ts DESC LIMIT ?`,
		)
		.all(agent, runId, ROLLING_WINDOW)
		.map((row) => row.total);
	if (priors.length < MIN_PRIOR_RUNS) return false;
	return totalTokens > p75(priors);
}

/** Stop fires after every turn, so one long expensive session would spawn a
 * distiller per turn over the same transcript. Any rule already born from
 * this run is the persistent "been here" marker. */
export function alreadyDistilled(db: WardenDb, runId: number): boolean {
	const row = db
		.prepare<unknown[], { n: number }>(
			"SELECT COUNT(*) AS n FROM rules WHERE source_run = ?",
		)
		.get(runId);
	return (row?.n ?? 0) > 0;
}

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

/** Jaccard similarity over character trigrams, in [0, 1]. */
export function trigramSimilarity(a: string, b: string): number {
	const gramsA = characterTrigrams(a);
	const gramsB = characterTrigrams(b);
	if (gramsA.size === 0 || gramsB.size === 0) {
		return a.trim() === b.trim() ? 1 : 0;
	}
	let intersection = 0;
	for (const gram of gramsA) {
		if (gramsB.has(gram)) intersection++;
	}
	return intersection / (gramsA.size + gramsB.size - intersection);
}

/** Shortest and longest acceptable rule body, in characters. The floor keeps
 * a truncated fragment from becoming a rule; the ceiling bounds rent. */
export const MIN_RULE_BODY_CHARS = 10;
export const MAX_RULE_BODY_CHARS = 200;

/**
 * Code-point ranges (inclusive) a rule body must never contain.
 *
 * A body is rendered into the compiled MEMORY.md that goes into the agent's
 * prompt, into log lines, into the status report, and back into this very
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
 * length-bounded line. Shared with the compression rewriter so the two
 * proposal paths can never drift on what counts as a valid rule.
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

const rulesSchema = z.array(z.object({ body: ruleBodySchema })).max(2);

/**
 * Hard ceiling on a model reply we are willing to run JSON.parse and two
 * regex passes over. The largest valid reply is two 200-character bodies, so
 * anything at this scale is garbage (or a 16 MB stdout buffer) and parsing it
 * only burns CPU on untrusted input.
 */
export const MAX_MODEL_REPLY_CHARS = 64_000;

/** Strip a stray markdown code fence the model wrapped its JSON in. The fence
 * is tolerated; nothing inside it is. */
export function stripJsonFence(text: string): string {
	return text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
}

/**
 * Parse the model's reply into rules. Strict: must be a JSON array of 0–2
 * `{body}` objects (a stray markdown fence is tolerated, content inside is
 * not). Returns null on anything else — the caller logs and drops, never
 * retries.
 */
export function parseRulesJson(text: string): { body: string }[] | null {
	if (text.length > MAX_MODEL_REPLY_CHARS) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(stripJsonFence(text));
	} catch {
		return null;
	}
	const result = rulesSchema.safeParse(raw);
	return result.success ? result.data : null;
}

/** The `claude -p --output-format json` envelope, validated at the boundary.
 * Unknown fields are tolerated (the CLI adds them over time); the shape we
 * depend on is not. */
const claudeEnvelopeSchema = z.looseObject({
	result: z.string().optional(),
	is_error: z.boolean().optional(),
});

export type EnvelopeParse =
	| { ok: true; result: string }
	| { ok: false; reason: string };

/**
 * Validate a headless `claude` stdout envelope and extract its `result` text.
 *
 * Every caller previously did `JSON.parse(stdout).result`, which crashes on a
 * bare `null`/`true`/`"str"` payload (all valid JSON) and silently treats the
 * CLI's own error envelope as a model answer. Failing closed with a reason is
 * the contract: the callers log it and drop the sample, never retry.
 */
export function parseClaudeEnvelope(stdout: string | undefined): EnvelopeParse {
	if (typeof stdout !== "string" || stdout.trim() === "") {
		return { ok: false, reason: "stdout was empty" };
	}
	if (stdout.length > MAX_MODEL_REPLY_CHARS) {
		return {
			ok: false,
			reason: `stdout was ${stdout.length} chars, over the ${MAX_MODEL_REPLY_CHARS} cap`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return {
			ok: false,
			reason: `stdout was not JSON. head: ${stdout.slice(0, 200)}`,
		};
	}
	const envelope = claudeEnvelopeSchema.safeParse(raw);
	if (!envelope.success) {
		return { ok: false, reason: "stdout JSON was not a result envelope" };
	}
	if (envelope.data.is_error === true) {
		return {
			ok: false,
			reason: `claude reported an error: ${(envelope.data.result ?? "").slice(0, 200)}`,
		};
	}
	return { ok: true, result: envelope.data.result ?? "" };
}

export function contextCost(body: string): number {
	return Math.ceil(body.length / 4);
}

/** An evicted rule reduced to what the distiller needs to learn from it. */
export interface EvictedFeedback {
	body: string;
	measured_delta: number | null;
	decided_reason: string | null;
}

export function buildPrompt(
	run: RunRow,
	digest: string,
	recentQuestions: string[] = [],
	activeRules: string[] = [],
	evictedRules: EvictedFeedback[] = [],
): string {
	const total =
		run.input_tokens + run.output_tokens + run.cache_creation + run.cache_read;
	const questionSection =
		recentQuestions.length > 0
			? [
					"Questions this agent recently had to ask other agents (a sign its own knowledge or approach has gaps):",
					...recentQuestions.map((q) => `- ${q}`),
					"",
				]
			: [];
	// Self-reinforcing loop: feed the rules this agent has ALREADY proven (banked
	// after surviving the benchmark) back in, so each new proposal builds on
	// what worked instead of re-proposing covered ground.
	const provenSection =
		activeRules.length > 0
			? [
					"This agent ALREADY follows these proven, measured best-practice rules — do NOT repeat, rephrase, or narrow any of them. Propose a genuinely NEW practice that targets waste they do not already cover:",
					...activeRules.map((r) => `- ${r}`),
					"",
				]
			: [];
	// Verdict-grounded feedback: the measured failures. Feeding the proposer the
	// outcome of its past proposals (what was tried, what it measured, why it was
	// rejected) is the closed-loop signal that lets it stop repeating failure
	// modes — "within noise" means the effect was too small to matter, a
	// regression means the rule traded correctness for tokens.
	const evictedSection =
		evictedRules.length > 0
			? [
					"These rules were ALREADY proposed, MEASURED on the benchmark, and REJECTED. Do not re-propose them or minor variants. Learn from why each failed: a sub-threshold or within-noise delta means the targeted behavior was too small a waste source — aim at a bigger one; a regression means the rule made the agent fail tasks — never trade thoroughness for tokens:",
					...evictedRules
						.slice(0, MAX_EVICTED_FEEDBACK)
						.map(
							(r) =>
								`- "${r.body}" -> rejected: ${r.decided_reason ?? "unknown"}${r.measured_delta !== null ? ` (measured ${r.measured_delta} tokens/run)` : ""}`,
						),
					"",
				]
			: [];
	return [
		`An AI coding agent ("${run.agent}") just finished a session that used an unusually high number of tokens compared to its history.`,
		"",
		"Waste statistics:",
		`- total tokens processed: ${total}`,
		`- tool calls: ${run.tool_calls}`,
		`- files read two or more times: ${run.file_rereads}`,
		`- task completed: ${run.completed === 1 ? "yes" : "no"}`,
		"",
		...questionSection,
		...provenSection,
		...evictedSection,
		"Action trace (truncated):",
		digest,
		"",
		"From this trace, extract at most 2 of the HIGHEST-IMPACT generalizable efficiency rules this agent could follow in FUTURE sessions to use fewer tokens. First identify the single biggest source of wasted tokens in the trace (the behavior that consumed the most — usually reading whole files, re-reading, or undirected exploration), then target THAT. Each rule must be:",
		"- one imperative sentence under 200 characters",
		"- generalizable to other tasks (never mention specific files, symbols, or this task)",
		"- HIGH-IMPACT: it should plausibly cut a large fraction of the tokens, not shave a few percent. Prefer a rule that changes a dominant, repeated behavior over a narrow, situational tip.",
		"- about working cheaper (navigation, reading discipline, planning, tool choice) — not about correctness",
		"- a SAME-RESULT saving: it must reach the identical outcome for fewer tokens. NEVER propose skipping steps, giving up or retrying less, cutting verification/testing, or trading thoroughness for tokens — such rules fail tasks and are auto-evicted on the benchmark.",
		"",
		"Examples of the KIND of high-impact rule to prefer (only propose one if the trace actually shows that waste — do not copy blindly):",
		'- "Use Grep or Glob to locate the exact symbol before opening a file; never read a whole file you are not about to edit."',
		'- "Never re-read a file you have already read this session; rely on what you saw and the diffs you made."',
		'- "State a one-line plan before the first edit, then execute it without exploratory detours."',
		"",
		'Reply with ONLY a raw JSON array, no markdown fences, no commentary: [{"body": "..."}] or [] if no clear generalizable lesson exists.',
	].join("\n");
}

interface DistillArgs {
	runId: number;
	transcriptPath: string;
	/** Best-of-K sample count, 1–3; defaults to defaultK() when omitted. */
	k?: number;
}

export function parseDistillArgs(argv: string[]): DistillArgs {
	let runId: number | null = null;
	let transcriptPath: string | null = null;
	let k = defaultK();
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--run") {
			runId = Number(argv[i + 1]);
			i++;
		} else if (argv[i] === "--transcript") {
			transcriptPath = argv[i + 1] ?? null;
			i++;
		} else if (argv[i] === "--k") {
			k = Number(argv[i + 1]);
			i++;
		} else {
			throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	if (runId === null || !Number.isInteger(runId)) {
		throw new Error("--run <id> is required");
	}
	if (!transcriptPath) {
		throw new Error("--transcript <path> is required");
	}
	if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
		throw new Error(`--k must be an integer between 1 and ${MAX_K}`);
	}
	return { runId, transcriptPath, k };
}

export function distill(args: DistillArgs): void {
	const db = openDb();
	try {
		const run = db
			.prepare<unknown[], RunRow>("SELECT * FROM runs WHERE id = ?")
			.get(args.runId);
		if (!run) {
			logLine(`run ${args.runId} not found; nothing to distill`);
			return;
		}
		if (!knownAgents().includes(run.agent)) {
			logLine(
				`run ${run.id}: agent "${run.agent}" has no golden suite; rules would be unmeasurable — skipping`,
			);
			return;
		}
		if (alreadyDistilled(db, run.id)) {
			logLine(`run ${run.id}: already distilled; skipping`);
			return;
		}
		const total =
			run.input_tokens +
			run.output_tokens +
			run.cache_creation +
			run.cache_read;
		if (!shouldDistill(db, run.agent, run.id, total)) {
			logLine(
				`run ${run.id} (${run.agent}, ${total} tokens) below rolling p75 or too few priors; skipping`,
			);
			return;
		}

		const digest = digestTranscript(
			readFileSync(args.transcriptPath, "utf8"),
			MAX_DIGEST_CHARS,
		);
		const prompt = buildPrompt(
			run,
			digest,
			recentQuestionsFrom(db, run.agent, 5),
			getActiveRules(db, run.agent).map((r) => r.body),
			recentEvictedRules(db, run.agent, MAX_EVICTED_FEEDBACK),
		);

		// Best-of-K: pool proposals across K samples, collapsing near-identical
		// ones first — repeated sampling explores the proposal space, but each
		// distinct survivor still costs a full benchmark, so duplicates must
		// never reach the insert step.
		const k = args.k ?? defaultK();
		const proposals: { body: string }[] = [];
		for (let sample = 1; sample <= k; sample++) {
			const claude = spawnSync(
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
					cwd: pluginRoot,
					encoding: "utf8",
					timeout: DISTILL_TIMEOUT_MS,
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			// A failed sample must not abort the batch: proposals already pooled
			// from earlier samples are paid for, so log and move on — the same
			// treatment the invalid-JSON case gets. Exit code, not output, is the
			// failure signal.
			if (claude.error || claude.status !== 0) {
				logLine(
					`run ${run.id}: sample ${sample}/${k} failed (${
						claude.error
							? String(claude.error)
							: `exit ${claude.status}: ${(claude.stderr ?? "").slice(0, 200)}`
					}); dropping sample (never retried).`,
				);
				continue;
			}
			const envelope = parseClaudeEnvelope(claude.stdout);
			if (!envelope.ok) {
				logLine(
					`run ${run.id}: sample ${sample}/${k} ${envelope.reason}; dropping sample.`,
				);
				continue;
			}
			const rules = parseRulesJson(envelope.result);
			if (rules === null) {
				logLine(
					`run ${run.id}: sample ${sample}/${k} returned invalid rules JSON; dropping (never retried). head: ${envelope.result.slice(0, 200)}`,
				);
				continue;
			}
			for (const rule of rules) {
				const dupInBatch = proposals.some(
					(other) =>
						trigramSimilarity(rule.body, other.body) > SIMILARITY_THRESHOLD,
				);
				if (dupInBatch) {
					logLine(
						`run ${run.id}: sample ${sample}/${k}: near-duplicate within batch; skipping: "${rule.body}"`,
					);
					continue;
				}
				proposals.push(rule);
			}
		}

		const existing = listRulesByAgent(db, run.agent);
		const ts = new Date().toISOString();
		let inserted = 0;
		for (const rule of proposals) {
			if (inserted >= MAX_CANDIDATES_PER_BATCH) {
				logLine(
					`run ${run.id}: batch cap of ${MAX_CANDIDATES_PER_BATCH} reached; dropping: "${rule.body}"`,
				);
				continue;
			}
			const nearDuplicate = existing.find(
				(other) =>
					trigramSimilarity(rule.body, other.body) > SIMILARITY_THRESHOLD,
			);
			if (nearDuplicate) {
				logLine(
					`run ${run.id}: skipping near-duplicate of rule ${nearDuplicate.id}: "${rule.body}"`,
				);
				continue;
			}
			const id = insertRule(db, {
				agent: run.agent,
				body: rule.body,
				contextCost: contextCost(rule.body),
				sourceRun: run.id,
				createdAt: ts,
				// Provenance: keep a short excerpt of the session that produced the
				// rule so its receipt can show what waste motivated it.
				bornDigest: digest.slice(0, 1200),
			});
			inserted++;
			logLine(
				`run ${run.id}: new candidate ${id} for ${run.agent}: "${rule.body}"`,
			);
		}
	} finally {
		db.close();
	}
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		distill(parseDistillArgs(process.argv.slice(2)));
	} catch (err) {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		logLine(`distill error: ${detail}`);
	}
	process.exit(0);
}
/* v8 ignore stop */
