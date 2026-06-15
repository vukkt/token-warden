/** Domain agents that ship with the plugin and have golden suites.
 * ('main' — the top-level session — is tracked in `runs` but never has
 * rules: there is no suite to measure them on.) */
export const DOMAIN_AGENTS = ["frontend", "backend", "sql", "testing"] as const;

/**
 * One tool invocation's raw footprint, extracted from the transcript with no
 * interpretation: the chars the model generated to call the tool (output side)
 * and the chars the tool's result injected into context (input side).
 * Classification into builtin/MCP/skill lives in `attribute.ts`.
 */
export interface RawToolEvent {
	/** Tool name exactly as written in the transcript (e.g. "Read",
	 * "mcp__github__create_issue", "Skill"). */
	name: string;
	/** For the `Skill` tool, the invoked skill's name; null otherwise. */
	skill: string | null;
	/** Length of the JSON-serialized tool input the model produced. */
	inputChars: number;
	/** Length of the tool result returned into context; 0 if none was found. */
	resultChars: number;
}

/** Aggregates extracted from one transcript JSONL by `parseTranscript`. */
export interface ParsedRun {
	/** Agent name if the transcript carries one; subagent transcripts only
	 * carry an opaque `agentId`, so this defaults to "main" and callers
	 * attribute via hook payload or bench flags. */
	agent: string;
	sessionId: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheCreation: number;
	cacheRead: number;
	/** Distinct tool_use blocks across all assistant messages. */
	toolCalls: number;
	/** Distinct files passed to the Read tool two or more times. */
	fileRereads: number;
	/** True when the transcript ends with a non-error assistant text message. */
	completed: boolean;
	/** Valid conversational (user/assistant) entries parsed. */
	entryCount: number;
	/** Lines skipped because they were not valid JSON or failed validation. */
	malformedLines: number;
	/** True when any entry is marked as a subagent sidechain. */
	isSidechain: boolean;
	/** Opaque subagent id from the transcript, when present. */
	agentId: string | null;
	/** Per-call tool footprints, one entry per distinct tool_use, in
	 * first-seen order. The raw material for cost attribution. */
	toolEvents: RawToolEvent[];
}
