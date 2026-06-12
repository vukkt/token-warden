/**
 * Stop-hook entrypoint. Reads the hook payload from stdin, parses the
 * session transcript, and upserts one `runs` row.
 *
 * Hard requirements (spec §1.3): never block or fail the user's session.
 * Every failure path logs to collect.log (next to the DB) and exits 0.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defaultDbPath, getRulesetVersion, openDb, upsertRun } from "./db.js";
import { shouldDistill } from "./distill.js";
import { parseTranscriptFile } from "./transcript.js";
import { DOMAIN_AGENTS } from "./types.js";

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

async function main(): Promise<void> {
	const payload = hookPayloadSchema.parse(JSON.parse(await readStdin()));

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
			(DOMAIN_AGENTS as readonly string[]).includes(agent) &&
			shouldDistill(db, agent, runId, total)
		) {
			spawn(
				"npx",
				[
					"tsx",
					join(pluginRoot, "src", "distill.ts"),
					"--run",
					String(runId),
					"--transcript",
					payload.transcript_path,
				],
				{ cwd: pluginRoot, detached: true, stdio: "ignore" },
			).unref();
			logLine(`run ${runId} above p75 for ${agent}; distiller spawned`);
		}
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
