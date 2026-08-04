/**
 * VACUITY GUARD for the bundled golden suites.
 *
 * A `success_check` that passes on the PRISTINE fixture — before any agent has
 * touched it — is a dead sensor. It cannot detect a regression, and because a
 * quota-dead run then records `completed = true`, it is also invisible to the
 * environment-failure discriminator. v0.40.0 found two such checks (`sql-01`,
 * `backend-03`) by hand; nothing stopped a third from being added.
 *
 * The checks are EXECUTED, never read. The whole lesson of the first audit is
 * that grepping the grep tells you nothing: ROADMAP recorded a suspicion that
 * `sql-05` was vacuous too, and executing it shows it is not (it requires an
 * index on `created_at`; the pristine schema indexes only `products(name)`).
 *
 * SUFFICIENCY: a check is an `&&` chain, so if any single clause fails on the
 * pristine fixture the whole check fails. Asserting that some NON-TEST clause
 * fails is therefore a sound proof of non-vacuity, and it is fast — no test
 * runner is spawned. It is also the stronger property: a check whose behavioural
 * clauses all pass untouched cannot tell "the agent did the thing asked" from
 * "the agent did not break the existing tests", even when its trailing
 * `npx vitest run` keeps the check as a whole honest.
 *
 * Zero tokens: no model is involved.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	checkChildEnv,
	loadGoldenTasks,
	shouldCopyFixtureEntry,
} from "../src/bench.js";
import { knownAgents } from "../src/registry.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(pluginRoot, "benchmarks", "fixture");

/**
 * The two checks known to pass pristine, kept BYTE-IDENTICAL on purpose.
 * v0.40.0's remedy was addition, not editing: `sql-08` and `backend-04` were
 * added to do the detecting, and the originals were frozen so their recorded
 * `run1_tokens` baselines and every published comparison stay valid. They are
 * listed here so a NEW vacuous check cannot hide behind their precedent — this
 * allowlist is the thing a reviewer has to argue with.
 */
const KNOWN_VACUOUS = new Set(["sql-01", "backend-03"]);

/** Clauses that run the fixture's test suite rather than assert the specific
 * behaviour the task asked for. */
const isTestClause = (clause: string): boolean =>
	/vitest|npm test/.test(clause);

let workDir: string | undefined;

beforeAll(() => {
	// One read-only copy shared by every clause: only non-test clauses run here,
	// and those are greps.
	workDir = mkdtempSync(join(tmpdir(), "warden-vacuity-"));
	cpSync(fixtureDir, workDir, {
		recursive: true,
		filter: shouldCopyFixtureEntry,
	});
	if (existsSync(join(fixtureDir, "node_modules"))) {
		symlinkSync(
			join(fixtureDir, "node_modules"),
			join(workDir, "node_modules"),
			"dir",
		);
	}
});

afterAll(() => {
	if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function clauseFailsPristine(clause: string): boolean {
	const result = spawnSync("bash", ["-c", clause], {
		cwd: workDir,
		encoding: "utf8",
		timeout: 30_000,
		env: checkChildEnv(),
	});
	// A clause that could not RUN proves nothing either way — surface it rather
	// than counting it as a pass (the same distinction bench.ts draws between a
	// failed check and a check that never executed).
	if (result.error) throw result.error;
	expect(result.status).not.toBeNull();
	return result.status !== 0;
}

describe("bundled golden checks are not vacuous", () => {
	const tasks = knownAgents().flatMap((agent) => loadGoldenTasks(agent));

	it("finds bundled tasks to audit at all", () => {
		expect(tasks.length).toBeGreaterThan(15);
	});

	for (const task of tasks) {
		const known = KNOWN_VACUOUS.has(task.id);
		it(`${task.id}${known ? " (known vacuous, frozen)" : ""}`, () => {
			const behavioural = task.successCheck
				.split("&&")
				.map((c) => c.trim())
				.filter((c) => c.length > 0 && !isTestClause(c));

			if (known) {
				// Pin the KNOWN state: if someone fixes one of these in place, this
				// fails and forces the add-don't-edit conversation, because editing
				// it invalidates the frozen baselines it still carries.
				expect(behavioural.every((c) => !clauseFailsPristine(c))).toBe(true);
				return;
			}

			// Every other task must assert something about the agent's WORK, and
			// that assertion must not already hold before the agent runs.
			expect(behavioural.length).toBeGreaterThan(0);
			expect(behavioural.some((c) => clauseFailsPristine(c))).toBe(true);
		});
	}
});
