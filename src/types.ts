/** Domain agents that ship with the plugin and have golden suites.
 * ('main' — the top-level session — is tracked in `runs` but never has
 * rules: there is no suite to measure them on.) */
export const DOMAIN_AGENTS = ["frontend", "backend", "sql", "testing"] as const;

/* ------------------------------------------------------------------ *
 * Nominal (branded) identifiers.
 *
 * Every one of these is TYPE-ONLY: `declare const` and `type` emit no
 * JavaScript, so adopting them costs nothing at runtime and nothing in
 * coverage. They exist because this codebase passes a lot of bare `string`
 * and bare `number` through long call chains where a swap is silent and
 * expensive — an agent name where a task id belongs, a token count where a
 * dollar amount belongs (the keep/evict gate is in TOKENS; dollars are only
 * a reporting lens, and conflating the two would corrupt the gate).
 *
 * A branded value is still assignable TO its base type (a `TaskId` can be
 * printed or joined as a `string`), so adoption is one-directional and
 * incremental: brand a field, and the compiler then reports every site that
 * feeds it the wrong kind of scalar. Minting one is an explicit
 * `x as TaskId` — deliberately visible at the parse/DB boundary where the
 * value is validated.
 * ------------------------------------------------------------------ */

declare const BRAND: unique symbol;

/** Attach a compile-time-only nominal tag to a structural type.
 * @public Vocabulary for the in-progress brand adoption; see ROADMAP. */
export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** A known agent (see `registry.ts#knownAgents`), never a task or rule id.
 * @public */
export type AgentName = Brand<string, "AgentName">;

/** A golden task's `id` — also used as `runs.task_hash` and as a temp-dir
 * path segment, hence validated at the parse chokepoint.
 * @public */
export type TaskId = Brand<string, "TaskId">;

/** A `rules` row primary key. Never interchangeable with a run id or a
 * ruleset version. */
export type RuleId = Brand<number, "RuleId">;

/** A monotonically bumped `rulesets` version, not a rule id.
 * @public */
export type RulesetVersion = Brand<number, "RulesetVersion">;

/** A count of tokens. The keep/evict verdict is denominated in these.
 * @public */
export type TokenCount = Brand<number, "TokenCount">;

/** A dollar amount derived from a `TokenCount` via `pricing.ts`. Advisory
 * lens only — it must never reach a gate that expects a `TokenCount`.
 * @public */
export type UsdAmount = Brand<number, "UsdAmount">;

/* ------------------------------------------------------------------ *
 * A/B comparison vocabulary.
 * ------------------------------------------------------------------ */

/** Which side of an A/B a measurement pass belongs to. The two arms of a
 * comparison must differ in exactly one variable; naming the arm as a closed
 * union (rather than a free-form label string) keeps "which side is this?"
 * decidable instead of inferred from a label prefix.
 * @public */
export type ArmRole = "baseline" | "candidate";

/** The dimension an A/B varies. Exactly one of these may differ between the
 * two arms of a comparison; everything else (rules, model, prompt, suite,
 * fixture, environment) is held constant by the caller.
 * @public */
export type AbDimension = "model" | "prompt";

/**
 * The verdict of an A/B, as a discriminated union rather than the
 * `regression` / `environmentFailure` / `uncertain` boolean triple that
 * `compare.ts#Comparison` currently carries. Those three booleans make eight
 * states representable when only six are legal (a regression that is also an
 * environment failure is nonsense), and every consumer has to re-derive the
 * precedence cascade by hand — `verdictLine` and `formatCategoryRegressions`
 * each encode it separately today.
 *
 * Provided here as the shared target shape; adopting it inside `Comparison`
 * is a cross-module change (see the report from this module's owner).
 * @public
 */
export type AbOutcome =
	/** Candidate failed a task the baseline completed — unsafe regardless of
	 * tokens. Outranks every token-based reading. */
	| {
			readonly kind: "regression";
			readonly regressedTaskIds: readonly string[];
	  }
	/** Candidate runs died with ~0 tokens (quota/API death). The measurement
	 * says nothing; no verdict may be drawn. */
	| { readonly kind: "environment-failure" }
	/** Fewer than two tasks completed on both sides — indicative only. */
	| { readonly kind: "insufficient-data"; readonly comparableTasks: number }
	/** |delta| < standard error: indistinguishable from zero. */
	| {
			readonly kind: "within-noise";
			readonly delta: number;
			readonly standardError: number;
	  }
	/** Candidate measurably cheaper (delta > 0) or dearer (delta < 0). */
	| {
			readonly kind: "cheaper";
			readonly delta: number;
			readonly standardError: number;
	  }
	| {
			readonly kind: "more-expensive";
			readonly delta: number;
			readonly standardError: number;
	  };

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
