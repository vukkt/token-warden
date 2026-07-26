/**
 * The CLI entry boundary, shared by every user-invoked command.
 *
 * The same shim was copy-pasted 25 times: an `invokedDirectly` check comparing
 * `import.meta.url` against `process.argv[1]`, wrapped in a try/catch that
 * prints `err.message` to stderr and exits 1. Twenty-five copies of one
 * convention is twenty-five chances for one of them to drift — and the repo's
 * own error ledger already records the lesson that a command must be verified
 * by its EXIT CODE, not by its output tail.
 *
 * NOT used by the four fail-open hook entrypoints (collect, notify, gate, and
 * the detached distiller). Those encode different knowledge: a hook must exit 0
 * whatever happens, because a non-zero exit breaks the user's session. Merging
 * them into this boundary would silently convert "never break the session" into
 * "report the error", which is the opposite contract. They keep their own
 * shims and their own `installFailOpenHandlers`.
 *
 * A `withDb` helper (open + `finally db.close()`, 23 hand-written copies)
 * belongs here too and is deliberately NOT included yet: unlike the entry
 * shim, adopting it rewrites the BODY of every command rather than replacing a
 * uniform trailer, so it is a separate change with its own verification rather
 * than a rider on this one. Tracked in ROADMAP.
 */
import { pathToFileURL } from "node:url";

/** True when this module is the process entrypoint rather than an import. */
export function isEntrypoint(importMetaUrl: string): boolean {
	return (
		process.argv[1] !== undefined &&
		importMetaUrl === pathToFileURL(process.argv[1]).href
	);
}

/**
 * Run a command's main when its module is the entrypoint, applying the shared
 * failure convention: print the message (not the stack) and exit 1.
 *
 * Both existing success conventions are preserved exactly. A `main` that
 * RETURNS A NUMBER is an explicit exit code and is passed to `process.exit`;
 * a `main` that returns void falls through and lets Node exit naturally. That
 * distinction is deliberate rather than tidied away — calling `process.exit(0)`
 * on the void path could truncate buffered stdout on a piped command, which is
 * exactly how a report loses its last lines.
 */
export function runCli(importMetaUrl: string, run: () => unknown): void {
	if (!isEntrypoint(importMetaUrl)) return;
	try {
		const code = run();
		if (typeof code === "number") process.exit(code);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
