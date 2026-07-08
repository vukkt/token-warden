/**
 * SessionStart nudge: when candidate rules are waiting to be measured,
 * inject one short context line so the session knows selection is due.
 *
 * By default it does NOT run the selector itself — selection spends real
 * benchmark tokens and stays a user decision. TOKEN_WARDEN_AUTO_SELECT=1
 * opts in to scheduled selection: the hook spawns the selector detached for
 * the agent with the most pending candidates, at most once per 24h (any
 * candidate/audit run inside the window suppresses it, so repeated session
 * starts can never burn benchmarks back to back). Fails silent (exit 0, no
 * output) on any error or when there is nothing to report; it must add zero
 * friction to session startup.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	candidateCounts,
	defaultDbPath,
	lastMeasurementTs,
	openDb,
	type WardenDb,
} from "./db.js";
import { knownAgents } from "./registry.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimum gap between auto-spawned selector runs. */
const AUTO_SELECT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function buildNudge(
	allCounts: { agent: string; pending: number }[],
): string | null {
	// Only domain agents can be measured by /warden-select; anything else
	// would nudge the user toward a command that errors.
	const counts = allCounts.filter((c) => knownAgents().includes(c.agent));
	if (counts.length === 0) return null;
	const total = counts.reduce((sum, c) => sum + c.pending, 0);
	const perAgent = counts.map((c) => `${c.agent}: ${c.pending}`).join(", ");
	return (
		`token-warden: ${total} candidate rule(s) pending measurement (${perAgent}). ` +
		`When convenient, run /token-warden:warden-select <agent> (spends benchmark tokens) to measure and compile them.`
	);
}

export interface AutoSelectPlan {
	/** Agent to auto-select, or null with the reason it was skipped. */
	agent: string | null;
	reason: string;
}

/** Decide whether this session start should spawn the selector. Pure. */
export function planAutoSelect(
	enabled: boolean,
	allCounts: { agent: string; pending: number }[],
	lastMeasurement: string | null,
	nowMs: number,
): AutoSelectPlan {
	if (!enabled) {
		return { agent: null, reason: "TOKEN_WARDEN_AUTO_SELECT is not set" };
	}
	const counts = allCounts
		.filter((c) => knownAgents().includes(c.agent))
		.sort((a, b) => b.pending - a.pending);
	const top = counts[0];
	if (!top) return { agent: null, reason: "no pending candidates" };
	if (lastMeasurement !== null) {
		const last = Date.parse(lastMeasurement);
		if (!Number.isNaN(last) && nowMs - last < AUTO_SELECT_COOLDOWN_MS) {
			return {
				agent: null,
				reason: "selector already measured within the last 24h (cooldown)",
			};
		}
	}
	return {
		agent: top.agent,
		reason: `${top.pending} pending candidate(s), no measurement in 24h`,
	};
}

/** Detached fire-and-forget selector spawn — the distill-spawn pattern:
 * SessionStart must return immediately, the benchmark runs on its own. */
export function spawnAutoSelect(agent: string): void {
	spawn(
		"npx",
		["tsx", join(pluginRoot, "src", "select.ts"), "--agent", agent],
		{
			cwd: pluginRoot,
			detached: true,
			stdio: "ignore",
		},
	).unref();
}

/**
 * The SessionStart hook body: returns the hook JSON to print (or null for
 * silence) and spawns the auto-selector when the opt-in plan says to.
 * `spawner` is injectable so tests never fork a real benchmark.
 */
export function sessionStart(
	db: WardenDb,
	env: NodeJS.ProcessEnv = process.env,
	nowMs: number = Date.now(),
	spawner: (agent: string) => void = spawnAutoSelect,
): string | null {
	const counts = candidateCounts(db);
	const parts: string[] = [];
	const nudge = buildNudge(counts);
	if (nudge !== null) parts.push(nudge);

	const plan = planAutoSelect(
		env.TOKEN_WARDEN_AUTO_SELECT === "1",
		counts,
		lastMeasurementTs(db),
		nowMs,
	);
	if (plan.agent !== null) {
		spawner(plan.agent);
		parts.push(
			`token-warden: auto-select started in the background for ${plan.agent} (${plan.reason}; opt-in via TOKEN_WARDEN_AUTO_SELECT=1).`,
		);
	}

	if (parts.length === 0) return null;
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: parts.join(" "),
		},
	});
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		if (existsSync(defaultDbPath())) {
			const db = openDb();
			try {
				const output = sessionStart(db);
				if (output !== null) console.log(output);
			} finally {
				db.close();
			}
		}
	} catch {
		// Session startup must never be disturbed.
	}
	process.exit(0);
}
/* v8 ignore stop */
