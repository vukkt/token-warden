/**
 * Dogfood-window diagnostic: is the production loop actually running, and if
 * not, what is the single next thing to do about it?
 *
 * CLI: npx tsx src/dogfood.ts [--stale-after <days>] [--json]
 *
 * ROADMAP section 1 asks for a sustained window of day-to-day work fed through
 * the full loop. That window has a silent failure mode, and the ledger has been
 * sitting in it: sessions ARE recorded for every agent, but distillation only
 * ever fires for an agent in `knownAgents()` (collect.ts). A session recorded
 * under 'main' — or under an ad-hoc subagent type like 'Explore' — is INERT: it
 * costs the user tokens, lands in the ledger, contributes to cost attribution,
 * and can never produce a candidate rule. Nothing surfaced that, so a window
 * that never started looked exactly like a window that was running.
 *
 * This report answers, from the ledger and the environment only:
 *   1. is collection live right now (and is anything switched off)?
 *   2. how many real-work sessions exist, per agent, over what date range?
 *   3. which of those agents can trigger distillation, and which are inert?
 *   4. how many more sessions before a candidate can be distilled?
 *   5. what is the single next action?
 *
 * The readiness numbers are taken from the distiller's OWN constants and
 * predicate (`MIN_PRIOR_RUNS`, `ROLLING_WINDOW`, `p75`, `shouldDistill`), not
 * from a second copy that could drift out of agreement with the gate — and the
 * reported threshold is re-checked against the live `shouldDistill` before it
 * is printed.
 *
 * INVARIANT — read-only, structurally. The only db.js imports are `withDb`,
 * `realWorkByAgent`, `recentRealWorkTotals` and `candidateCounts`, all SELECTs;
 * there is no code path from this report to a rule, a run or a memory file.
 * `test/dogfood.test.ts` asserts the import list against the source text so a
 * future mutating import fails the suite instead of quietly widening it.
 *
 * SECURITY — agent names come from transcripts (an `agentName` field the model
 * writes) and project paths come from the environment; both are rendered
 * through `displayText`, so collected data can never forge a report line.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";
import {
	candidateCounts,
	realWorkByAgent,
	recentRealWorkTotals,
	type WardenDb,
	withDb,
} from "./db.js";
import {
	MIN_PRIOR_RUNS,
	p75,
	ROLLING_WINDOW,
	shouldDistill,
} from "./distill.js";
import { formatNumber as fmt } from "./format.js";
import { knownAgents } from "./registry.js";
import { displayText } from "./sanitize.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** A session this recent means the Stop hook ran today: collection is live. */
const LIVE_WITHIN_HOURS = 24;
/** Beyond this, collection is not merely quiet — treat it as stopped. */
const DEFAULT_STALE_AFTER_DAYS = 7;

/** Sentinel for "exclude no run" in `recentRealWorkTotals`: row ids are
 * positive, so this leaves the population exactly as the next session's
 * `shouldDistill` call will see it. */
const EXCLUDE_NOTHING = -1;

export type Liveness = "live" | "idle" | "stopped" | "never";

/**
 * Is collection running? Freshness of the newest real-work row is the only
 * honest signal available without spending tokens — the hook writes no
 * heartbeat, and collect.log is append-on-exception, so its mtime proves
 * nothing about the successful path.
 */
export function assessLiveness(
	lastTs: string | null,
	nowMs: number,
	staleAfterDays: number = DEFAULT_STALE_AFTER_DAYS,
): Liveness {
	if (lastTs === null) return "never";
	const t = Date.parse(lastTs);
	if (Number.isNaN(t)) return "never";
	const ageMs = nowMs - t;
	if (ageMs <= LIVE_WITHIN_HOURS * MS_PER_HOUR) return "live";
	if (ageMs <= staleAfterDays * MS_PER_DAY) return "idle";
	return "stopped";
}

/** One agent's real-work footprint and its distance from a distillation. */
export interface AgentDogfood {
	agent: string;
	/** In `knownAgents()` — i.e. distillation can fire for it at all. */
	known: boolean;
	sessions: number;
	completed: number;
	tokens: number;
	firstTs: string | null;
	lastTs: string | null;
	/** Completed sessions still needed before the p75 trigger can fire. */
	runsNeeded: number;
	/** Tokens the next session must exceed to distil; null while under-armed. */
	threshold: number | null;
	/** The reported threshold re-checked against the live predicate. */
	verifiedTrigger: boolean;
	/** Candidate rules already queued, awaiting a `/warden-select` verdict. */
	candidates: number;
}

export interface DogfoodData {
	liveness: Liveness;
	lastRealWorkTs: string | null;
	ageDays: number | null;
	staleAfterDays: number;
	/** TOKEN_WARDEN_NO_COLLECT=1 — nothing is being recorded at all. */
	collectDisabled: boolean;
	/** TOKEN_WARDEN_NO_DISTILL=1 — sessions record, candidates never distil. */
	distillDisabled: boolean;
	/** The marker the SubagentStop and SessionStart hooks require to do
	 * anything (the Stop hook creates it by installing deps). */
	depsInstalled: boolean;
	agents: AgentDogfood[];
	/** Completed real-work sessions on agents that CAN distil. */
	distillableSessions: number;
	/** Completed real-work sessions on agents that never can. */
	inertSessions: number;
}

export interface DogfoodOptions {
	nowMs?: number;
	staleAfterDays?: number;
	env?: Record<string, string | undefined>;
	/** Overridable so a test never depends on the checkout's node_modules. */
	depsMarkerPath?: string;
}

/** The marker file the non-self-healing hooks gate on. */
export function depsMarkerPath(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"node_modules",
		".warden-deps-ok",
	);
}

/** Readiness for one agent, using the distiller's own population and trigger. */
function agentReadiness(
	db: WardenDb,
	agent: string,
	known: boolean,
	candidates: number,
): Pick<
	AgentDogfood,
	"runsNeeded" | "threshold" | "verifiedTrigger" | "candidates"
> {
	// An unknown agent is gated out of distillation before the trigger is ever
	// consulted, so quoting a threshold for it would imply a readiness it can
	// never reach whatever the user does.
	if (!known) {
		return {
			runsNeeded: 0,
			threshold: null,
			verifiedTrigger: false,
			candidates,
		};
	}
	const priors = recentRealWorkTotals(
		db,
		agent,
		ROLLING_WINDOW,
		EXCLUDE_NOTHING,
	);
	if (priors.length < MIN_PRIOR_RUNS) {
		return {
			runsNeeded: MIN_PRIOR_RUNS - priors.length,
			threshold: null,
			verifiedTrigger: false,
			candidates,
		};
	}
	const threshold = p75(priors);
	// Do not TELL the user a number the gate does not agree with: run the real
	// predicate at one token above the reported threshold and report whether it
	// actually flips. (The project's standing lesson — verify by executing, not
	// by reading the source of the thing you are describing.)
	const verifiedTrigger = shouldDistill(
		db,
		agent,
		EXCLUDE_NOTHING,
		threshold + 1,
	);
	return { runsNeeded: 0, threshold, verifiedTrigger, candidates };
}

/** Read every figure the report needs. SELECT-only: see the module invariant. */
export function gatherDogfood(
	db: WardenDb,
	options: DogfoodOptions = {},
): DogfoodData {
	const nowMs = options.nowMs ?? Date.now();
	const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
	const env = options.env ?? process.env;
	const known = new Set(knownAgents());
	const recorded = realWorkByAgent(db);
	// One grouped query for the whole ledger rather than one per agent.
	const pending = new Map(
		candidateCounts(db).map((row) => [row.agent, row.pending]),
	);

	const agents: AgentDogfood[] = recorded.map((row) => ({
		agent: row.agent,
		known: known.has(row.agent),
		sessions: row.sessions,
		completed: row.completed,
		tokens: row.tokens,
		firstTs: row.firstTs,
		lastTs: row.lastTs,
		...agentReadiness(
			db,
			row.agent,
			known.has(row.agent),
			pending.get(row.agent) ?? 0,
		),
	}));
	// Known agents with no real-work rows at all are the ones the window most
	// needs, so they must appear as zero rows rather than be absent.
	for (const agent of knownAgents()) {
		if (recorded.some((row) => row.agent === agent)) continue;
		agents.push({
			agent,
			known: true,
			sessions: 0,
			completed: 0,
			tokens: 0,
			firstTs: null,
			lastTs: null,
			...agentReadiness(db, agent, true, pending.get(agent) ?? 0),
		});
	}

	const lastRealWorkTs = recorded.reduce<string | null>(
		(newest, row) =>
			newest === null || row.lastTs > newest ? row.lastTs : newest,
		null,
	);
	const parsedLast =
		lastRealWorkTs === null ? Number.NaN : Date.parse(lastRealWorkTs);
	return {
		liveness: assessLiveness(lastRealWorkTs, nowMs, staleAfterDays),
		lastRealWorkTs,
		ageDays: Number.isNaN(parsedLast)
			? null
			: (nowMs - parsedLast) / MS_PER_DAY,
		staleAfterDays,
		collectDisabled: env.TOKEN_WARDEN_NO_COLLECT === "1",
		distillDisabled: env.TOKEN_WARDEN_NO_DISTILL === "1",
		depsInstalled: existsSync(options.depsMarkerPath ?? depsMarkerPath()),
		agents,
		distillableSessions: agents
			.filter((a) => a.known)
			.reduce((sum, a) => sum + a.completed, 0),
		inertSessions: agents
			.filter((a) => !a.known)
			.reduce((sum, a) => sum + a.completed, 0),
	};
}

export type NextActionId =
	| "collection-disabled"
	| "distillation-disabled"
	| "never-collected"
	| "collection-stopped"
	| "inert-only"
	| "need-more-runs"
	| "measure-candidates"
	| "armed";

export interface NextAction {
	id: NextActionId;
	text: string;
}

/**
 * The one thing to do next, in strict precedence order. Deliberately ONE
 * action: a diagnostic that lists eight possible next steps is the same as one
 * that lists none, and the window has already spent two months not starting.
 */
export function nextAction(data: DogfoodData): NextAction {
	if (data.collectDisabled) {
		return {
			id: "collection-disabled",
			text: "TOKEN_WARDEN_NO_COLLECT=1 is set — no session is being recorded at all. Unset it (it exists for benchmark children, not for interactive use).",
		};
	}
	if (data.distillDisabled) {
		return {
			id: "distillation-disabled",
			text: "TOKEN_WARDEN_NO_DISTILL=1 is set — sessions are recorded but no candidate can ever be distilled. Unset it.",
		};
	}
	if (data.liveness === "never") {
		return {
			id: "never-collected",
			text: "No real-work session has ever been recorded. Check the plugin is installed and enabled in this Claude Code install — its Stop hook is the only thing that writes a session row — then run /warden-dogfood again after one session.",
		};
	}
	if (data.liveness === "stopped") {
		const days = Math.floor(data.ageDays ?? 0);
		const deps = data.depsInstalled
			? ""
			: " The hook dependency marker (node_modules/.warden-deps-ok) is missing, which is consistent with the plugin no longer being installed.";
		return {
			id: "collection-stopped",
			text: `Collection has recorded nothing for ${days} day(s) — the window is not running. Re-install/enable the plugin and confirm the Stop hook fires (one new row appears here after one session).${deps}`,
		};
	}
	if (data.distillableSessions === 0 && data.inertSessions > 0) {
		return {
			id: "inert-only",
			text: `Every recorded session (${data.inertSessions}) is on an INERT agent, so none of them can ever distil a rule. Route the work you want measured through a domain subagent (${knownAgents().join(", ")}), or register your own agent + golden suite via TOKEN_WARDEN_AGENTS_DIR / TOKEN_WARDEN_BENCHMARKS_DIR (/warden-sample-tasks drafts tasks from real transcripts).`,
		};
	}
	const needy = data.agents
		.filter((a) => a.known && a.completed > 0 && a.runsNeeded > 0)
		.sort((a, b) => a.runsNeeded - b.runsNeeded)[0];
	if (needy) {
		return {
			id: "need-more-runs",
			text: `Run ${needy.runsNeeded} more completed ${displayText(needy.agent, 40)} session(s): the distiller needs ${MIN_PRIOR_RUNS} priors before its p75 trigger means anything.`,
		};
	}
	const pending = data.agents.find((a) => a.known && a.candidates > 0);
	if (pending) {
		return {
			id: "measure-candidates",
			text: `Run /warden-select --agent ${displayText(pending.agent, 40)} to measure ${pending.candidates} queued candidate(s) — a distilled rule is only evidence once the fixture has ruled on it.`,
		};
	}
	const armed = data.agents.find((a) => a.known && a.threshold !== null);
	if (armed) {
		return {
			id: "armed",
			text: `Nothing to do — ${displayText(armed.agent, 40)} is armed: the next session above ~${fmt(armed.threshold ?? 0)} tokens distils a candidate. Keep working.`,
		};
	}
	return {
		id: "inert-only",
		text: `No known agent has recorded a session yet. Route work through a domain subagent (${knownAgents().join(", ")}) so it can be distilled from.`,
	};
}

const LIVENESS_TEXT: Record<Liveness, string> = {
	live: "LIVE",
	idle: "IDLE",
	stopped: "STOPPED",
	never: "NEVER-RECORDED",
};

/** "2026-06-12" from an ISO timestamp; "-" when absent. The date is sliced
 * BEFORE sanitising: `displayText(ts, 10)` would spend one of those characters
 * on its truncation ellipsis and print "2026-06-1…". */
function day(ts: string | null): string {
	return ts === null ? "-" : displayText(ts.slice(0, 10), 20);
}

function collectionLine(data: DogfoodData): string {
	const age =
		data.ageDays === null
			? "never"
			: `${Math.floor(data.ageDays)} day(s) ago (${day(data.lastRealWorkTs)})`;
	return `Collection: ${LIVENESS_TEXT[data.liveness]} — last real-work session ${age}.`;
}

function agentRows(data: DogfoodData): string[] {
	return [
		"agent      | distill? | sessions (completed) | tokens     | first -> last",
		"-----------|----------|----------------------|------------|----------------------",
		...data.agents.map((a) => {
			const name = displayText(a.agent, 12).padEnd(10);
			const status = (a.known ? "yes" : "INERT").padEnd(8);
			const counts = `${a.sessions} (${a.completed})`.padEnd(20);
			return `${name} | ${status} | ${counts} | ${fmt(a.tokens).padStart(10)} | ${day(a.firstTs)} -> ${day(a.lastTs)}`;
		}),
	];
}

function readinessRows(data: DogfoodData): string[] {
	return data.agents
		.filter((a) => a.known)
		.map((a) => {
			const parts: string[] = [];
			if (a.threshold === null) {
				parts.push(
					`${a.runsNeeded} more completed session(s) needed (has ${a.completed} of ${MIN_PRIOR_RUNS} priors)`,
				);
			} else {
				parts.push(
					`armed: next session above ~${fmt(a.threshold)} tok distils${a.verifiedTrigger ? "" : " (WARNING: the live trigger disagrees with this threshold)"}`,
				);
			}
			parts.push(`${a.candidates} candidate(s) queued`);
			return `  ${displayText(a.agent, 40)}: ${parts.join("; ")}`;
		});
}

/** Render the whole report from gathered data. Pure — no DB, no clock. */
export function formatDogfood(data: DogfoodData): string {
	const action = nextAction(data);
	const readiness = readinessRows(data);
	return [
		"token-warden dogfood window",
		"",
		collectionLine(data),
		`  hook dependencies: ${data.depsInstalled ? "OK: node_modules/.warden-deps-ok present" : "WARNING: node_modules/.warden-deps-ok missing — the SubagentStop and SessionStart hooks are no-ops until a Stop hook installs deps"}`,
		`  TOKEN_WARDEN_NO_COLLECT: ${data.collectDisabled ? "1 (!) collection is OFF" : "unset"}`,
		`  TOKEN_WARDEN_NO_DISTILL: ${data.distillDisabled ? "1 (!) distillation is OFF" : "unset"}`,
		"",
		"Real-work sessions by agent (task_hash IS NULL):",
		...agentRows(data),
		"  INERT = not in knownAgents(): recorded and billed, but distillation is",
		"  gated on membership, so these sessions can NEVER produce a candidate rule.",
		"",
		"Distillation readiness (known agents only):",
		...(readiness.length > 0 ? readiness : ["  no known agents configured"]),
		"",
		`Window progress: ${data.distillableSessions} distillable session(s), ${data.inertSessions} inert session(s).`,
		"",
		`NEXT (${action.id}): ${action.text}`,
	].join("\n");
}

export function renderDogfood(
	db: WardenDb,
	options: DogfoodOptions = {},
): string {
	return formatDogfood(gatherDogfood(db, options));
}

interface DogfoodArgs {
	staleAfterDays: number;
	json: boolean;
}

export function parseDogfoodArgs(argv: string[]): DogfoodArgs {
	const args: DogfoodArgs = {
		staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--stale-after") {
			const n = Number(argv[++i]);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error("--stale-after must be a positive number of days");
			}
			args.staleAfterDays = n;
		} else if (flag === "--json") args.json = true;
		else throw new Error(`unknown flag: ${flag}`);
	}
	return args;
}

export function main(argv: string[], nowMs = Date.now()): number {
	const args = parseDogfoodArgs(argv);
	return withDb((db) => {
		const data = gatherDogfood(db, {
			nowMs,
			staleAfterDays: args.staleAfterDays,
		});
		console.log(
			args.json
				? JSON.stringify({ ...data, nextAction: nextAction(data) }, null, 2)
				: formatDogfood(data),
		);
		return 0;
	});
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	return main(process.argv.slice(2));
});
/* v8 ignore stop */
