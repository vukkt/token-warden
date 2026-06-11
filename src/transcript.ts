import { z } from "zod";
import type { ParsedRun } from "./types.js";

/** Token counters default to 0 when missing, null, or malformed — a single
 * odd usage object must never poison the whole transcript. */
const tokenCount = z.number().int().nonnegative().catch(0);

const usageSchema = z.looseObject({
	input_tokens: tokenCount,
	output_tokens: tokenCount,
	cache_creation_input_tokens: tokenCount,
	cache_read_input_tokens: tokenCount,
});

const contentBlockSchema = z.looseObject({
	type: z.string(),
	id: z.string().nullish(),
	name: z.string().nullish(),
	input: z.record(z.string(), z.unknown()).nullish().catch(null),
	text: z.string().nullish(),
});

const messageSchema = z.looseObject({
	id: z.string().nullish(),
	usage: usageSchema.nullish().catch(null),
	content: z
		.union([z.string(), z.array(contentBlockSchema)])
		.nullish()
		.catch(null),
});

const entrySchema = z.looseObject({
	type: z.string(),
	uuid: z.string().nullish(),
	requestId: z.string().nullish(),
	sessionId: z.string().nullish(),
	isSidechain: z.boolean().nullish(),
	agentId: z.string().nullish(),
	agentName: z.string().nullish(),
	isApiErrorMessage: z.boolean().nullish(),
	message: messageSchema.nullish(),
});

type Entry = z.infer<typeof entrySchema>;
type Usage = z.infer<typeof usageSchema>;

/** Entry types that are part of the conversation itself; everything else
 * (file-history-snapshot, system, attachment, mode, ...) is bookkeeping. */
const CONVERSATIONAL = new Set(["user", "assistant"]);

function hasTextContent(entry: Entry): boolean {
	const content = entry.message?.content;
	if (typeof content === "string") return content.length > 0;
	if (Array.isArray(content)) {
		return content.some((block) => block.type === "text");
	}
	return false;
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Render a compact, human-readable action trace of a transcript for the
 * distiller's prompt: user/assistant text (truncated) and tool calls with
 * their inputs. Capped to `maxChars` by keeping the head and tail — the
 * start shows the task, the tail shows how the session bogged down.
 */
export function digestTranscript(jsonlText: string, maxChars = 8000): string {
	const lines: string[] = [];
	for (const line of jsonlText.split(/\r?\n/)) {
		if (!line || line.trim() === "") continue;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			continue;
		}
		const result = entrySchema.safeParse(raw);
		if (!result.success) continue;
		const entry = result.data;
		if (!CONVERSATIONAL.has(entry.type)) continue;
		const content = entry.message?.content;
		if (typeof content === "string") {
			lines.push(`${entry.type.toUpperCase()}: ${truncate(content, 200)}`);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text" && block.text) {
					lines.push(
						`${entry.type.toUpperCase()}: ${truncate(block.text, 200)}`,
					);
				} else if (block.type === "tool_use") {
					const input = truncate(JSON.stringify(block.input ?? {}), 160);
					lines.push(`TOOL ${block.name ?? "unknown"} ${input}`);
				}
			}
		}
	}
	const text = lines.join("\n");
	if (text.length <= maxChars) return text;
	const head = text.slice(0, Math.floor(maxChars * 0.4));
	const tail = text.slice(-Math.floor(maxChars * 0.55));
	return `${head}\n…[transcript truncated]…\n${tail}`;
}

/**
 * Parse one transcript JSONL into run aggregates.
 *
 * Tolerance contract: never throws on bad input. Malformed lines are skipped
 * and counted. Usage is deduplicated by message id because Claude Code writes
 * one JSONL entry per streamed content block, repeating the same `usage`
 * object on every entry of the same API message.
 */
export function parseTranscript(jsonlText: string): ParsedRun {
	let malformedLines = 0;
	let entryCount = 0;
	let toolCalls = 0;
	let sessionId: string | null = null;
	let agentName: string | null = null;
	let agentId: string | null = null;
	let isSidechain = false;
	let lastConversational: Entry | null = null;

	const usageByMessage = new Map<string, Usage>();
	const seenToolUseIds = new Set<string>();
	const readCounts = new Map<string, number>();

	const lines = jsonlText.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line || line.trim() === "") continue;

		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			malformedLines++;
			continue;
		}
		const result = entrySchema.safeParse(raw);
		if (!result.success) {
			malformedLines++;
			continue;
		}
		const entry = result.data;

		sessionId ??= entry.sessionId ?? null;
		agentId ??= entry.agentId ?? null;
		agentName ??= entry.agentName ?? null;
		if (entry.isSidechain === true) isSidechain = true;

		if (!CONVERSATIONAL.has(entry.type)) continue;
		entryCount++;
		lastConversational = entry;

		if (entry.type !== "assistant") continue;
		const message = entry.message;
		if (message?.usage) {
			const key = message.id ?? entry.requestId ?? entry.uuid ?? `line-${i}`;
			usageByMessage.set(key, message.usage);
		}
		if (Array.isArray(message?.content)) {
			for (const block of message.content) {
				if (block.type !== "tool_use") continue;
				if (block.id) {
					if (seenToolUseIds.has(block.id)) continue;
					seenToolUseIds.add(block.id);
				}
				toolCalls++;
				if (block.name === "Read") {
					const filePath = block.input?.file_path;
					if (typeof filePath === "string") {
						readCounts.set(filePath, (readCounts.get(filePath) ?? 0) + 1);
					}
				}
			}
		}
	}

	let inputTokens = 0;
	let outputTokens = 0;
	let cacheCreation = 0;
	let cacheRead = 0;
	for (const usage of usageByMessage.values()) {
		inputTokens += usage.input_tokens;
		outputTokens += usage.output_tokens;
		cacheCreation += usage.cache_creation_input_tokens;
		cacheRead += usage.cache_read_input_tokens;
	}

	let fileRereads = 0;
	for (const count of readCounts.values()) {
		if (count >= 2) fileRereads++;
	}

	// Completion heuristic (see DECISIONS.md): the transcript ends with an
	// assistant message that contains text and is not an API error. Aborted
	// sessions end with a user entry ("[Request interrupted by user]" or a
	// dangling tool_result), failed ones with isApiErrorMessage on the tail.
	const completed =
		lastConversational !== null &&
		lastConversational.type === "assistant" &&
		lastConversational.isApiErrorMessage !== true &&
		hasTextContent(lastConversational);

	return {
		agent: agentName ?? "main",
		sessionId,
		inputTokens,
		outputTokens,
		cacheCreation,
		cacheRead,
		toolCalls,
		fileRereads,
		completed,
		entryCount,
		malformedLines,
		isSidechain,
		agentId,
	};
}
