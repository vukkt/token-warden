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
import {
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	candidateCounts,
	defaultDbPath,
	lastMeasurementTs,
	openDb,
	type WardenDb,
} from "./db.js";
import { appendLogLine } from "./logfile.js";
import { isValidAgentName, knownAgents } from "./registry.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimum gap between auto-spawned selector runs. */
const AUTO_SELECT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Diagnostics for a hook that is otherwise silent by design. Best-effort:
 * a failure to log must never become a failure to start a session. */
function logLine(message: string): void {
	appendLogLine("notify.log", message);
}

/** Marker recording that an auto-select burn was ATTEMPTED, next to the DB. */
export function autoSelectMarkerPath(): string {
	return join(dirname(defaultDbPath()), "auto-select.attempt");
}

/**
 * Claim the exclusive right to spawn one auto-select burn, returning true only
 * for the process that wins.
 *
 * Why a marker and not just the cooldown query: `planAutoSelect` reads
 * `lastMeasurementTs`, which is the RESIDUE of a burn — it appears only once
 * the first golden run finishes, minutes after the detached selector starts.
 * Two sessions opening at the same moment (two projects, or a script starting
 * several) both read the same stale timestamp, both pass the cooldown, and
 * both spend a full benchmark burn on the same agent while their
 * `compileActiveMemory` calls race on one file. This records the ATTEMPT
 * instead, synchronously and before the spawn, so the second session sees it.
 *
 * `wx` is the whole mechanism: O_CREAT|O_EXCL is atomic, so exactly one of any
 * number of racing processes creates the file. An existing marker inside the
 * cooldown window means "someone already burned or is burning" and we stand
 * down; past the window it is deleted and re-claimed. Deliberately NOT a
 * PID-liveness lock: if a selector crashed, the right behaviour is still to
 * wait out the cooldown rather than immediately re-burn, so time-based expiry
 * IS the desired semantics and a stale-PID takeover would defeat it.
 */
export function claimAutoSelect(nowMs: number = Date.now()): boolean {
	const path = autoSelectMarkerPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		return false;
	}
	// At most two passes: create, and (if an expired marker was in the way)
	// create again after removing it. The second failure means another process
	// won the race, which is exactly the outcome this exists to produce.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(
				path,
				`${new Date(nowMs).toISOString()} pid=${process.pid}\n`,
				{ flag: "wx" },
			);
			return true;
		} catch {
			let ageMs: number;
			try {
				ageMs = nowMs - statSync(path).mtimeMs;
			} catch {
				return false;
			}
			if (ageMs < AUTO_SELECT_COOLDOWN_MS) return false;
			try {
				rmSync(path, { force: true });
			} catch {
				return false;
			}
		}
	}
	return false;
}

export function buildNudge(
	allCounts: { agent: string; pending: number }[],
): string | null {
	// Only domain agents can be measured by /warden-select; anything else
	// would nudge the user toward a command that errors. knownAgents() scans a
	// directory, so it is read once, not once per row.
	const agents = knownAgents();
	const counts = allCounts.filter((c) => agents.includes(c.agent));
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
	// Same one-scan-per-call rule as buildNudge; this filter is also the guard
	// that keeps an arbitrary DB-derived string out of the spawned selector's
	// argv (spawnAutoSelect passes `agent` as an argument).
	const agents = knownAgents();
	const counts = allCounts
		.filter((c) => agents.includes(c.agent))
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
	// Defence in depth: callers already filter through knownAgents(), but this
	// value ends up in an argv, so a name that could be read as a flag or a
	// path never gets there. spawn() is shell-less, so this is the only
	// injection surface.
	if (!isValidAgentName(agent)) return;
	const child = spawn(
		"npx",
		["tsx", join(pluginRoot, "src", "select.ts"), "--agent", agent],
		{
			cwd: pluginRoot,
			detached: true,
			stdio: "ignore",
		},
	);
	// A spawn failure (npx missing, ENOMEM) arrives as an async 'error' event,
	// and an EventEmitter with no 'error' listener THROWS it — which would
	// crash SessionStart instead of skipping the burn. Today process.exit(0)
	// usually wins the race; that is luck, not a design. Swallow it: the
	// auto-selector is best-effort by construction.
	child.on("error", (err: Error) => {
		logLine(`auto-select spawn failed for ${agent}: ${err.message}`);
	});
	child.unref();
}

/**
 * The SessionStart hook body: returns the hook JSON to print (or null for
 * silence) and spawns the auto-selector when the opt-in plan says to.
 * `spawner` and `claim` are injectable so tests never fork a real benchmark
 * and never touch the real marker file.
 */
export function sessionStart(
	db: WardenDb,
	env: NodeJS.ProcessEnv = process.env,
	nowMs: number = Date.now(),
	spawner: (agent: string) => void = spawnAutoSelect,
	claim: (nowMs: number) => boolean = claimAutoSelect,
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
	// The plan says a burn is due; the claim decides whether THIS session is
	// the one that spends it. Both must agree, and the claim is taken before
	// the spawn so a concurrent session cannot slip through behind it.
	if (plan.agent !== null && claim(nowMs)) {
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

/**
 * Register the process-level fail-open net: exit 0 on an asynchronous failure
 * nobody owns. `try/catch` around the hook body only covers what the body
 * awaits — a rejected promise with no awaiter, or an 'error' event on
 * process.stdin, reaches the process instead, and Node 22 terminates non-zero
 * on an unhandled rejection by default. SessionStart must never fail that way.
 * Exported (and outside the entry shim) so the behaviour is testable.
 */
export function installFailOpenHandlers(
	log: (message: string) => void = logLine,
	exit: (code: number) => void = process.exit,
): void {
	const bailOut = (kind: string) => (err: unknown) => {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		log(`notify ${kind} (failing open): ${detail}`);
		exit(0);
	};
	process.on("uncaughtException", bailOut("uncaught exception"));
	process.on("unhandledRejection", bailOut("unhandled rejection"));
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	installFailOpenHandlers();
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
