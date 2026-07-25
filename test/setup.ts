/**
 * Global test setup — a hard guard against a test touching the user's REAL
 * state.
 *
 * The ledger at `~/.token-warden/warden.db` holds months of frozen
 * `run1_tokens` baselines that cannot be regenerated at any price, and
 * `~/.claude/agent-memory/<agent>/MEMORY.md` is injected into that agent's
 * prompt in every future session. Today every suite sets `TOKEN_WARDEN_DB` and
 * `TOKEN_WARDEN_MEMORY_DIR` in its own `beforeEach` — but that is a convention
 * held up by review, not by the harness. One new test file that calls
 * `runProtect` or `selectForAgent` without that setup writes straight into the
 * user's production agent memory, and nothing would catch it.
 *
 * So: point both at a per-worker temp directory by default, and fail loudly if
 * anything ever resolves back under the real home directory. A suite that sets
 * its own temp paths (all of them do) overrides these harmlessly; a suite that
 * forgets gets a temp dir instead of the user's ledger.
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach } from "vitest";

const workerScratch = mkdtempSync(join(tmpdir(), "warden-test-guard-"));

/** Paths the suite must never write to, whatever the test does. */
const FORBIDDEN_ROOTS = [
	resolve(homedir(), ".token-warden"),
	resolve(homedir(), ".claude", "agent-memory"),
];

function assertNotUnderRealHome(name: string, value: string | undefined): void {
	if (value === undefined) return;
	const target = resolve(value);
	for (const root of FORBIDDEN_ROOTS) {
		if (target === root || target.startsWith(`${root}/`)) {
			throw new Error(
				`${name} resolves to ${target}, which is inside the user's real state ` +
					`(${root}). A test must never read or write the production ledger or ` +
					`agent memory — set it to a temp directory.`,
			);
		}
	}
}

// Default both to this worker's scratch dir, so a suite that forgets to set
// them cannot fall through to defaultDbPath()/memoryFilePath()'s real paths.
process.env.TOKEN_WARDEN_DB ??= join(workerScratch, "warden.db");
process.env.TOKEN_WARDEN_MEMORY_DIR ??= join(workerScratch, "agent-memory");

// Re-arm before every test. Two reasons this cannot be a one-shot check: a
// suite that sets its own paths does so in its own `beforeEach`, which runs
// after this one; and many suites `delete` these vars in `afterEach`, which
// would otherwise leave the NEXT test in that file falling through to
// defaultDbPath()/memoryFilePath() — i.e. the real ledger. Re-defaulting when
// unset is the half that actually prevents the incident; the assertion catches
// an explicit bad value.
beforeEach(() => {
	process.env.TOKEN_WARDEN_DB ??= join(workerScratch, "warden.db");
	process.env.TOKEN_WARDEN_MEMORY_DIR ??= join(workerScratch, "agent-memory");
	assertNotUnderRealHome("TOKEN_WARDEN_DB", process.env.TOKEN_WARDEN_DB);
	assertNotUnderRealHome(
		"TOKEN_WARDEN_MEMORY_DIR",
		process.env.TOKEN_WARDEN_MEMORY_DIR,
	);
});

// The beforeEach above runs BEFORE a suite's own beforeEach and before the test
// body, so on its own it cannot see a bad path set by the suite itself — which
// is exactly the incident being guarded against. Checking again afterwards is
// what makes the assertion non-vacuous: a test that repoints either variable at
// the user's real state fails, rather than silently writing there.
afterEach(() => {
	assertNotUnderRealHome("TOKEN_WARDEN_DB", process.env.TOKEN_WARDEN_DB);
	assertNotUnderRealHome(
		"TOKEN_WARDEN_MEMORY_DIR",
		process.env.TOKEN_WARDEN_MEMORY_DIR,
	);
});
