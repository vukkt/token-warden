/**
 * SessionStart nudge: when candidate rules are waiting to be measured,
 * inject one short context line so the session knows selection is due.
 *
 * Deliberately does NOT run the selector itself — selection spends real
 * benchmark tokens and stays a user decision. Fails silent (exit 0, no
 * output) on any error or when there is nothing to report; it must add
 * zero friction to session startup.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { candidateCounts, defaultDbPath, openDb } from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

export function buildNudge(
	allCounts: { agent: string; pending: number }[],
): string | null {
	// Only domain agents can be measured by /warden-select; anything else
	// would nudge the user toward a command that errors.
	const counts = allCounts.filter((c) =>
		(DOMAIN_AGENTS as readonly string[]).includes(c.agent),
	);
	if (counts.length === 0) return null;
	const total = counts.reduce((sum, c) => sum + c.pending, 0);
	const perAgent = counts.map((c) => `${c.agent}: ${c.pending}`).join(", ");
	return (
		`token-warden: ${total} candidate rule(s) pending measurement (${perAgent}). ` +
		`When convenient, run /token-warden:warden-select <agent> (spends benchmark tokens) to measure and compile them.`
	);
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
				const nudge = buildNudge(candidateCounts(db));
				if (nudge !== null) {
					console.log(
						JSON.stringify({
							hookSpecificOutput: {
								hookEventName: "SessionStart",
								additionalContext: nudge,
							},
						}),
					);
				}
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
