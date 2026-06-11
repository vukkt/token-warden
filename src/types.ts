/** Agents tracked by the warden. 'main' is the top-level (non-subagent) session. */
export type AgentName = "frontend" | "backend" | "sql" | "testing" | "main";

/** Domain agents that ship with the plugin and have golden suites. */
export const DOMAIN_AGENTS = ["frontend", "backend", "sql", "testing"] as const;

/** Lifecycle of a rule in the ledger. Candidates live only in SQLite and are
 * never injected into agent memory until measured (design invariant #1). */
export type RuleStatus = "candidate" | "active" | "evicted";

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
}
