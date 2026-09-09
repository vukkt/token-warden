/**
 * Golden-suite drafting: the bridge from RECORDED REAL WORK to a RUNNABLE
 * golden suite, for an agent that has none.
 *
 * CLI: npx tsx src/draft.ts --agent <name> [--projects <dir>] [--out <dir>]
 *      [--min-sessions N] [--max-spread F] [--fixture <dir>] [--write] [--json]
 *
 * WHY THIS EXISTS. `registry.ts` made the agent definition and the golden
 * suite overridable (BYOA), so a user CAN point token-warden at their own
 * agent — provided they hand-write a golden suite for it first. That
 * hand-written suite is the whole cost of entry, and the raw material for it is
 * already on disk: the Stop hook records every session into `runs`, and the
 * transcripts those rows summarize are sitting in ~/.claude/projects. This
 * module mines both and emits golden task files in the exact shape `bench.ts`
 * parses and runs.
 *
 * WHAT IT IS NOT. It does not spend a single token, and it cannot tell you a
 * drafted task is a GOOD benchmark. It can only rule tasks out, and it does so
 * on three grounds it can actually check for free:
 *
 *   1. REPEATABILITY (`assessRepeatability`). A task whose recorded cost swung
 *      wildly across the sessions it was mined from is a task no verdict can
 *      ever be read off. Refused, not warned about.
 *   2. A DERIVABLE CHECK (`deriveSuccessCheck`). A golden task needs a
 *      deterministic success check. The sessions themselves ran one — the
 *      verification command the agent used to prove the work done — and if no
 *      such command recurs across the cluster, there is nothing to derive and
 *      the task is refused rather than emitted with a `TODO`.
 *   3. NON-VACUITY (`checkFailsPristine`, opt-in via a fixture). A check that
 *      already passes on the untouched fixture is a dead sensor; this repo
 *      shipped two of those and found them by EXECUTING them, not by reading
 *      them. Same technique here.
 *
 * Everything those three let through is still UNVALIDATED. Nothing here proves
 * the agent can do the task inside the fixture, that the prompt is
 * self-contained, or that the task's cost is stable under the BENCHMARK's
 * conditions rather than under the conditions it happened to be recorded in.
 * Those facts cost tokens to learn, and the only way to learn them is to run
 * `npx tsx src/bench.ts --agent <name>` and read the variance warnings. Which
 * is why drafts land in `<suite>/drafts/` and not in `<suite>/`: `bench.ts`
 * loads `golden-NN.md` from the suite directory only and never recurses, so a
 * draft cannot enter a measurement until a human moves it up one level.
 */
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkChildEnv,
	findTranscript,
	parseGoldenTask,
	shouldCopyFixtureEntry,
} from "./bench.js";
import { numericFlag, runCli } from "./cli.js";
import { type RealWorkSession, realWorkSessions, withDb } from "./db.js";
import { formatRounded } from "./format.js";
import { type MainFixture, provisionMainFixture } from "./main-target.js";
import {
	assertDraftTarget,
	userBenchmarksDir,
	userFixturesDir,
} from "./registry.js";
import { trigramSimilarity } from "./rules.js";
import { displayText } from "./sanitize.js";
import { mean, sampleVariance } from "./stats.js";

/** Two opening prompts at or above this trigram similarity are the same task.
 * Inherited from the removed `/warden-sample-tasks`, where it was used to THROW
 * duplicates away. Here the duplicates are the point: a cluster of near-identical
 * prompts is a task the user does repeatedly, and its members are the repeated
 * measurements the pre-check needs. */
const CLUSTER_THRESHOLD = 0.6;
/** Opening prompts shorter than this are acknowledgements and one-word
 * follow-ups, not task statements. */
const MIN_PROMPT_CHARS = 24;
/** Hard cap on a drafted prompt, applied AFTER redaction so a secret can never
 * survive by being cut in half. */
const MAX_PROMPT_CHARS = 600;
/** Longest derived success check. Well under bench.ts's 4,000-char field cap;
 * a verification command longer than this is not the single clean invocation
 * this derivation is looking for. */
const MAX_CHECK_CHARS = 200;
/** Recorded sessions a cluster needs before its dispersion means anything. At
 * n=2 the spread is a single pair and any threshold is a coin flip. */
const DEFAULT_MIN_SESSIONS = 3;
/**
 * Largest relative spread, (max - min) / mean, a drafted task may show across
 * the sessions it was mined from.
 *
 * 0.25 is not a fresh guess: it is `VARIANCE_WARN_RATIO` in bench.ts, the same
 * quantity computed the same way, and FINDINGS.md records that the WORST
 * bundled golden tasks varied by more than it run to run — tasks that made
 * verdicts unreadable and had to be split into narrower ones (sql-02 ->
 * sql-06/07, testing-02 -> testing-05/06). Drafting a task the recorded data
 * already shows to be that noisy would be manufacturing that problem on
 * purpose.
 *
 * Range-based rather than CV-based deliberately, so the number means the same
 * thing it means in bench.ts's warning and in FINDINGS. It is therefore
 * CONSERVATIVE at larger n — more samples can only widen a range — which is the
 * right direction for a screen: passing it with eight sessions is a stronger
 * statement than passing it with three.
 */
const DEFAULT_MAX_SPREAD = 0.25;
/** Timeout for one pristine-fixture vacuity probe. These are greps and test
 * runners, not agents. */
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
/** Captured output cap for the vacuity probe: a test runner can be chatty, and
 * exceeding a spawnSync maxBuffer kills the child and returns status null,
 * which this module must not read as "the check failed". */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Credential shapes that turn up pasted into real prompts. Each is replaced
 * wholesale with `[REDACTED]`; a false positive costs a human one edit in a
 * file they are reviewing anyway, a false negative writes a live secret into a
 * file the user is being invited to commit.
 *
 * Carried over verbatim from the removed `/warden-sample-tasks`, which had the
 * same exposure for the same reason and is the only part of it worth keeping.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	// Anthropic / OpenAI / Stripe style `sk-...`, `sk-ant-...`, `rk_live_...`.
	/\b(?:sk|rk|pk)[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]{16,}\b/g,
	// GitHub tokens (classic, fine-grained, app, OAuth, refresh).
	/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	// AWS access key ids and Google API keys.
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}\b/g,
	// Slack tokens.
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
	// JSON Web Tokens.
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	// `Authorization: Bearer <blob>` and private-key PEM headers.
	/\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
	// `api_key: v`, `token=v`, `secret=v`, `DB_PASSWORD=v`. The surrounding
	// `[A-Za-z0-9_.-]*` deliberately absorbs prefixes and suffixes (`DB_`,
	// `_VALUE`) so a namespaced env-var name still trips the match.
	/[A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret|password|passwd|pwd|token)[A-Za-z0-9_]*\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
	/-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Strip identifying and secret material out of a real user prompt before it is
 * written to disk. The prompts come verbatim out of the user's own transcripts
 * and the drafts land in a file they are told to review and promote — i.e. a
 * file that gets committed. Home directories collapse to `~` rather than being
 * redacted: the SHAPE of a path is useful context for a golden task, the
 * username is not.
 */
export function redactSensitive(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	// This machine's actual home first (it may not match the generic shapes
	// below, e.g. a relocated $HOME), then the conventional layouts.
	const home = homedir();
	if (home && home !== "/") {
		out = out.split(home).join("~");
	}
	out = out.replace(/\/(?:Users|home)\/[^/\s"']+/g, "~");
	out = out.replace(/\/(?:var\/)?root\b/g, "~");
	out = out.replace(
		/\b[^\s@,;<>"']+@[^\s@,;<>"']+\.[A-Za-z]{2,}\b/g,
		"[EMAIL]",
	);
	return out;
}

// ---------------------------------------------------------------------------
// Transcript mining
// ---------------------------------------------------------------------------

/** One recorded session's transcript, paired with its ledger row's key. */
export interface SessionTranscript {
	sessionId: string;
	jsonl: string;
}

interface TranscriptEntry {
	type?: unknown;
	message?: { role?: unknown; content?: unknown } | null;
}

/** Parse one JSONL line into an entry shape, or null. Deliberately hand-rolled
 * rather than routed through `transcript.ts`: that module aggregates COSTS and
 * discards the message bodies this one exists to read. */
function parseLine(line: string): TranscriptEntry | null {
	if (!line.trim()) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	return raw as TranscriptEntry;
}

/** Concatenated text of a message's content, whether it is a bare string or an
 * array of blocks. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") {
			parts.push(typed.text);
		}
	}
	return parts.join("\n");
}

/**
 * The first substantive user instruction in a session — the task statement.
 * Null when there is none.
 *
 * Envelope entries are skipped rather than returned: a leading `<` is a
 * system-reminder or command-message wrapper, and "Caveat:" is Claude Code's
 * own preamble. Neither is something a human asked for.
 */
export function extractOpeningPrompt(jsonl: string): string | null {
	for (const line of jsonl.split(/\r?\n/)) {
		const entry = parseLine(line);
		if (entry === null || entry.type !== "user") continue;
		const message = entry.message;
		if (typeof message !== "object" || message === null) continue;
		if (message.role !== "user") continue;
		const text = messageText(message.content).trim();
		if (text.length < MIN_PROMPT_CHARS) continue;
		if (text.startsWith("<") || text.startsWith("Caveat:")) continue;
		return text.replace(/\s+/g, " ");
	}
	return null;
}

/**
 * Programs whose invocation is a VERIFICATION rather than an exploration.
 *
 * A golden task's success check has to answer "was the work done", and the
 * session already answered it: somewhere near the end the agent ran the
 * project's own test, type-check, lint or build command and got a zero exit.
 * That command is the check, and it comes from the user's toolchain rather
 * than from a model's guess about it.
 *
 * Anchored at the start of the command so `echo npm test` cannot match, and
 * kept to the invocations a repository actually verifies itself with — an
 * `ls` or a `git status` exits 0 on any tree and would be vacuous by
 * construction.
 */
const VERIFICATION_COMMAND =
	/^(?:(?:npm|pnpm|yarn|bun) (?:test|run (?:test|typecheck|lint|build|check|typecheck:[\w-]+))|npx (?:vitest|jest|tsc|eslint|biome)|(?:pytest|tox|mypy|ruff)|python -m (?:pytest|mypy)|cargo (?:test|check|clippy)|go (?:test|vet|build)|make (?:test|check|lint|build)|(?:mvn|gradle|dotnet) test|bundle exec rspec)\b/;

/**
 * Shell metacharacters that disqualify a command from becoming a success check.
 *
 * The check is run as `bash -c <value>` and its EXIT CODE is the measurement,
 * so a compound command is a measurement of whichever segment happens to run
 * last: `npm test | head` exits on `head`, `npm test > out.txt` exits on the
 * redirect, `npm test &` exits immediately. Every one of those reports SUCCESS
 * for a suite that failed. Restricting derivation to a single plain invocation
 * costs a few candidates and removes the entire class.
 */
const SHELL_METACHARACTER = /[;&|<>`$()\\{}[\]!*?~#\n\r]/;

/** Normalize a command for cross-session comparison: collapse runs of
 * whitespace, drop a trailing separator. Two sessions that ran `npm test` and
 * `npm  test ` ran the same check. */
function normalizeCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

/**
 * The verification commands a session ran and that SUCCEEDED, in order.
 *
 * The exit status matters: a `npm test` that failed is the agent discovering
 * the work is not done, and freezing it as a golden check would freeze a
 * command the fixture is expected to fail. Claude Code records this on the
 * matching `tool_result` block as `is_error`, so the call is joined to its
 * result by `tool_use_id` before the command is accepted. A call with no
 * result (the session ended mid-tool) is dropped, not assumed successful.
 */
export function extractVerificationCommands(jsonl: string): string[] {
	const pending = new Map<string, string>();
	const failed = new Set<string>();
	const succeeded = new Set<string>();
	for (const line of jsonl.split(/\r?\n/)) {
		const entry = parseLine(line);
		if (entry === null) continue;
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const typed = block as {
				type?: unknown;
				id?: unknown;
				name?: unknown;
				input?: unknown;
				tool_use_id?: unknown;
				is_error?: unknown;
			};
			if (typed.type === "tool_use" && typed.name === "Bash") {
				const id = typeof typed.id === "string" ? typed.id : null;
				const input = typed.input;
				if (id === null || typeof input !== "object" || input === null)
					continue;
				const command = (input as { command?: unknown }).command;
				if (typeof command !== "string") continue;
				pending.set(id, normalizeCommand(command));
			} else if (typed.type === "tool_result") {
				const id = typed.tool_use_id;
				if (typeof id !== "string") continue;
				(typed.is_error === true ? failed : succeeded).add(id);
			}
		}
	}
	const out: string[] = [];
	for (const [id, command] of pending) {
		if (!succeeded.has(id) || failed.has(id)) continue;
		if (command.length > MAX_CHECK_CHARS) continue;
		if (SHELL_METACHARACTER.test(command)) continue;
		if (!VERIFICATION_COMMAND.test(command)) continue;
		out.push(command);
	}
	return out;
}

/**
 * The success check for a cluster: the verification command that recurs across
 * the most of its sessions, provided it recurs in a MAJORITY of them. Null when
 * nothing does.
 *
 * The majority requirement is what separates a check from a coincidence. One
 * session running `npm run lint` proves nothing about the task; four out of
 * five sessions ending on `npx vitest run` is the task's own definition of
 * done, discovered rather than invented. Ties break on the lexicographically
 * smaller command so the same input always yields the same suite.
 */
export function deriveSuccessCheck(
	commandsPerSession: readonly (readonly string[])[],
): string | null {
	if (commandsPerSession.length === 0) return null;
	const sessionCounts = new Map<string, number>();
	for (const commands of commandsPerSession) {
		for (const command of new Set(commands)) {
			sessionCounts.set(command, (sessionCounts.get(command) ?? 0) + 1);
		}
	}
	const majority = Math.floor(commandsPerSession.length / 2) + 1;
	let best: string | null = null;
	let bestCount = 0;
	for (const [command, count] of sessionCounts) {
		if (count < majority) continue;
		if (
			count > bestCount ||
			(count === bestCount && best !== null && command < best)
		) {
			best = command;
			bestCount = count;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/** A recurring task: one representative prompt and every session that ran it. */
export interface PromptCluster {
	/** The earliest recorded prompt in the cluster; the others are near-duplicates. */
	prompt: string;
	sessionIds: string[];
}

/**
 * Group sessions whose opening prompts are near-identical.
 *
 * Greedy single-pass assignment against each cluster's representative, which
 * is enough for the job and is order-stable: sessions arrive oldest-first, so
 * the representative is the earliest phrasing and re-running the drafter on a
 * grown ledger keeps existing clusters rather than reshuffling them.
 */
export function clusterSessions(
	sessions: readonly SessionTranscript[],
): PromptCluster[] {
	const clusters: PromptCluster[] = [];
	for (const session of sessions) {
		const prompt = extractOpeningPrompt(session.jsonl);
		if (prompt === null) continue;
		const match = clusters.find(
			(cluster) =>
				trigramSimilarity(cluster.prompt, prompt) >= CLUSTER_THRESHOLD,
		);
		if (match) match.sessionIds.push(session.sessionId);
		else clusters.push({ prompt, sessionIds: [session.sessionId] });
	}
	return clusters;
}

// ---------------------------------------------------------------------------
// The repeatability pre-check
// ---------------------------------------------------------------------------

export interface Repeatability {
	/** Sessions the estimate is built from. */
	n: number;
	/** Sessions among those that the agent did not finish. */
	incomplete: number;
	meanTokens: number;
	/** (max - min) / mean of total tokens — bench.ts's variance-warning quantity. */
	spread: number;
	/** Coefficient of variation of total tokens; reported, never gated on.
	 * Null when a variance cannot be estimated (n < 2) or the mean is zero. */
	cv: number | null;
	/** Same spread measure over tool calls: a task whose token cost is steady
	 * only because a runaway read loop cancelled out a short reasoning pass is
	 * not steady. Advisory. */
	toolCallSpread: number | null;
	/** Median wall-clock seconds, or null when no member row recorded one. */
	medianSeconds: number | null;
}

/** Relative spread, (max - min) / mean; null when the mean is not positive. */
function relativeSpread(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const average = mean([...values]);
	if (!(average > 0)) return null;
	return (Math.max(...values) - Math.min(...values)) / average;
}

/** Median of a non-empty list. Local rather than `stats.median` because this
 * one must return null for the empty case instead of NaN — a task with no
 * recorded durations must render "n/a", not "NaN s". */
function medianOrNull(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? null;
	const lower = sorted[mid - 1];
	const upper = sorted[mid];
	return lower === undefined || upper === undefined
		? null
		: (lower + upper) / 2;
}

/**
 * Dispersion of a candidate task across the sessions it was mined from,
 * computed from the ledger alone. Zero tokens: every input is a number the Stop
 * hook already recorded.
 *
 * WHAT THIS MEASURES, precisely. These are not replicates in the golden sense.
 * Each session ran against a different working tree, with different context
 * and a different conversation, so their spread bounds the noise from ABOVE:
 * some of it is the task and some of it is the varying world around it. That
 * asymmetry is exactly why this is a REFUSAL rule and not a certification.
 * Wide spread is decisive — a task that swung 3x when the user ran it will not
 * hold still under a benchmark either. Narrow spread is only permission to
 * spend tokens finding out.
 */
export function assessRepeatability(
	sessions: readonly RealWorkSession[],
): Repeatability {
	const totals = sessions.map((session) => session.total);
	const durations = sessions
		.map((session) => session.durationMs)
		.filter((ms): ms is number => ms !== null && ms > 0);
	const meanTokens = totals.length > 0 ? mean(totals) : 0;
	const variance = sampleVariance(totals);
	return {
		n: sessions.length,
		incomplete: sessions.filter((session) => session.completed !== 1).length,
		meanTokens,
		spread: relativeSpread(totals) ?? Number.POSITIVE_INFINITY,
		cv:
			variance === null || !(meanTokens > 0)
				? null
				: Math.sqrt(variance) / meanTokens,
		toolCallSpread: relativeSpread(sessions.map((s) => s.toolCalls)),
		medianSeconds:
			durations.length === 0 ? null : (medianOrNull(durations) ?? 0) / 1000,
	};
}

export interface RepeatabilityGate {
	minSessions: number;
	maxSpread: number;
}

/**
 * Why a candidate task is not being offered, or null when it survives. Ordered
 * cheapest-to-explain first so the user reads the most actionable reason.
 */
export function repeatabilityRefusal(
	repeatability: Repeatability,
	gate: RepeatabilityGate,
): string | null {
	if (repeatability.n < gate.minSessions) {
		return (
			`only ${repeatability.n} recorded session(s); ` +
			`${gate.minSessions} are needed before run-to-run spread means anything`
		);
	}
	if (repeatability.incomplete > 0) {
		return (
			`${repeatability.incomplete} of ${repeatability.n} recorded sessions did not ` +
			"complete — a task the agent does not reliably finish cannot be a benchmark"
		);
	}
	if (!(repeatability.spread <= gate.maxSpread)) {
		return (
			`token cost varied by ${(repeatability.spread * 100).toFixed(0)}% across ` +
			`${repeatability.n} recorded sessions (limit ${(gate.maxSpread * 100).toFixed(0)}%) — ` +
			"a saving would be buried in this task's own noise"
		);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Turn a raw transcript prompt into a value safe to write inside a
 * double-quoted frontmatter scalar: neutralized (control and ANSI bytes
 * stripped, whitespace collapsed), redacted, then quote- and backslash-safe,
 * and only then clamped.
 *
 * Backslashes become `/` because the value is emitted between double quotes and
 * a trailing `\` would escape the closing quote and leave the file unparseable.
 * A leading `-` is prefixed away because bench.ts rejects it outright: `-p`
 * takes an optional value, so a prompt starting with `-` would be read by the
 * benchmarked CLI as a flag.
 */
export function sanitizeDraftPrompt(prompt: string): string {
	const neutral = displayText(prompt, MAX_PROMPT_CHARS * 4);
	const cleaned = redactSensitive(neutral)
		.replace(/"/g, "'")
		.replace(/\\/g, "/")
		.slice(0, MAX_PROMPT_CHARS)
		.trim();
	return cleaned.startsWith("-") ? cleaned.replace(/^-+\s*/, "") : cleaned;
}

/** A drafted task, rendered and proven to parse. */
export interface DraftedTask {
	id: string;
	fileName: string;
	prompt: string;
	successCheck: string;
	repeatability: Repeatability;
	/** Null when no fixture was available to probe against. */
	failsPristine: boolean | null;
	content: string;
}

/** The file a golden task lives in — the same `golden-NN.md` name bench.ts
 * loads, so promoting a draft is a `mv` and nothing else. */
export function draftFileName(index: number): string {
	return `golden-${String(index).padStart(2, "0")}.md`;
}

/**
 * Render one golden task file, then PARSE IT BACK through bench.ts's own
 * `parseGoldenTask` before returning it.
 *
 * The round-trip is the guarantee that distinguishes this from the command it
 * replaces. `/warden-sample-tasks`, deleted in v1.0.0, emitted files with
 * `success_check: "TODO"` under a name bench.ts does not load, so nothing it
 * produced could be run and nothing checked whether it could be — which is the
 * likeliest reason nobody missed it. Here the emitted bytes are fed to the
 * exact parser, with the exact path-segment, control-character, length and
 * leading-dash validation the runner applies, and a file that would not load is
 * an exception rather than a deliverable.
 */
export function renderDraft(
	agent: string,
	index: number,
	draft: {
		prompt: string;
		successCheck: string;
		repeatability: Repeatability;
		failsPristine: boolean | null;
		sessionIds: readonly string[];
		/** Repository the sessions ran in. Stamped into the task because a
		 * main-target benchmark runs in a worktree of it; a task without one
		 * cannot be benchmarked at all. */
		project?: string | null;
	},
): DraftedTask {
	const id = `${agent}-${String(index).padStart(2, "0")}`;
	const prompt = sanitizeDraftPrompt(draft.prompt);
	const check = displayText(draft.successCheck, MAX_CHECK_CHARS).replace(
		/"/g,
		"'",
	);
	const { repeatability: rep } = draft;
	const vacuity =
		draft.failsPristine === null
			? "NOT PROBED (no fixture available) — the check may already pass on an untouched tree, which would make it a dead sensor"
			: draft.failsPristine
				? "probed: fails on the pristine fixture, so it can detect the work being done"
				: "WARNING: passes on the PRISTINE fixture — dead sensor, rewrite before promoting";
	const content = [
		"---",
		`id: "${id}"`,
		`agent: "${agent}"`,
		`prompt: "${prompt}"`,
		`success_check: "${check}"`,
		...(draft.project ? [`project: "${draft.project}"`] : []),
		"---",
		"",
		`Drafted from ${rep.n} recorded sessions of a recurring task. Mean cost`,
		`${formatRounded(rep.meanTokens)} tokens, spread ${(rep.spread * 100).toFixed(0)}%` +
			`${rep.medianSeconds === null ? "" : `, median ${rep.medianSeconds.toFixed(0)}s`}.`,
		"",
		"UNVALIDATED. The prompt is machine-extracted from real transcripts and only",
		"best-effort redacted (home paths -> ~, credential-shaped strings -> [REDACTED],",
		"addresses -> [EMAIL]); re-read it for anything private. The success check is the",
		"verification command those sessions themselves ran and passed, not a check anyone",
		`wrote for this fixture — ${vacuity}.`,
		"",
		"Nothing here has been benchmarked. The recorded spread bounds this task's noise",
		"from above but was measured in the user's own tree, not in the fixture; only",
		`\`npx tsx src/bench.ts --agent ${agent}\` can say whether the task is stable, or`,
		"even completable, under benchmark conditions. That costs tokens.",
		"",
		`To promote: review, then move this file up one level into the suite directory.`,
		"bench.ts loads golden-NN.md from the suite directory only and never recurses, so",
		"a file left here can never enter a measurement by accident.",
		"",
	].join("\n");
	// Throws rather than returns on a malformed render: an unloadable draft is a
	// bug in this module, not a task to report as skipped.
	const parsed = parseGoldenTask(content, `${agent}/${draftFileName(index)}`);
	return {
		id: parsed.id,
		fileName: draftFileName(index),
		prompt: parsed.prompt,
		successCheck: parsed.successCheck,
		repeatability: rep,
		failsPristine: draft.failsPristine,
		content,
	};
}

// ---------------------------------------------------------------------------
// Vacuity probe
// ---------------------------------------------------------------------------

/**
 * Does `check` FAIL on an untouched copy of `fixtureDir`?
 *
 * A success check that already passes before any agent has touched the tree
 * cannot detect the work being done, and — because a quota-dead run then
 * records `completed = true` — it is invisible to the environment-failure
 * discriminator too. This repo shipped two such checks and found them by
 * EXECUTING them against a pristine copy, never by reading them; the same
 * technique applies to a derived check, and it costs no tokens.
 *
 * Runs in a throwaway copy under the same allowlisted environment `bench.ts`
 * gives a real success check, so a probe cannot mutate the user's fixture or
 * read their credentials. A probe that did not run at all (spawn error, kill,
 * ENOBUFS) returns null: "unknown" and "the check failed" must not collapse.
 */
export function checkFailsPristine(
	check: string,
	fixtureDir: string,
	spawn: typeof spawnSync = spawnSync,
): boolean | null {
	const workDir = mkdtempSync(join(tmpdir(), "warden-draft-probe-"));
	try {
		cpSync(fixtureDir, workDir, {
			recursive: true,
			filter: shouldCopyFixtureEntry,
		});
		const result = spawn("bash", ["-c", check], {
			cwd: workDir,
			encoding: "utf8",
			timeout: CHECK_TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
			env: checkChildEnv(),
		});
		if (result.error || result.status === null) return null;
		return result.status !== 0;
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** One candidate that did not survive, and the reason. Reported rather than
 * dropped: "nothing was drafted" is useless, "six clusters, five too noisy and
 * one with no derivable check" tells the user what to do next. */
export interface RejectedCandidate {
	prompt: string;
	reason: string;
}

export interface DraftPlan {
	agent: string;
	drafted: DraftedTask[];
	rejected: RejectedCandidate[];
	/** Recorded real-work sessions considered for this agent. */
	sessionsSeen: number;
	/** Sessions whose transcript could not be located on disk. */
	transcriptsMissing: number;
}

export interface PlanOptions extends RepeatabilityGate {
	/** Pristine tree to probe derived checks against; null to skip probing. */
	fixtureDir: string | null;
	/** Absolute path of the repository these sessions ran in, stamped into each
	 * drafted task. Main-target tasks are benchmarked in a worktree of it, so a
	 * task without one cannot be run at all. */
	project?: string | null;
	spawn?: typeof spawnSync;
}

/**
 * Build the full plan: cluster, gate, derive, probe, render. Pure with respect
 * to the output directory — nothing is written here, so `--write` and the
 * dry-run print the identical plan.
 */
export function planDrafts(
	agent: string,
	ledger: readonly RealWorkSession[],
	transcripts: readonly SessionTranscript[],
	options: PlanOptions,
): DraftPlan {
	const byId = new Map(transcripts.map((t) => [t.sessionId, t]));
	const rowsById = new Map<string, RealWorkSession[]>();
	for (const row of ledger) {
		const bucket = rowsById.get(row.sessionId);
		if (bucket) bucket.push(row);
		else rowsById.set(row.sessionId, [row]);
	}
	const available: SessionTranscript[] = [];
	let missing = 0;
	for (const row of ledger) {
		const transcript = byId.get(row.sessionId);
		if (transcript === undefined) {
			missing++;
			continue;
		}
		// A session id can appear once per ledger row; the transcript is one file.
		if (!available.some((t) => t.sessionId === transcript.sessionId)) {
			available.push(transcript);
		}
	}

	const drafted: DraftedTask[] = [];
	const rejected: RejectedCandidate[] = [];
	const clusters = clusterSessions(available);
	// Rank by spread ascending BEFORE numbering, so golden-01 is the steadiest
	// task the recorded data knows about rather than the first one recorded.
	const assessed = clusters
		.map((cluster) => ({
			cluster,
			repeatability: assessRepeatability(
				cluster.sessionIds.flatMap((id) => rowsById.get(id) ?? []),
			),
		}))
		.sort((a, b) => a.repeatability.spread - b.repeatability.spread);

	for (const { cluster, repeatability } of assessed) {
		const refusal = repeatabilityRefusal(repeatability, options);
		if (refusal !== null) {
			rejected.push({ prompt: cluster.prompt, reason: refusal });
			continue;
		}
		const check = deriveSuccessCheck(
			cluster.sessionIds.map((id) =>
				extractVerificationCommands(byId.get(id)?.jsonl ?? ""),
			),
		);
		if (check === null) {
			rejected.push({
				prompt: cluster.prompt,
				reason:
					"no verification command recurs across a majority of its sessions — " +
					"nothing to derive a deterministic success check from",
			});
			continue;
		}
		const failsPristine =
			options.fixtureDir === null
				? null
				: checkFailsPristine(check, options.fixtureDir, options.spawn);
		if (failsPristine === false) {
			rejected.push({
				prompt: cluster.prompt,
				reason: `derived check "${check}" already PASSES on the pristine fixture — a dead sensor`,
			});
			continue;
		}
		drafted.push(
			renderDraft(agent, drafted.length + 1, {
				prompt: cluster.prompt,
				successCheck: check,
				repeatability,
				failsPristine,
				sessionIds: cluster.sessionIds,
				project: options.project ?? null,
			}),
		);
	}
	return {
		agent,
		drafted,
		rejected,
		sessionsSeen: available.length + missing,
		transcriptsMissing: missing,
	};
}

export function renderPlan(
	plan: DraftPlan,
	outDir: string,
	write: boolean,
): string {
	const lines: string[] = [];
	lines.push(`Golden-suite drafts for agent "${plan.agent}"`);
	lines.push(
		`  recorded real-work sessions: ${plan.sessionsSeen}` +
			(plan.transcriptsMissing > 0
				? ` (${plan.transcriptsMissing} with no transcript on disk)`
				: ""),
	);
	if (plan.drafted.length === 0) {
		lines.push("  NO: nothing could be drafted from the recorded data.");
	}
	for (const task of plan.drafted) {
		const rep = task.repeatability;
		lines.push("");
		lines.push(`  ${task.fileName}  [${task.id}]`);
		lines.push(`    prompt: ${displayText(task.prompt, 140)}`);
		lines.push(`    success_check: ${displayText(task.successCheck, 140)}`);
		lines.push(
			`    repeatability: ${rep.n} sessions, mean ${formatRounded(rep.meanTokens)} tok, ` +
				`spread ${(rep.spread * 100).toFixed(0)}%` +
				(rep.cv === null ? "" : `, cv ${(rep.cv * 100).toFixed(0)}%`) +
				(rep.toolCallSpread === null
					? ""
					: `, tool-call spread ${(rep.toolCallSpread * 100).toFixed(0)}%`),
		);
		lines.push(
			`    vacuity: ${
				task.failsPristine === null
					? "NOT PROBED (no fixture) — may be a dead sensor"
					: task.failsPristine
						? "OK: fails on the pristine fixture"
						: "WARNING: passes pristine"
			}`,
		);
	}
	for (const candidate of plan.rejected) {
		lines.push("");
		lines.push(`  NO: ${displayText(candidate.prompt, 100)}`);
		lines.push(`      ${candidate.reason}`);
	}
	lines.push("");
	if (write && plan.drafted.length > 0) {
		lines.push(`Wrote ${plan.drafted.length} draft(s) to ${outDir}`);
	} else if (plan.drafted.length > 0) {
		lines.push(
			`DRY RUN — nothing written. Re-run with --write to emit into ${outDir}`,
		);
	}
	if (plan.drafted.length > 0) {
		lines.push(
			"These drafts are UNVALIDATED: no model has run one. Review each file, move it" +
				`\nup one level out of drafts/ to activate it, then spend tokens on` +
				`\n  npx tsx src/bench.ts --agent ${plan.agent}` +
				"\nand read the per-task variance warnings — that run, not this report, is what" +
				"\nturns a drafted suite into a measuring instrument.",
		);
	}
	return lines.join("\n");
}

export interface DraftArgs {
	agent: string;
	projectsDir: string;
	out: string;
	minSessions: number;
	maxSpread: number;
	fixtureDir: string | null;
	write: boolean;
	/** Draft, probe against a real worktree, and promote what survives -- the
	 * hands-off path the SessionStart hook runs. */
	auto: boolean;
	json: boolean;
}

export function parseDraftArgs(argv: string[]): DraftArgs {
	let agent = "";
	let projectsDir = join(homedir(), ".claude", "projects");
	let out = "";
	let minSessions = DEFAULT_MIN_SESSIONS;
	let maxSpread = DEFAULT_MAX_SPREAD;
	let fixture: string | null = null;
	let noFixture = false;
	let write = false;
	let auto = false;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--agent":
				agent = value ?? "";
				i++;
				break;
			case "--projects":
				projectsDir = value ?? "";
				i++;
				break;
			case "--out":
				out = value ?? "";
				i++;
				break;
			case "--min-sessions":
				minSessions = numericFlag(value);
				i++;
				break;
			case "--max-spread":
				maxSpread = numericFlag(value);
				i++;
				break;
			case "--fixture":
				fixture = value ?? "";
				i++;
				break;
			case "--no-fixture":
				noFixture = true;
				break;
			case "--auto":
				auto = true;
				break;
			case "--write":
				write = true;
				break;
			case "--json":
				json = true;
				break;
			default:
				throw new Error(`unknown flag: ${flag}`);
		}
	}
	assertDraftTarget(agent);
	if (!Number.isInteger(minSessions) || minSessions < 2) {
		throw new Error("--min-sessions must be an integer >= 2");
	}
	if (!Number.isFinite(maxSpread) || maxSpread <= 0) {
		throw new Error("--max-spread must be a positive number (e.g. 0.25)");
	}
	// Default the probe to the agent's own fixture when one exists — the same
	// directory bench.ts will copy for the real run, so the probe answers the
	// question the run will ask. `--no-fixture` opts out; an explicit
	// `--fixture` that does not exist is a typo worth failing on.
	let fixtureDir: string | null;
	if (noFixture) {
		fixtureDir = null;
	} else if (fixture !== null) {
		if (!existsSync(fixture)) {
			throw new Error(`--fixture path not found: ${fixture}`);
		}
		fixtureDir = fixture;
	} else {
		const candidate = join(userFixturesDir(), agent);
		fixtureDir = existsSync(candidate) ? candidate : null;
	}
	return {
		agent,
		projectsDir,
		out: out || join(userBenchmarksDir(), agent, "drafts"),
		minSessions,
		maxSpread,
		fixtureDir,
		write,
		auto,
		json,
	};
}

/**
 * The repository the recorded sessions mostly ran in.
 *
 * A main-target task is benchmarked in a worktree of ONE repository, so the
 * suite has to pick one, and "where this work actually happened" is the only
 * defensible choice available from the ledger. Sessions from other projects are
 * simply not drafted; a second project gets its own suite the day someone asks
 * for one, rather than a suite that silently mixes two trees.
 */
export function modalProject(
	ledger: readonly RealWorkSession[],
): string | null {
	const counts = new Map<string, number>();
	for (const row of ledger) {
		if (row.project === null || row.project === "") continue;
		counts.set(row.project, (counts.get(row.project) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestCount = 0;
	// Ties break on the lexically first path, so the choice is deterministic
	// across runs rather than dependent on Map insertion order.
	for (const [project, count] of [...counts].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		if (count > bestCount) {
			best = project;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Which drafts may be PROMOTED into the suite without a human reading them.
 *
 * Promotion is the step that lets autopilot measure real work, and it is the
 * step where a bad task costs real tokens forever after, so the bar is narrower
 * than the bar for drafting:
 *
 *   - the repeatability gate already passed (the planner refuses anything else);
 *   - the derived check was PROBED against a pristine tree and FAILED there.
 *     `null` -- probed nowhere -- is not good enough here, though it is good
 *     enough to sit in `drafts/` for a human to judge. An unprobed check may be
 *     a dead sensor, and a dead sensor passes with and without a rule, which
 *     turns every verdict it touches into noise;
 *   - the task names the repository it runs in, because a main-target benchmark
 *     with no tree is not a measurement.
 *
 * Everything else stays a draft. This is the one place where "plug and play"
 * and "measure honestly" pull against each other, and the resolution is that
 * autopilot promotes only what it could verify by itself.
 */
export function promotable(drafted: readonly DraftedTask[]): DraftedTask[] {
	return drafted.filter(
		(task) => task.failsPristine === true && task.content.includes("project: "),
	);
}

export function main(argv: string[]): number {
	const args = parseDraftArgs(argv);
	// AUTOPILOT DRAFTING. `--auto` is what the SessionStart hook runs when the
	// main target still has no suite: resolve the repository the work happened
	// in, probe every derived check against a pristine worktree of it, and
	// promote what survives straight into the suite. The probe is why this
	// cannot simply be `--write` with a different output directory -- a check
	// that already passes on an untouched tree is a dead sensor, and only a real
	// tree can say which checks those are. Zero model tokens: it runs shell
	// commands in a throwaway worktree, and spawns no agent.
	let probeFixture: MainFixture | null = null;
	let project: string | null = null;
	const plan = withDb((db) => {
		const ledger = realWorkSessions(db, args.agent);
		const transcripts: SessionTranscript[] = [];
		for (const sessionId of new Set(ledger.map((row) => row.sessionId))) {
			const path = findTranscript(sessionId, args.projectsDir);
			if (path === null) continue;
			transcripts.push({ sessionId, jsonl: readFileSync(path, "utf8") });
		}
		let fixtureDir = args.fixtureDir;
		if (args.auto) {
			project = modalProject(ledger);
			if (project !== null) {
				try {
					probeFixture = provisionMainFixture(
						project,
						mkdtempSync(join(tmpdir(), "warden-draft-probe-")),
					);
					fixtureDir = probeFixture.dir;
				} catch {
					// Not a git repository, or git refused. Drafting still runs --
					// the drafts are useful to a human -- but nothing can be probed,
					// so nothing will be promotable.
					probeFixture = null;
				}
			}
		}
		return planDrafts(args.agent, ledger, transcripts, {
			minSessions: args.minSessions,
			maxSpread: args.maxSpread,
			fixtureDir,
			project,
		});
	});
	const promoted = args.auto ? promotable(plan.drafted) : [];
	try {
		if (args.auto) {
			// Promoted tasks go to the suite; everything else stays a draft, so a
			// human still sees what autopilot would not vouch for.
			const suiteDir = join(userBenchmarksDir(), args.agent);
			if (promoted.length > 0) {
				mkdirSync(suiteDir, { recursive: true });
				for (const task of promoted) {
					writeFileSync(join(suiteDir, task.fileName), task.content);
				}
			}
			const held = plan.drafted.filter((task) => !promoted.includes(task));
			if (held.length > 0) {
				mkdirSync(args.out, { recursive: true });
				for (const task of held) {
					writeFileSync(join(args.out, task.fileName), task.content);
				}
			}
		} else if (args.write && plan.drafted.length > 0) {
			mkdirSync(args.out, { recursive: true });
			for (const task of plan.drafted) {
				writeFileSync(join(args.out, task.fileName), task.content);
			}
		}
	} finally {
		if (probeFixture !== null) (probeFixture as MainFixture).release();
	}
	if (args.json) {
		console.log(
			JSON.stringify(
				{
					agent: plan.agent,
					out: args.out,
					written: args.write,
					sessionsSeen: plan.sessionsSeen,
					transcriptsMissing: plan.transcriptsMissing,
					drafted: plan.drafted.map((task) => ({
						id: task.id,
						file: task.fileName,
						prompt: task.prompt,
						successCheck: task.successCheck,
						repeatability: task.repeatability,
						failsPristine: task.failsPristine,
					})),
					rejected: plan.rejected,
				},
				null,
				2,
			),
		);
	} else {
		console.log(renderPlan(plan, args.out, args.write));
	}
	return 0;
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	return main(process.argv.slice(2));
});
/* v8 ignore stop */
