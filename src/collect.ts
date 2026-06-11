/**
 * Stop-hook entrypoint. Reads the hook payload from stdin, parses the
 * session transcript, and upserts one `runs` row.
 *
 * Hard requirements (spec §1.3): never block or fail the user's session.
 * Every failure path logs to collect.log (next to the DB) and exits 0.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defaultDbPath, openDb, upsertRun } from "./db.js";
import { parseTranscript } from "./transcript.js";
import { DOMAIN_AGENTS } from "./types.js";

const hookPayloadSchema = z.looseObject({
	session_id: z.string(),
	transcript_path: z.string(),
	hook_event_name: z.string().nullish(),
	/** Present on agent-related hook events; absent on plain Stop. */
	agent_type: z.string().nullish(),
});

function logLine(message: string): void {
	try {
		const logPath = join(dirname(defaultDbPath()), "collect.log");
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never take the hook down.
	}
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
	if (agentType && (DOMAIN_AGENTS as readonly string[]).includes(agentType)) {
		return agentType;
	}
	return parsedAgent;
}

async function main(): Promise<void> {
	const payload = hookPayloadSchema.parse(JSON.parse(await readStdin()));
	const jsonl = readFileSync(payload.transcript_path, "utf8");
	const parsed = parseTranscript(jsonl);

	if (parsed.entryCount === 0) {
		logLine(
			`skip session=${payload.session_id}: no parseable conversational entries ` +
				`(malformed=${parsed.malformedLines})`,
		);
		return;
	}

	const db = openDb();
	try {
		upsertRun(db, {
			agent: resolveAgent(payload.agent_type, parsed.agent),
			sessionId: payload.session_id,
			taskHash: null,
			inputTokens: parsed.inputTokens,
			outputTokens: parsed.outputTokens,
			cacheCreation: parsed.cacheCreation,
			cacheRead: parsed.cacheRead,
			toolCalls: parsed.toolCalls,
			fileRereads: parsed.fileRereads,
			completed: parsed.completed,
			rulesetVersion: 0,
			ts: new Date().toISOString(),
		});
	} finally {
		db.close();
	}
}

try {
	await main();
} catch (err) {
	const detail =
		err instanceof Error ? (err.stack ?? err.message) : String(err);
	logLine(`collect error: ${detail}`);
}
process.exit(0);
