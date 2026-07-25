/**
 * Stop-hook entrypoint. Reads the hook payload from stdin, parses the
 * session transcript, and upserts one `runs` row.
 *
 * Hard requirements (spec §1.3): never block or fail the user's session.
 * Every failure path logs to collect.log (next to the DB) and exits 0.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { aggregateToolCosts } from "./attribute.js";
import {
	defaultDbPath,
	getRulesetVersion,
	openDb,
	recentRealWorkTotals,
	recordToolCosts,
	upsertRun,
	type WardenDb,
} from "./db.js";
import { shouldDistill } from "./distill.js";
import { knownAgents } from "./registry.js";
import { displayText } from "./sanitize.js";
import { parseTranscriptFile } from "./transcript.js";

/** A session is flagged anomalous when its total tokens reach this multiple
 * of the agent's recent median, given at least this many prior sessions. */
const ANOMALY_MULTIPLE = 2;
const ANOMALY_MIN_PRIORS = 5;
const ANOMALY_WINDOW = 50;

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
		: (sorted[mid] ?? 0);
}

/**
 * Pure anomaly detector: returns how many times the agent's recent median
 * this session cost, when that reaches the alert multiple — else null. A
 * higher bar than the distiller's p75 trigger, so alerts stay rare and
 * meaningful.
 */
export function detectAnomaly(
	priors: number[],
	current: number,
): number | null {
	if (priors.length < ANOMALY_MIN_PRIORS) return null;
	const med = median(priors);
	if (med <= 0) return null;
	const multiple = current / med;
	return multiple >= ANOMALY_MULTIPLE ? multiple : null;
}

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const hookPayloadSchema = z.looseObject({
	session_id: z.string(),
	transcript_path: z.string(),
	cwd: z.string().nullish(),
	hook_event_name: z.string().nullish(),
	/** Present on agent-related hook events (SubagentStop); absent on Stop. */
	agent_type: z.string().nullish(),
	agent_id: z.string().nullish(),
});

/**
 * The hook's own runtime cap (spec: total hook runtime under 2s). Enforced by
 * a watchdog in the CLI shim rather than left to the harness timeout, so a
 * pathological transcript or a wedged filesystem costs the user a logged
 * skip instead of a stalled session. Overridable for tests.
 */
export const HOOK_BUDGET_MS = 2000;

/** Resolve the watchdog budget from the environment. Total: any unusable
 * value (absent, non-numeric, negative, infinite) falls back to the default. */
export function hookBudgetMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.TOKEN_WARDEN_HOOK_BUDGET_MS;
	// An empty variable is "unset", not zero — Number("") is 0 and would
	// otherwise silently disable collection for anyone who exports it blank.
	if (raw === undefined || raw.trim() === "") return HOOK_BUDGET_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : HOOK_BUDGET_MS;
}

/** Append one line to collect.log. Every interpolated value here is
 * untrusted (session ids, paths, agent names, error text from other code),
 * so the whole line is flattened through `displayText`: a newline in a
 * transcript-supplied name must not be able to forge a log entry, and an
 * escape sequence must not fire when the user cats the log. */
function logLine(message: string): void {
	try {
		const logPath = join(dirname(defaultDbPath()), "collect.log");
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(
			logPath,
			`${new Date().toISOString()} ${displayText(message, 2000)}\n`,
		);
	} catch {
		// Logging must never take the hook down.
	}
}

/**
 * SQLite contention handling. "The database was busy" is TRANSIENT and
 * retryable; every other failure (unparseable transcript, unwritable path) is
 * permanent and correctly skipped. Treating them alike silently deleted whole
 * sessions from the ledger, and every downstream number — the p75 distill
 * trigger, the anomaly median, cohort validation, dollar accounting — is then
 * computed over a corpus with unexplained holes.
 *
 * The per-attempt wait is deliberately far below db.ts's 2000ms default:
 * that default equals the hook's ENTIRE budget, so one blocked attempt would
 * eat it whole and the watchdog would kill us before a single retry. Three
 * attempts at 300ms plus jitter stays inside the cap.
 */
const DB_RETRY_ATTEMPTS = 3;
const HOOK_BUSY_TIMEOUT_MS = 300;
const DB_RETRY_BASE_MS = 50;
const DB_RETRY_JITTER_MS = 100;

/** Marker for a session the ledger genuinely lost. Greppable on purpose:
 * `grep -c 'collect DROP' collect.log` counts them, instead of the loss being
 * buried in a stack trace that reads like any other error. */
const DROP_MARKER = "collect DROP";

/** Is this a lock-contention failure rather than a real fault? Checked by
 * code first (better-sqlite3 sets SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT) with a
 * message fallback, since the driver reports some lock states as plain
 * "database is locked" without a distinct code. */
export function isBusyError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null | undefined)?.code;
	if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
	const message = err instanceof Error ? err.message : String(err);
	return /database (is locked|table is locked)/i.test(message);
}

const sleep = (ms: number): Promise<void> =>
	new Promise((done) => setTimeout(done, ms));

/**
 * Run a synchronous DB operation, retrying only while SQLite reports
 * contention. Jittered so two hooks that collide do not re-collide in step.
 * Any non-busy error propagates on the first attempt — retrying a genuine
 * fault would just burn the hook's budget.
 */
export async function withBusyRetry<T>(
	operation: () => T,
	options: {
		attempts?: number;
		delayMs?: (attempt: number) => number;
	} = {},
): Promise<T> {
	const attempts = options.attempts ?? DB_RETRY_ATTEMPTS;
	const delayMs =
		options.delayMs ??
		(() => DB_RETRY_BASE_MS + Math.random() * DB_RETRY_JITTER_MS);
	for (let attempt = 1; ; attempt++) {
		try {
			return operation();
		} catch (err) {
			if (attempt >= attempts || !isBusyError(err)) throw err;
			await sleep(delayMs(attempt));
		}
	}
}

/** Open the ledger for the hook: same DB as everything else, but with a
 * per-attempt lock wait short enough to leave room for a retry. */
function openHookDb(): WardenDb {
	const db = openDb();
	try {
		db.pragma(`busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
	} catch (err) {
		db.close();
		throw err;
	}
	return db;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function resolveAgent(
	agentType: string | null | undefined,
	parsedAgent: string,
): string {
	if (agentType && knownAgents().includes(agentType)) {
		return agentType;
	}
	return parsedAgent;
}

/** SubagentStop payloads carry the PARENT transcript path (verified live);
 * the subagent's own transcript sits beside it at
 * `<parent minus .jsonl>/subagents/agent-<agent_id>.jsonl`. */
function subagentTranscriptPath(
	parentTranscript: string,
	agentId: string,
): string {
	return join(
		parentTranscript.replace(/\.jsonl$/, ""),
		"subagents",
		`agent-${agentId}.jsonl`,
	);
}

export async function main(): Promise<void> {
	// Explicit opt-out, honoured before stdin is even read. The benchmark
	// spawns real `claude -p` children, and the Stop hook fires inside every
	// one of them: without this each child upserts a config:"real" row with
	// fixture-shaped token counts and a temp-dir project path, so the plugin
	// measures ITSELF and books it as the user's workload. Silent by design —
	// a benchmark runs hundreds of children and a log line each would bury
	// the entries that matter.
	if (process.env.TOKEN_WARDEN_NO_COLLECT === "1") return;

	const payload = hookPayloadSchema.parse(JSON.parse(await readStdin()));

	// NOTE: a cwd-under-tmpdir heuristic was tried here as "belt and braces" for
	// the same phantom-row class and deliberately REMOVED. It is too broad in
	// both directions: real work done in a temp checkout (a scratch clone, a
	// `git worktree` under /tmp) would be silently dropped from the ledger, and
	// the entire test suite runs in temp dirs, so it disabled collection wherever
	// it was exercised. TOKEN_WARDEN_NO_COLLECT is the precise discriminator —
	// the benchmark sets it explicitly in benchChildEnv() — and a heuristic that
	// discards genuine measurements to catch a hypothetical stale-env case is a
	// bad trade for a ledger whose rows cannot be reconstructed.

	// SubagentStop events record the subagent's work under a suffixed session
	// key (the subagent shares the parent's session_id) using the subagent's
	// own sidechain transcript — the payload's transcript_path is the parent
	// conversation and must not be double-counted under another name.
	const isSubagentEvent = payload.hook_event_name === "SubagentStop";
	let transcriptPath = payload.transcript_path;
	if (isSubagentEvent) {
		const derived =
			payload.agent_id != null
				? subagentTranscriptPath(payload.transcript_path, payload.agent_id)
				: null;
		if (derived === null || !existsSync(derived)) {
			logLine(
				`skip subagent event session=${payload.session_id}: no sidechain transcript` +
					`${derived ? ` at ${derived}` : " (no agent_id in payload)"}`,
			);
			return;
		}
		transcriptPath = derived;
	}

	// A transcript_path that exists but is not a regular file (FIFO, socket,
	// device, directory) can wedge the process inside open() — and a blocked
	// open holds a threadpool thread that even process.exit() waits on, so
	// neither the watchdog below nor the harness timeout can rescue it
	// cleanly. stat() never blocks, so this cheap check is the only reliable
	// guard. A missing path falls through deliberately: parseTranscriptFile
	// rejects and the shim logs it, which is the existing contract.
	const stat = statSync(transcriptPath, { throwIfNoEntry: false });
	if (stat !== undefined && !stat.isFile()) {
		logLine(
			`skip session=${payload.session_id}: transcript is not a regular file ` +
				`at ${transcriptPath}`,
		);
		return;
	}

	// Streamed line-by-line: peak memory stays flat even for huge transcripts.
	const parsed = await parseTranscriptFile(transcriptPath);

	if (parsed.entryCount === 0) {
		logLine(
			`skip session=${payload.session_id}: no parseable conversational entries ` +
				`(malformed=${parsed.malformedLines})`,
		);
		return;
	}
	if (isSubagentEvent && !parsed.isSidechain && parsed.agentId === null) {
		logLine(
			`skip subagent event session=${payload.session_id}: transcript is not a sidechain`,
		);
		return;
	}

	const sessionKey = isSubagentEvent
		? `${payload.session_id}#${payload.agent_id}`
		: payload.session_id;
	// Subagent events trust the harness-provided agent_type verbatim (it
	// names the agent definition); plain Stop falls back to the parsed
	// transcript, mapping unknown names to 'main'.
	const agent = isSubagentEvent
		? (payload.agent_type ?? parsed.agent)
		: resolveAgent(payload.agent_type, parsed.agent);
	const db = openDb();
	try {
		const runId = upsertRun(db, {
			agent,
			sessionId: sessionKey,
			taskHash: null,
			inputTokens: parsed.inputTokens,
			outputTokens: parsed.outputTokens,
			cacheCreation: parsed.cacheCreation,
			cacheRead: parsed.cacheRead,
			toolCalls: parsed.toolCalls,
			fileRereads: parsed.fileRereads,
			completed: parsed.completed,
			rulesetVersion: getRulesetVersion(db, agent),
			ts: new Date().toISOString(),
			config: "real",
			project: payload.cwd ?? null,
		});

		// Attribute this session's tool/skill/MCP footprint for the
		// /warden-attribute breakdown. Pure aggregation over already-parsed
		// data; recorded in the same fail-open block as the run.
		recordToolCosts(db, runId, aggregateToolCosts(parsed.toolEvents));

		// Distillation calls a model and takes far longer than the 2s hook
		// budget, so it runs as a detached fire-and-forget child. The cheap
		// p75 trigger check happens here to avoid pointless spawns.
		const total =
			parsed.inputTokens +
			parsed.outputTokens +
			parsed.cacheCreation +
			parsed.cacheRead;
		// Only domain agents are distilled: rules for any other agent (incl.
		// 'main') have no golden suite and could never be measured, so their
		// candidates would queue forever.
		if (
			process.env.TOKEN_WARDEN_NO_DISTILL !== "1" &&
			knownAgents().includes(agent) &&
			shouldDistill(db, agent, runId, total)
		) {
			const child = spawn(
				"npx",
				[
					"tsx",
					join(pluginRoot, "src", "distill.ts"),
					"--run",
					String(runId),
					// The RESOLVED path, not payload.transcript_path: on a
					// SubagentStop the payload names the PARENT conversation, so
					// passing it here would distil a rule for the subagent out of
					// evidence the subagent never produced — the run row and the
					// waste trace must describe the same session.
					"--transcript",
					transcriptPath,
				],
				{ cwd: pluginRoot, detached: true, stdio: "ignore" },
			);
			// A spawn failure (npx missing, ENOMEM) arrives as an async 'error'
			// event; an EventEmitter with no 'error' listener THROWS it, which
			// would surface as an uncaught exception rather than a fail-open
			// skip. Swallow it — the distiller is best-effort by design.
			child.on("error", (err: Error) => {
				logLine(`distiller spawn failed: ${err.message}`);
			});
			child.unref();
			logLine(`run ${runId} above p75 for ${agent}; distiller spawned`);
		}

		// Real-time cost anomaly alert: when a MAIN session ends unusually
		// expensive for its agent, surface a one-line heads-up to the user via
		// systemMessage (not additionalContext — we inform the human, we do
		// not make Claude react and risk a loop). Subagent events are
		// mid-conversation, so they are collected but not alerted on.
		if (process.env.TOKEN_WARDEN_NO_ALERTS !== "1" && !isSubagentEvent) {
			const priors = recentRealWorkTotals(db, agent, ANOMALY_WINDOW, runId);
			const multiple = detectAnomaly(priors, total);
			if (multiple !== null) {
				// `agent` can come from the transcript's own agentName field —
				// untrusted text on its way to the user's terminal. JSON encoding
				// alone is not protection: a \u001b escape in the payload is decoded
				// back to a live control byte when the client renders the message.
				const msg =
					`token-warden: this ${displayText(agent, 40)} session used ${total.toLocaleString("en-US")} tokens` +
					` — ~${multiple.toFixed(1)}× your recent median` +
					` (${parsed.toolCalls} tool calls, ${parsed.fileRereads} file re-reads).`;
				console.log(JSON.stringify({ systemMessage: msg }));
				logLine(`anomaly alert for ${agent}: ${multiple.toFixed(1)}x median`);
			}
		}
	} finally {
		db.close();
	}
}

// Only run the hook when invoked as a script. Guarding this lets the module
// be imported (e.g. to unit-test detectAnomaly) without executing main(),
// which would block forever on stdin and then process.exit().
/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	// Exit 0 on EVERY path, not just the ones main() can throw on. An async
	// failure with no owner (an 'error' event, a rejected promise nobody
	// awaited) would otherwise crash the hook with a non-zero status and,
	// depending on the harness, surface as a broken session.
	const bailOut = (kind: string) => (err: unknown) => {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		logLine(`collect ${kind}: ${detail}`);
		process.exit(0);
	};
	process.on("uncaughtException", bailOut("uncaught exception"));
	process.on("unhandledRejection", bailOut("unhandled rejection"));

	// Enforce the 2s cap ourselves instead of trusting the harness timeout
	// (currently 120s for Stop): a pathological transcript or a slow disk
	// costs the user a logged skip, not a stalled session. Safe to exit at
	// any point this can fire — better-sqlite3 is synchronous, so a timer
	// callback can never interleave with a half-written transaction.
	// Limit, measured not assumed: this cannot rescue a thread blocked inside
	// a syscall (a FIFO open), because process.exit() then waits on that same
	// thread. The statSync guard in main() is what covers that case.
	const budget = hookBudgetMs();
	const watchdog = setTimeout(() => {
		logLine(`collect abort: hook budget of ${budget}ms exceeded`);
		process.exit(0);
	}, budget);

	try {
		await main();
	} catch (err) {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		logLine(`collect error: ${detail}`);
	} finally {
		clearTimeout(watchdog);
	}
	process.exit(0);
}
/* v8 ignore stop */
