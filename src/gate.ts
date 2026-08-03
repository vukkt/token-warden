/**
 * Inter-agent approval gate (Agent Teams, experimental).
 *
 * PreToolUse on the `SendMessage` tool: logs the cross-agent question and
 * returns permissionDecision "ask" so the user sees
 *   [frontend → backend] "…question…" — approve?
 * and decides. PostToolUse on the same matcher (invoked with --post) marks
 * the question approved — it only fires when the send actually executed.
 *
 * Degrades gracefully: without CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS the
 * SendMessage tool never appears, so these hooks are inert. Any internal
 * error fails OPEN (no output, exit 0 → normal permission flow) and is
 * logged to gate.log next to the DB; the gate must never break a session.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	approveLatestQuestion,
	defaultDbPath,
	insertQuestion,
	withDb,
} from "./db.js";
import { displayText } from "./sanitize.js";

const GATED_TOOL = "SendMessage";
const PREVIEW_CHARS = 200;
/** Cap on a sanitized agent name shown in the approval prompt — a hostile
 * `recipient` value must not flood or smuggle structure into the line. */
const NAME_CHARS = 60;
/** Cap on the question body persisted to SQLite — a single chatty or
 * hostile teammate message must not bloat the ledger. Applied identically
 * at insert and approve time so the pending-row match still works. */
const STORED_BODY_CHARS = 2000;
/** Rotate gate.log past this size, keeping one generation. Every gated message
 * writes a line, so an unrotated log grows without bound in the user's
 * ~/.token-warden directory. */
const LOG_MAX_BYTES = 1024 * 1024;

function logLine(message: string): void {
	try {
		const logPath = join(dirname(defaultDbPath()), "gate.log");
		mkdirSync(dirname(logPath), { recursive: true });
		try {
			if (statSync(logPath).size > LOG_MAX_BYTES) {
				renameSync(logPath, `${logPath}.1`);
			}
		} catch {
			// No log yet (or rotation raced another hook): just append.
		}
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never take the gate down.
	}
}

const payloadSchema = z.looseObject({
	hook_event_name: z.string().nullish(),
	tool_name: z.string(),
	tool_input: z.record(z.string(), z.unknown()).nullish().catch(null),
	agent_id: z.string().nullish(),
	agent_type: z.string().nullish(),
});

export interface GatedMessage {
	from: string;
	to: string;
	body: string;
}

function firstString(
	input: Record<string, unknown>,
	keys: string[],
): string | null {
	for (const key of keys) {
		// Own properties only: a payload carrying a `__proto__` object must not
		// be able to answer for `message`/`recipient` through the prototype
		// chain and conjure a gated message the tool never sent. (zod's record
		// parser already drops `__proto__`; this is the belt to that braces.)
		if (!Object.hasOwn(input, key)) continue;
		const value = input[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return null;
}

/**
 * Extract sender, recipient, and question text from a PreToolUse payload.
 * Field names are matched defensively (the SendMessage input schema is
 * experimental); returns null when this is not a gateable message.
 */
export function extractMessage(payload: unknown): GatedMessage | null {
	const result = payloadSchema.safeParse(payload);
	if (!result.success) return null;
	const parsed = result.data;
	if (parsed.tool_name !== GATED_TOOL) return null;
	const input = parsed.tool_input ?? {};
	const to = firstString(input, [
		"recipient",
		"to",
		"agent",
		"agent_name",
		"name",
	]);
	const body = firstString(input, [
		"message",
		"content",
		"body",
		"text",
		"prompt",
	]);
	if (to === null || body === null) return null;
	const from = parsed.agent_type ?? parsed.agent_id ?? "lead";
	return { from, to, body };
}

/** One-line, length-capped, control/ANSI-stripped form of an untrusted
 * message body. Delegates to the shared sanitizer so a hostile teammate
 * message cannot forge the approval prompt, the stored ledger row, or a log
 * line. Used identically at insert and approve time so the pending-row match
 * still holds. */
export function truncateBody(body: string, max = PREVIEW_CHARS): string {
	return displayText(body, max);
}

export interface AskResponse {
	hookSpecificOutput: {
		hookEventName: "PreToolUse";
		permissionDecision: "ask";
		permissionDecisionReason: string;
	};
}

export function buildAskResponse(message: GatedMessage): AskResponse {
	// Every interpolated field is untrusted: `body` and `to` come straight from
	// the tool input, `from` from the harness. Sanitize each so the prompt the
	// user approves cannot be forged with ANSI/control sequences or flooded.
	const from = displayText(message.from, NAME_CHARS);
	const to = displayText(message.to, NAME_CHARS);
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
			permissionDecisionReason: `[${from} → ${to}] "${truncateBody(message.body)}" — approve?`,
		},
	};
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Hook body. Deliberately NOT self-catching: the CLI shim below is the single
 * fail-open boundary (log the detail, exit 0), so every throw in here — bad
 * JSON on stdin, an unopenable or corrupt DB, a failed insert — reaches the
 * same place and produces the same outcome: no stdout, exit 0, normal
 * permission flow. Tests assert that at the process level.
 */
export async function main(): Promise<void> {
	const isPost = process.argv.includes("--post");
	const message = extractMessage(JSON.parse(await readStdin()));
	if (message === null) return;

	return withDb((db) => {
		const storedBody = truncateBody(message.body, STORED_BODY_CHARS);
		// Sanitize the route for the log file too; from/to are stored raw and
		// sanitized at render time (status.ts), matching the rule-body pattern.
		const route = `${displayText(message.from, NAME_CHARS)} → ${displayText(message.to, NAME_CHARS)}`;
		if (isPost) {
			const marked = approveLatestQuestion(
				db,
				message.from,
				message.to,
				storedBody,
			);
			logLine(
				`approved [${route}]${marked ? "" : " (no pending row matched)"}`,
			);
		} else {
			insertQuestion(
				db,
				message.from,
				message.to,
				storedBody,
				new Date().toISOString(),
			);
			logLine(`asked [${route}] "${truncateBody(message.body, 80)}"`);
			console.log(JSON.stringify(buildAskResponse(message)));
		}
	});
}

/**
 * Register the process-level fail-open net: exit 0 on an asynchronous failure
 * nobody owns. The try/catch below only covers what `main()` awaits — an
 * 'error' event on process.stdin (a harness that dies mid-write), or a
 * rejected promise with no awaiter, reaches the process instead, and Node 22
 * terminates non-zero on an unhandled rejection by default. A PreToolUse hook
 * that exits non-zero is exactly the "gate breaks the session" outcome this
 * file exists to prevent. Exported (and outside the entry shim) so the
 * behaviour is testable.
 */
export function installFailOpenHandlers(
	log: (message: string) => void = logLine,
	exit: (code: number) => void = process.exit,
): void {
	const bailOut = (kind: string) => (err: unknown) => {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		log(`gate ${kind} (failing open): ${detail}`);
		exit(0);
	};
	process.on("uncaughtException", bailOut("uncaught exception"));
	process.on("unhandledRejection", bailOut("unhandled rejection"));
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	installFailOpenHandlers();
	try {
		await main();
	} catch (err) {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		logLine(`gate error (failing open): ${detail}`);
	}
	process.exit(0);
}
/* v8 ignore stop */
