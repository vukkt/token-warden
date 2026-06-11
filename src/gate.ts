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
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	approveLatestQuestion,
	defaultDbPath,
	insertQuestion,
	openDb,
} from "./db.js";

const GATED_TOOL = "SendMessage";
const PREVIEW_CHARS = 200;

function logLine(message: string): void {
	try {
		const logPath = join(dirname(defaultDbPath()), "gate.log");
		mkdirSync(dirname(logPath), { recursive: true });
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

export function truncateBody(body: string, max = PREVIEW_CHARS): string {
	const oneLine = body.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export interface AskResponse {
	hookSpecificOutput: {
		hookEventName: "PreToolUse";
		permissionDecision: "ask";
		permissionDecisionReason: string;
	};
}

export function buildAskResponse(message: GatedMessage): AskResponse {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
			permissionDecisionReason: `[${message.from} → ${message.to}] "${truncateBody(message.body)}" — approve?`,
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

async function main(): Promise<void> {
	const isPost = process.argv.includes("--post");
	const message = extractMessage(JSON.parse(await readStdin()));
	if (message === null) return;

	const db = openDb();
	try {
		if (isPost) {
			const marked = approveLatestQuestion(
				db,
				message.from,
				message.to,
				message.body,
			);
			logLine(
				`approved [${message.from} → ${message.to}]${marked ? "" : " (no pending row matched)"}`,
			);
		} else {
			insertQuestion(
				db,
				message.from,
				message.to,
				message.body,
				new Date().toISOString(),
			);
			logLine(
				`asked [${message.from} → ${message.to}] "${truncateBody(message.body, 80)}"`,
			);
			console.log(JSON.stringify(buildAskResponse(message)));
		}
	} finally {
		db.close();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		await main();
	} catch (err) {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		logLine(`gate error (failing open): ${detail}`);
	}
	process.exit(0);
}
