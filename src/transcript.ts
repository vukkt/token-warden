import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ParsedRun, RawToolEvent } from "./types.js";

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
	/** Present on `tool_result` blocks — links the result back to its call. */
	tool_use_id: z.string().nullish(),
	/** A `tool_result` payload: a string, or an array of nested blocks. Kept
	 * as `unknown[]` so one odd element (a bare string, an image block) does
	 * not fail validation and zero out the whole result; `resultContentChars`
	 * reads each element defensively. */
	content: z
		.union([z.string(), z.array(z.unknown())])
		.nullish()
		.catch(null),
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

/** The skill name from a `Skill` tool input, or null when absent/malformed. */
function skillNameFrom(
	input: Record<string, unknown> | null | undefined,
): string | null {
	const skill = input?.skill;
	return typeof skill === "string" && skill.length > 0 ? skill : null;
}

/** Size of a tool_result payload: raw length for a string, summed text
 * length for an array of nested blocks (images/other blocks count as 0 —
 * their token cost is not text and would be a misleading char estimate). A
 * non-text element contributes 0 rather than poisoning the whole sum. */
function resultContentChars(
	content: string | unknown[] | null | undefined,
): number {
	if (typeof content === "string") return content.length;
	if (Array.isArray(content)) {
		let sum = 0;
		for (const part of content) {
			if (part && typeof part === "object") {
				const text = (part as { text?: unknown }).text;
				if (typeof text === "string") sum += text.length;
			}
		}
		return sum;
	}
	return 0;
}

/** Strip a UTF-8 BOM — it would otherwise poison the first line. */
function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Iterate lines of a string without materializing an array of all lines
 * (a 30MB transcript split() costs tens of MB of extra peak memory). */
function* iterateLines(text: string): Generator<string> {
	const length = text.length;
	let start = 0;
	while (start < length) {
		let newline = text.indexOf("\n", start);
		if (newline === -1) newline = length;
		let end = newline;
		if (end > start && text.charCodeAt(end - 1) === 0x0d) end--;
		yield text.slice(start, end);
		start = newline + 1;
	}
}

/** Only the four counters are kept per message — the loose-parsed usage
 * object retains every unknown transcript field and would bloat the map. */
interface UsageSums {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
}

/**
 * Line-fed accumulator shared by the sync (string) and streaming (file)
 * parsers. Tolerance contract: never throws on bad input; malformed lines
 * are skipped and counted. Usage is deduplicated by message id because
 * Claude Code writes one JSONL entry per streamed content block, repeating
 * the same `usage` object on every entry of the same API message.
 */
class TranscriptAccumulator {
	private malformedLines = 0;
	private entryCount = 0;
	private toolCalls = 0;
	private lineIndex = 0;
	private sessionId: string | null = null;
	private agentName: string | null = null;
	private agentId: string | null = null;
	private isSidechain = false;
	private lastConversational: Entry | null = null;
	private readonly usageByMessage = new Map<string, UsageSums>();
	private readonly seenToolUseIds = new Set<string>();
	private readonly readCounts = new Map<string, number>();
	/** Per tool_use key → its call footprint; key is the block id, or a
	 * synthetic fallback when the transcript omits one. */
	private readonly toolUses = new Map<
		string,
		{ name: string; skill: string | null; inputChars: number }
	>();
	/** tool_use_id → result size. First write wins: Claude Code can stream the
	 * same result across entries, and one call has exactly one result. */
	private readonly resultChars = new Map<string, number>();

	feedLine(rawLine: string): void {
		const line = this.lineIndex === 0 ? stripBom(rawLine) : rawLine;
		this.lineIndex++;
		if (!line || line.trim() === "") return;

		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			this.malformedLines++;
			return;
		}
		const result = entrySchema.safeParse(raw);
		if (!result.success) {
			this.malformedLines++;
			return;
		}
		const entry = result.data;

		this.sessionId ??= entry.sessionId ?? null;
		this.agentId ??= entry.agentId ?? null;
		this.agentName ??= entry.agentName ?? null;
		if (entry.isSidechain === true) this.isSidechain = true;

		if (!CONVERSATIONAL.has(entry.type)) return;
		this.entryCount++;
		this.lastConversational = entry;

		// User messages carry tool_result blocks — the context cost a tool's
		// output injects. Record their sizes, then they contribute nothing else.
		if (entry.type !== "assistant") {
			const content = entry.message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type !== "tool_result") continue;
					const id = block.tool_use_id;
					if (typeof id !== "string" || this.resultChars.has(id)) continue;
					this.resultChars.set(id, resultContentChars(block.content));
				}
			}
			return;
		}
		const message = entry.message;
		if (message?.usage) {
			const key =
				message.id ?? entry.requestId ?? entry.uuid ?? `line-${this.lineIndex}`;
			this.usageByMessage.set(key, {
				input: message.usage.input_tokens,
				output: message.usage.output_tokens,
				cacheCreation: message.usage.cache_creation_input_tokens,
				cacheRead: message.usage.cache_read_input_tokens,
			});
		}
		if (Array.isArray(message?.content)) {
			for (const block of message.content) {
				if (block.type !== "tool_use") continue;
				if (block.id) {
					if (this.seenToolUseIds.has(block.id)) continue;
					this.seenToolUseIds.add(block.id);
				}
				this.toolCalls++;
				const name = block.name ?? "unknown";
				if (name === "Read") {
					const filePath = block.input?.file_path;
					if (typeof filePath === "string") {
						this.readCounts.set(
							filePath,
							(this.readCounts.get(filePath) ?? 0) + 1,
						);
					}
				}
				// Footprint: a call with no id can't be joined to its result, but
				// its input cost still counts — give it a synthetic key.
				const key = block.id ?? `__noid-${this.toolCalls}`;
				this.toolUses.set(key, {
					name,
					skill: name === "Skill" ? skillNameFrom(block.input) : null,
					inputChars: block.input ? JSON.stringify(block.input).length : 0,
				});
			}
		}
	}

	finish(): ParsedRun {
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheCreation = 0;
		let cacheRead = 0;
		for (const usage of this.usageByMessage.values()) {
			inputTokens += usage.input;
			outputTokens += usage.output;
			cacheCreation += usage.cacheCreation;
			cacheRead += usage.cacheRead;
		}

		let fileRereads = 0;
		for (const count of this.readCounts.values()) {
			if (count >= 2) fileRereads++;
		}

		const toolEvents: RawToolEvent[] = [];
		for (const [key, use] of this.toolUses) {
			toolEvents.push({
				name: use.name,
				skill: use.skill,
				inputChars: use.inputChars,
				resultChars: this.resultChars.get(key) ?? 0,
			});
		}

		// Completion heuristic (see DECISIONS.md): the transcript ends with
		// an assistant message that contains text and is not an API error.
		// Aborted sessions end with a user entry ("[Request interrupted by
		// user]" or a dangling tool_result), failed ones with
		// isApiErrorMessage on the tail.
		const last = this.lastConversational;
		const completed =
			last !== null &&
			last.type === "assistant" &&
			last.isApiErrorMessage !== true &&
			hasTextContent(last);

		return {
			agent: this.agentName ?? "main",
			sessionId: this.sessionId,
			inputTokens,
			outputTokens,
			cacheCreation,
			cacheRead,
			toolCalls: this.toolCalls,
			fileRereads,
			completed,
			entryCount: this.entryCount,
			malformedLines: this.malformedLines,
			isSidechain: this.isSidechain,
			agentId: this.agentId,
			toolEvents,
		};
	}
}

/** Parse one transcript JSONL (already in memory) into run aggregates. */
export function parseTranscript(jsonlText: string): ParsedRun {
	const accumulator = new TranscriptAccumulator();
	for (const line of iterateLines(jsonlText)) {
		accumulator.feedLine(line);
	}
	return accumulator.finish();
}

/**
 * Parse a transcript file streaming line-by-line — peak memory stays
 * O(longest line) instead of O(file), which matters in the Stop hook where
 * transcripts can be tens of MB. Same tolerance contract as
 * `parseTranscript`; the two produce identical results for LF/CRLF input
 * (readline additionally treats a lone \r as a terminator — irrelevant for
 * transcripts Claude Code writes).
 */
export async function parseTranscriptFile(path: string): Promise<ParsedRun> {
	const accumulator = new TranscriptAccumulator();
	const lines = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		accumulator.feedLine(line);
	}
	return accumulator.finish();
}

/**
 * Render a compact, human-readable action trace of a transcript for the
 * distiller's prompt: user/assistant text (truncated) and tool calls with
 * their inputs. Capped to `maxChars` by keeping the head (the task) and the
 * tail (where the session bogged down); buffers are bounded as lines are
 * fed, so memory stays O(maxChars) regardless of transcript size.
 */
export function digestTranscript(jsonlText: string, maxChars = 8000): string {
	const headBudget = Math.floor(maxChars * 0.4);
	const tailBudget = Math.floor(maxChars * 0.55);
	const head: string[] = [];
	const tail: string[] = [];
	let headLength = 0;
	let tailLength = 0;
	let dropped = false;

	const push = (line: string) => {
		if (headLength + line.length + 1 <= headBudget) {
			head.push(line);
			headLength += line.length + 1;
			return;
		}
		tail.push(line);
		tailLength += line.length + 1;
		while (tailLength > tailBudget && tail.length > 1) {
			const evicted = tail.shift() as string;
			tailLength -= evicted.length + 1;
			dropped = true;
		}
	};

	let first = true;
	for (const rawLine of iterateLines(jsonlText)) {
		const line = first ? stripBom(rawLine) : rawLine;
		first = false;
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
			push(`${entry.type.toUpperCase()}: ${truncate(content, 200)}`);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text" && block.text) {
					push(`${entry.type.toUpperCase()}: ${truncate(block.text, 200)}`);
				} else if (block.type === "tool_use") {
					const input = truncate(JSON.stringify(block.input ?? {}), 160);
					push(`TOOL ${block.name ?? "unknown"} ${input}`);
				}
			}
		}
	}

	if (!dropped) return [...head, ...tail].join("\n");
	return [...head, "…[transcript truncated]…", ...tail].join("\n");
}
