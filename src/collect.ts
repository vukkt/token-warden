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
} from "./db.js";
import { shouldDistill } from "./distill.js";
import { parseTranscriptFile } from "./transcript.js";
import { DOMAIN_AGENTS } from "./types.js";

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

export async function main(): Promise<void> {
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

		// Real-time cost anomaly alert: when a MAIN session ends unusually
		// expensive for its agent, surface a one-line heads-up to the user via
		// systemMessage (not additionalContext — we inform the human, we do
		// not make Claude react and risk a loop). Subagent events are
		// mid-conversation, so they are collected but not alerted on.
		if (process.env.TOKEN_WARDEN_NO_ALERTS !== "1" && !isSubagentEvent) {
			const priors = recentRealWorkTotals(db, agent, ANOMALY_WINDOW, runId);
			const multiple = detectAnomaly(priors, total);
			if (multiple !== null) {
				const msg =
					`token-warden: this ${agent} session used ${total.toLocaleString("en-US")} tokens` +
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
	try {
		await main();
	} catch (err) {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		logLine(`collect error: ${detail}`);
	}
	process.exit(0);
}
/* v8 ignore stop */
