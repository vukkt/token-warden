/**
 * The one way this project appends to a log file next to the ledger.
 *
 * Five modules had grown their own `logLine` — `gate`, `collect`, `distill`,
 * `evolve`, `notify` — and the copies had diverged on the two things that
 * matter rather than on anything cosmetic:
 *
 * - **Rotation.** Only `gate.ts` capped its file. The other four grew without
 *   bound in the user's `~/.token-warden` directory, and `collect.log` is the
 *   highest-frequency writer of the five: it takes a line on every session,
 *   whether or not anything interesting happened.
 * - **Sanitizing.** `collect`, `distill` and `evolve` flattened the line
 *   through `displayText`; `gate` and `notify` did not. Every one of these logs
 *   interpolates untrusted text — session ids, paths, transcript-supplied agent
 *   names, error strings from other code, model output. A newline in any of
 *   them forges a second timestamped entry, which was PROVEN exploitable
 *   against `distill.log` before that copy was fixed.
 *
 * Both properties now hold everywhere by construction, which is the point: the
 * contract was documented and honoured unevenly for months, and a rule that
 * depends on five authors remembering it is a rule that drifts.
 *
 * Fail-open, always. Four of the five callers run inside Claude Code hooks; a
 * log write must never be the reason a user's session breaks. Every failure
 * path here is swallowed deliberately.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultDbPath } from "./db.js";
import { displayText } from "./sanitize.js";

/**
 * Rotate past this size, keeping one previous generation.
 *
 * 1 MiB is roughly 10k lines at these widths — enough that a user debugging
 * yesterday's session still has it, small enough that an unattended install
 * cannot quietly consume a disk. One generation rather than a numbered series
 * because these are breadcrumbs, not an audit trail: the ledger is the audit
 * trail, and it is a database.
 */
export const LOG_MAX_BYTES = 1024 * 1024;

/** Default clamp for one line. Callers handling model output pass more. */
const DEFAULT_LINE_CHARS = 1000;

/**
 * Append one timestamped, sanitized line to `<ledger dir>/<name>`, rotating
 * first if the file has grown past `LOG_MAX_BYTES`.
 *
 * The `statSync` costs one syscall and is safe even in the Stop hook's sub-2s
 * budget — `collect.ts` already stats the transcript on the same path.
 */
export function appendLogLine(
	name: string,
	message: string,
	maxChars: number = DEFAULT_LINE_CHARS,
): void {
	try {
		const logPath = join(dirname(defaultDbPath()), name);
		mkdirSync(dirname(logPath), { recursive: true });
		try {
			if (statSync(logPath).size > LOG_MAX_BYTES) {
				renameSync(logPath, `${logPath}.1`);
			}
		} catch {
			// No log yet, or another hook rotated it first. Either way: append.
		}
		appendFileSync(
			logPath,
			`${new Date().toISOString()} ${displayText(message, maxChars)}\n`,
		);
	} catch {
		// Logging must never take its caller down.
	}
}
