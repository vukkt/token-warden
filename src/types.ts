/** Agents tracked by the warden. 'main' is the top-level (non-subagent) session. */
export type AgentName = "frontend" | "backend" | "sql" | "testing" | "main";

/** Domain agents that ship with the plugin and have golden suites. */
export const DOMAIN_AGENTS = ["frontend", "backend", "sql", "testing"] as const;

/** Lifecycle of a rule in the ledger. Candidates live only in SQLite and are
 * never injected into agent memory until measured (design invariant #1). */
export type RuleStatus = "candidate" | "active" | "evicted";
