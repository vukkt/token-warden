import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentDefinition,
	assertSafePathSegment,
	type BenchSpawnOptions,
	benchChildEnv,
	CHECK_ENV_ALLOWLIST,
	checkChildEnv,
	cleanupWorkDirs,
	ENV_FAILURE_TOKEN_FLOOR,
	EnvironmentFailureError,
	findTranscript,
	findTranscriptForWorkDir,
	type GoldenTask,
	goldenSuiteHash,
	installAgent,
	installWorkDirCleanup,
	isEnvironmentFailure,
	isSpawnTimeout,
	loadGoldenTasks,
	parseAgentDefinition,
	parseArgs,
	parseGoldenTask,
	passEnvironmentFailure,
	type RunOnceDeps,
	type RunResult,
	registerWorkDir,
	releaseWorkDir,
	runOnce,
	runSuite,
	SESSION_ENV_KEYS,
	type SpawnResult,
	type SuiteOptions,
	shouldCopyFixtureEntry,
	summarizeTask,
	totalTokens,
} from "../src/bench.js";
import {
	getBaseline,
	openDb,
	type RuleRow,
	recordBaseline,
	type WardenDb,
} from "../src/db.js";
import { compileMemoryMd } from "../src/memory.js";
import { knownAgents } from "../src/registry.js";

describe("parseArgs", () => {
	it("parses agent, rule, runs, and task", () => {
		expect(
			parseArgs([
				"--agent",
				"sql",
				"--rule",
				"7",
				"--runs",
				"3",
				"--task",
				"sql-01",
			]),
		).toEqual({ agent: "sql", rule: 7, runs: 3, task: "sql-01" });
	});

	it("defaults to three runs and no rule", () => {
		expect(parseArgs(["--agent", "backend"])).toEqual({
			agent: "backend",
			rule: null,
			runs: 3,
			task: null,
		});
	});

	it("rejects unknown agents, flags, and bad runs", () => {
		expect(() => parseArgs(["--agent", "main"])).toThrow(/--agent/);
		expect(() => parseArgs(["--agent", "sql", "--frobnicate", "1"])).toThrow(
			/unknown flag/,
		);
		expect(() => parseArgs(["--agent", "sql", "--runs", "0"])).toThrow(
			/--runs/,
		);
	});
});

describe("golden task files", () => {
	it("parses frontmatter fields", () => {
		const task = parseGoldenTask(
			'---\nid: x-01\nagent: sql\nprompt: "Do the thing."\nsuccess_check: "true"\n---\nbody',
			"x.md",
		);
		expect(task).toMatchObject({
			id: "x-01",
			agent: "sql",
			prompt: "Do the thing.",
			successCheck: "true",
		});
	});

	it("rejects files missing required fields", () => {
		expect(() => parseGoldenTask("---\nid: x\n---\n", "x.md")).toThrow(/agent/);
		expect(() => parseGoldenTask("no frontmatter", "x.md")).toThrow(
			/frontmatter/,
		);
	});

	it("rejects a prompt the benchmarked CLI would read as a flag", () => {
		// `-p`/`--print` takes an OPTIONAL value, so a prompt starting with "-"
		// is parsed by the child CLI as a new flag — a suite file could hand
		// itself a different permission mode than the scoped `acceptEdits` the
		// whole benchmark depends on.
		const file = (prompt: string) =>
			`---\nid: x-01\nagent: sql\nprompt: "${prompt}"\nsuccess_check: "true"\n---\nbody`;
		expect(() =>
			parseGoldenTask(file("--dangerously-skip-permissions"), "x.md"),
		).toThrow(/must not start with/);
		expect(() => parseGoldenTask(file("Do the thing."), "x.md")).not.toThrow();
	});

	it("every shipped agent has a complete, well-formed golden suite (>=3 tasks, unique ids)", () => {
		for (const agent of knownAgents()) {
			const tasks = loadGoldenTasks(agent);
			// A complete suite is at least 3 tasks; suites may grow (only by
			// adding files — baselines are frozen), so this is a floor, not an
			// exact count.
			expect(tasks.length, agent).toBeGreaterThanOrEqual(3);
			const ids = new Set<string>();
			for (const task of tasks) {
				expect(task.agent).toBe(agent);
				expect(task.id).toMatch(new RegExp(`^${agent}-\\d+$`));
				expect(task.prompt.length).toBeGreaterThan(20);
				expect(task.successCheck.length).toBeGreaterThan(0);
				// Duplicate ids would silently collide on one frozen baseline.
				expect(ids.has(task.id), `duplicate task id ${task.id}`).toBe(false);
				ids.add(task.id);
			}
		}
	});

	it("the narrower split tasks parse and carry unique ids within their agent", () => {
		const splits: Array<{ agent: string; file: string }> = [
			{ agent: "sql", file: "../benchmarks/sql/golden-06.md" },
			{ agent: "sql", file: "../benchmarks/sql/golden-07.md" },
			{ agent: "testing", file: "../benchmarks/testing/golden-05.md" },
			{ agent: "testing", file: "../benchmarks/testing/golden-06.md" },
		];
		const byAgent = new Map<string, Set<string>>();
		for (const { agent, file } of splits) {
			const path = fileURLToPath(new URL(file, import.meta.url));
			const task = parseGoldenTask(readFileSync(path, "utf8"), path);
			expect(task.agent).toBe(agent);
			expect(task.id).toMatch(new RegExp(`^${agent}-\\d+$`));
			expect(task.prompt.length).toBeGreaterThan(20);
			expect(task.successCheck.length).toBeGreaterThan(0);
			const seen = byAgent.get(agent) ?? new Set<string>();
			expect(seen.has(task.id), `duplicate task id ${task.id}`).toBe(false);
			seen.add(task.id);
			byAgent.set(agent, seen);
		}
		// The added ids must also be unique against the rest of their live suite.
		for (const agent of ["sql", "testing"]) {
			const ids = loadGoldenTasks(agent).map((t) => t.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});
});

describe("compileMemoryMd", () => {
	it("renders the generated header and one rule per line", () => {
		const memory = compileMemoryMd([{ body: "Rule A" }, { body: "Rule B" }]);
		expect(memory).toContain("GENERATED BY token-warden");
		expect(memory).toContain("- Rule A\n- Rule B");
	});
});

describe("totalTokens", () => {
	it("sums all four token counters", () => {
		expect(
			totalTokens({
				inputTokens: 1,
				outputTokens: 2,
				cacheCreation: 3,
				cacheRead: 4,
			}),
		).toBe(10);
	});
});

describe("summarizeTask", () => {
	it("averages completed runs only and flags >25% variance", () => {
		const summary = summarizeTask("t", [
			{ sessionId: "a", tokens: 100, completed: true },
			{ sessionId: "b", tokens: 200, completed: true },
			{ sessionId: "c", tokens: 9999, completed: false },
		]);
		expect(summary.meanCompletedTokens).toBe(150);
		expect(summary.highVariance).toBe(true);
	});

	it("does not flag close runs", () => {
		const summary = summarizeTask("t", [
			{ sessionId: "a", tokens: 100, completed: true },
			{ sessionId: "b", tokens: 110, completed: true },
		]);
		expect(summary.highVariance).toBe(false);
	});

	it("defaults weight to 1 and carries an explicit weight through", () => {
		const results = [{ sessionId: "a", tokens: 100, completed: true }];
		expect(summarizeTask("t", results).weight).toBe(1);
		expect(summarizeTask("t", results, 4).weight).toBe(4);
	});
});

describe("parseGoldenTask weight", () => {
	const base =
		'---\nid: sql-01\nagent: sql\nprompt: "Do the thing."\nsuccess_check: "true"';
	it("defaults an absent weight to 1", () => {
		expect(parseGoldenTask(`${base}\n---\nbody`, "x.md").weight).toBe(1);
	});
	it("parses a fractional weight", () => {
		expect(
			parseGoldenTask(`${base}\nweight: 2.5\n---\nbody`, "x.md").weight,
		).toBe(2.5);
	});
	it("rejects a zero, negative, or non-numeric weight", () => {
		expect(() =>
			parseGoldenTask(`${base}\nweight: 0\n---\nbody`, "x.md"),
		).toThrow(/weight/);
		expect(() =>
			parseGoldenTask(`${base}\nweight: -3\n---\nbody`, "x.md"),
		).toThrow(/weight/);
		expect(() =>
			parseGoldenTask(`${base}\nweight: x\n---\nbody`, "x.md"),
		).toThrow(/weight/);
	});
});

describe("baseline freezing", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-baseline-"));
		db = openDb(join(dir, "warden.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("freezes run1_tokens and ratchets best_tokens downward only", () => {
		recordBaseline(db, "sql", "sql-01", 50_000, "t1");
		recordBaseline(db, "sql", "sql-01", 40_000, "t2");
		recordBaseline(db, "sql", "sql-01", 60_000, "t3");
		const baseline = getBaseline(db, "sql", "sql-01");
		expect(baseline?.run1_tokens).toBe(50_000);
		expect(baseline?.best_tokens).toBe(40_000);
		expect(baseline?.updated_at).toBe("t3");
	});
});

// Safety-critical: a benchmark must NEVER read or write the user's real
// ~/.claude/agent-memory. parseAgentDefinition enforces that by rewriting the
// memory scope to `project`, so MEMORY.md resolves inside the temp workdir.
describe("parseAgentDefinition (memory-scope isolation)", () => {
	const def = (frontmatter: string) =>
		`---\n${frontmatter}\n---\n\nYou are an agent.\n`;

	it("rewrites a user-scoped memory field to project", () => {
		const { content } = parseAgentDefinition(
			def("name: sql\nmemory: user\nmodel: sonnet"),
			"sql.md",
		);
		expect(content).toContain("memory: project");
		expect(content).not.toMatch(/^memory: user$/m);
	});

	it("rewrites any single-word scope (local) and is idempotent on project", () => {
		expect(
			parseAgentDefinition(def("memory: local"), "x.md").content,
		).toContain("memory: project");
		expect(
			parseAgentDefinition(def("memory: project"), "x.md").content,
		).toContain("memory: project");
	});

	it("tolerates no spacing after the colon", () => {
		expect(parseAgentDefinition(def("memory:user"), "x.md").content).toContain(
			"memory: project",
		);
	});

	it("throws when there is no memory frontmatter field to rewrite", () => {
		expect(() => parseAgentDefinition(def("name: sql"), "sql.md")).toThrow(
			/no "memory:" frontmatter/,
		);
		expect(() => parseAgentDefinition(def("name: sql"), "sql.md")).toThrow(
			/sql\.md/,
		);
	});

	it("extracts the model, defaulting to sonnet when absent", () => {
		expect(
			parseAgentDefinition(def("memory: user\nmodel: haiku"), "x").model,
		).toBe("haiku");
		expect(parseAgentDefinition(def("memory: user"), "x").model).toBe("sonnet");
	});

	it("preserves the rest of the definition body", () => {
		const { content } = parseAgentDefinition(def("memory: user"), "x.md");
		expect(content).toContain("You are an agent.");
	});
});

describe("goldenSuiteHash", () => {
	it("is a stable 12-char hex digest", () => {
		const h = goldenSuiteHash("sql");
		expect(h).toMatch(/^[0-9a-f]{12}$/);
		expect(goldenSuiteHash("sql")).toBe(h);
	});

	it("differs between agents whose suites differ", () => {
		expect(goldenSuiteHash("sql")).not.toBe(goldenSuiteHash("backend"));
	});
});

describe("environment-failure detection", () => {
	it("classifies only zero-ish-token failed runs as environment failures", () => {
		const run = (tokens: number, completed: boolean) => ({
			sessionId: "s",
			tokens,
			completed,
		});
		expect(isEnvironmentFailure(run(0, false))).toBe(true);
		expect(isEnvironmentFailure(run(999, false))).toBe(true);
		// At the floor the run burned real tokens: rule signal, not environment.
		expect(isEnvironmentFailure(run(1000, false))).toBe(false);
		expect(isEnvironmentFailure(run(40_000, false))).toBe(false);
		// A completed run is never an environment failure HERE, whatever its
		// cost — synthetic summaries in the calibration harnesses work at token
		// scales of hundreds, and a bare magnitude test would abort their
		// passes. The quota-death-recorded-as-success case is closed upstream
		// instead: `runOnce` refuses to record a sub-floor run as completed (see
		// "records a passing check on a zero-token run as NOT completed"), and
		// `compare.ts` re-derives the flag for rows recorded before that fix.
		expect(isEnvironmentFailure(run(0, true))).toBe(false);
	});

	it("trips the pass-level check on a strict majority with a minimum count", () => {
		const pass = (envFailed: number, ok: number) => [
			summarizeTask("t1", [
				...Array.from({ length: envFailed }, (_, i) => ({
					sessionId: `f${i}`,
					tokens: 0,
					completed: false,
				})),
				...Array.from({ length: ok }, (_, i) => ({
					sessionId: `o${i}`,
					tokens: 50_000,
					completed: true,
				})),
			]),
		];
		// Exactly half is not a majority.
		expect(passEnvironmentFailure(pass(3, 3)).tripped).toBe(false);
		expect(passEnvironmentFailure(pass(4, 2)).tripped).toBe(true);
		// A majority below the minimum count (transient crashes) never trips.
		expect(passEnvironmentFailure(pass(2, 1)).tripped).toBe(false);
		expect(passEnvironmentFailure(pass(3, 2)).tripped).toBe(true);
		// The real quota death: 72 of 84 baseline runs failed.
		expect(passEnvironmentFailure(pass(72, 12)).tripped).toBe(true);
		expect(passEnvironmentFailure(pass(4, 2))).toMatchObject({
			envFailed: 4,
			total: 6,
		});
	});

	it("failed-with-tokens runs are not counted as environment failures", () => {
		const summaries = [
			summarizeTask("t1", [
				{ sessionId: "a", tokens: 40_000, completed: false },
				{ sessionId: "b", tokens: 45_000, completed: false },
				{ sessionId: "c", tokens: 42_000, completed: false },
				{ sessionId: "d", tokens: 41_000, completed: false },
			]),
		];
		expect(passEnvironmentFailure(summaries)).toMatchObject({
			envFailed: 0,
			total: 4,
			tripped: false,
		});
	});
});

describe("runSuite environment-failure streak abort", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-bench-suite-"));
		db = openDb(join(dir, "warden.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const tasks = (n: number): GoldenTask[] =>
		Array.from({ length: n }, (_, i) => ({
			id: `t${i + 1}`,
			agent: "sql",
			prompt: "do the thing",
			successCheck: "true",
			file: `t${i + 1}.md`,
			weight: 1,
		}));

	const options = (runs: number): SuiteOptions => ({
		rules: [],
		runs,
		recordBaselines: false,
		rulesetVersion: 0,
		label: "test-pass",
		config: "candidate",
		definitionOverride: { content: "agent", model: "sonnet" },
	});

	/** Fake runOnce returning scripted results in order; throws (RUN-ERROR
	 * path) when the scripted entry is "crash". */
	function scripted(script: (RunResult | "crash")[]): {
		single: () => RunResult;
		calls: () => number;
	} {
		let i = 0;
		return {
			single: (): RunResult => {
				const entry = script[i++];
				if (entry === undefined) throw new Error("script exhausted");
				if (entry === "crash") throw new Error("claude crashed");
				return entry;
			},
			calls: () => i,
		};
	}

	const envFail = (): RunResult => ({
		sessionId: "dead",
		tokens: 0,
		completed: false,
	});
	const ok = (): RunResult => ({
		sessionId: "ok",
		tokens: 50_000,
		completed: true,
	});

	it("throws EnvironmentFailureError after 4 consecutive zero-token failures and stops running", () => {
		const fake = scripted([envFail(), envFail(), envFail(), envFail(), ok()]);
		expect(() =>
			runSuite(db, "sql", tasks(3), options(2), fake.single as never),
		).toThrow(EnvironmentFailureError);
		// No fifth run was attempted after the abort.
		expect(fake.calls()).toBe(4);
	});

	it("carries diagnostics (counts, streak, partial summaries) on the error", () => {
		const fake = scripted([ok(), envFail(), envFail(), envFail(), envFail()]);
		try {
			runSuite(db, "sql", tasks(3), options(2), fake.single as never);
			expect.unreachable("should have thrown");
		} catch (err) {
			if (!(err instanceof EnvironmentFailureError)) throw err;
			expect(err.info).toMatchObject({
				agent: "sql",
				label: "test-pass",
				envFailed: 4,
				total: 5,
				streak: 4,
			});
			expect(err.info.partial.length).toBeGreaterThan(0);
		}
	});

	it("a completed run resets the streak", () => {
		// fail,fail,fail,ok | fail,fail,fail,fail -> aborts on run 8, not 4.
		const fake = scripted([
			envFail(),
			envFail(),
			envFail(),
			ok(),
			envFail(),
			envFail(),
			envFail(),
			envFail(),
		]);
		expect(() =>
			runSuite(db, "sql", tasks(2), options(4), fake.single as never),
		).toThrow(EnvironmentFailureError);
		expect(fake.calls()).toBe(8);
	});

	it("a failed run that burned real tokens resets the streak (rule signal, not environment)", () => {
		const ruleFail = (): RunResult => ({
			sessionId: "broke",
			tokens: 40_000,
			completed: false,
		});
		const fake = scripted([
			envFail(),
			envFail(),
			envFail(),
			ruleFail(),
			ok(),
			ok(),
		]);
		const summaries = runSuite(
			db,
			"sql",
			tasks(3),
			options(2),
			fake.single as never,
		);
		expect(summaries).toHaveLength(3);
		expect(fake.calls()).toBe(6);
	});

	it("crash-thrown runs (RUN-ERROR) count toward the streak", () => {
		const fake = scripted(["crash", "crash", "crash", "crash", ok()]);
		expect(() =>
			runSuite(db, "sql", tasks(3), options(2), fake.single as never),
		).toThrow(EnvironmentFailureError);
		expect(fake.calls()).toBe(4);
	});

	it("a single broken run still does not abort the suite", () => {
		const fake = scripted([ok(), "crash", ok(), ok()]);
		const summaries = runSuite(
			db,
			"sql",
			tasks(2),
			options(2),
			fake.single as never,
		);
		expect(summaries).toHaveLength(2);
		const failed = summaries
			.flatMap((s) => s.results)
			.filter((r) => !r.completed);
		expect(failed).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Contract, resource-management and subprocess-safety tests for the
// integration boundary. None of these spawn a real process or spend a token:
// the spawn seam (RunOnceDeps) is injected.
// ---------------------------------------------------------------------------

describe("path-segment safety", () => {
	it("accepts the shipped id/agent shapes", () => {
		for (const value of ["sql", "sql-01", "backend-03", "my.agent_2"]) {
			expect(() => assertSafePathSegment(value, "id", "x.md")).not.toThrow();
		}
	});

	it("rejects separators, traversal, empties and over-long values", () => {
		for (const value of [
			"../../etc/passwd",
			"a/b",
			"a\\b",
			".hidden",
			"",
			"has space",
			"a".repeat(65),
		]) {
			expect(() => assertSafePathSegment(value, "id", "x.md"), value).toThrow(
				/filename-safe slug/,
			);
		}
	});

	it("parseGoldenTask refuses a task whose id would escape the temp dir", () => {
		const task = (id: string, agent = "sql") =>
			`---\nid: ${id}\nagent: ${agent}\nprompt: "Do the thing."\nsuccess_check: "true"\n---\nbody`;
		// mkdtemp(warden-bench-<id>-…) with a traversing id writes outside tmpdir.
		expect(() => parseGoldenTask(task("../../pwn"), "x.md")).toThrow(/"id"/);
		// agent becomes .claude/agents/<agent>.md inside the workdir.
		expect(() => parseGoldenTask(task("sql-01", "../../pwn"), "x.md")).toThrow(
			/"agent"/,
		);
		expect(() => parseGoldenTask(task("sql-01"), "x.md")).not.toThrow();
	});
});

describe("loadGoldenTasks empty-suite contract", () => {
	let dir: string;
	let original: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-empty-suite-"));
		original = process.env.TOKEN_WARDEN_BENCHMARKS_DIR;
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR = dir;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.TOKEN_WARDEN_BENCHMARKS_DIR;
		else process.env.TOKEN_WARDEN_BENCHMARKS_DIR = original;
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws rather than returning an empty suite nothing can be measured on", () => {
		mkdirSync(join(dir, "custom-agent"), { recursive: true });
		writeFileSync(join(dir, "custom-agent", "notes.md"), "not a golden task");
		expect(() => loadGoldenTasks("custom-agent")).toThrow(
			/no golden tasks for agent "custom-agent"/,
		);
	});

	it("still reports a missing suite directory distinctly", () => {
		expect(() => loadGoldenTasks("absent-agent")).toThrow(/no golden suite/);
	});
});

describe("shouldCopyFixtureEntry", () => {
	it("keeps fixture sources and drops state, answers and vendored deps", () => {
		expect(shouldCopyFixtureEntry("/f/src/index.ts")).toBe(true);
		expect(shouldCopyFixtureEntry("/f/db/schema.sql")).toBe(true);
		// node_modules is symlinked, never copied.
		expect(shouldCopyFixtureEntry("/f/node_modules")).toBe(false);
		// BUGS.md would hand the agent the answers to the golden tasks.
		expect(shouldCopyFixtureEntry("/f/BUGS.md")).toBe(false);
		expect(shouldCopyFixtureEntry("/f/.git")).toBe(false);
		expect(shouldCopyFixtureEntry("/f/data/app.db")).toBe(false);
	});
});

describe("benchChildEnv (hermetic child session)", () => {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of [...SESSION_ENV_KEYS, "TOKEN_WARDEN_BENCH_MARKER"]) {
			saved.set(key, process.env[key]);
		}
	});

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		saved.clear();
	});

	it("strips every parent session-identity variable", () => {
		for (const key of SESSION_ENV_KEYS) process.env[key] = "parent";
		const env = benchChildEnv();
		for (const key of SESSION_ENV_KEYS) {
			expect(env[key], key).toBeUndefined();
		}
	});

	it("disables the distiller and preserves unrelated variables", () => {
		process.env.TOKEN_WARDEN_BENCH_MARKER = "keep-me";
		const env = benchChildEnv();
		expect(env.TOKEN_WARDEN_NO_DISTILL).toBe("1");
		expect(env.TOKEN_WARDEN_BENCH_MARKER).toBe("keep-me");
	});

	it("does not mutate the parent process environment", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "parent-session";
		benchChildEnv();
		expect(process.env.CLAUDE_CODE_SESSION_ID).toBe("parent-session");
	});

	it("covers the variables named in the 30.4M-token false-baseline incident", () => {
		// Regression guard: silently shortening this list re-opens the bug where
		// a child bound to the parent session froze a multi-megatoken parent
		// transcript as run1.
		expect(SESSION_ENV_KEYS).toContain("CLAUDECODE");
		expect(SESSION_ENV_KEYS).toContain("CLAUDE_CODE_SESSION_ID");
		expect(SESSION_ENV_KEYS).toContain("CLAUDE_CODE_REMOTE_SESSION_ID");
	});
});

describe("checkChildEnv (the success check never sees credentials)", () => {
	// A success check is arbitrary shell from a golden-suite file, which under
	// BYOA (TOKEN_WARDEN_BENCHMARKS_DIR) may be third-party. It used to inherit
	// process.env verbatim, so "run a check" also meant "read every key in the
	// parent environment". The source env is injected, so nothing here depends
	// on what the machine running the tests happens to export.
	const source: NodeJS.ProcessEnv = {
		PATH: "/usr/bin",
		HOME: "/home/u",
		ANTHROPIC_API_KEY: "sk-secret",
		AWS_SECRET_ACCESS_KEY: "aws-secret",
		GITHUB_TOKEN: "ghp-secret",
		SOME_FUTURE_CREDENTIAL: "on-nobody's-blocklist",
	};

	it("passes through the allowlisted variables and the bench marker, nothing else", () => {
		const env = checkChildEnv(source);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/u");
		expect(env.TOKEN_WARDEN_BENCH).toBe("1");
		expect(Object.keys(env).sort()).toEqual([
			"HOME",
			"PATH",
			"TOKEN_WARDEN_BENCH",
		]);
	});

	it("withholds every credential, including ones no blocklist names", () => {
		const env = checkChildEnv(source);
		for (const key of [
			"ANTHROPIC_API_KEY",
			"AWS_SECRET_ACCESS_KEY",
			"GITHUB_TOKEN",
			"SOME_FUTURE_CREDENTIAL",
		]) {
			expect(env[key], key).toBeUndefined();
		}
		// The guard is an allowlist by design: a credential variable invented
		// tomorrow is excluded by default instead of leaking until someone
		// remembers to name it.
		expect(CHECK_ENV_ALLOWLIST).not.toContain("ANTHROPIC_API_KEY");
	});

	it("omits an absent allowlisted variable instead of defining it undefined", () => {
		expect("LANG" in checkChildEnv({ PATH: "/usr/bin" })).toBe(false);
	});
});

describe("isSpawnTimeout", () => {
	const spawnResult = (error?: Error): SpawnResult => ({
		status: null,
		stdout: "",
		stderr: "",
		error,
	});

	it("is true only for the timeout kill, never for another spawn failure", () => {
		const withCode = (code: string) =>
			spawnResult(Object.assign(new Error(code), { code }));
		expect(isSpawnTimeout(withCode("ETIMEDOUT"))).toBe(true);
		// Everything below must stay false: this predicate is the gate on
		// transcript recovery, and recovering for a run that never started would
		// invent a measurement.
		expect(isSpawnTimeout(withCode("ENOENT"))).toBe(false);
		expect(isSpawnTimeout(spawnResult(new Error("no code at all")))).toBe(
			false,
		);
		expect(isSpawnTimeout(spawnResult())).toBe(false);
	});
});

describe("findTranscript", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-transcripts-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds a session transcript under any project directory", () => {
		mkdirSync(join(dir, "-Users-x-proj-a"), { recursive: true });
		mkdirSync(join(dir, "-Users-x-proj-b"), { recursive: true });
		const path = join(dir, "-Users-x-proj-b", "sess-42.jsonl");
		writeFileSync(path, "{}\n");
		expect(findTranscript("sess-42", dir)).toBe(path);
	});

	it("returns null for an unknown session and a missing projects dir", () => {
		mkdirSync(join(dir, "-Users-x-proj-a"), { recursive: true });
		expect(findTranscript("nope", dir)).toBeNull();
		expect(findTranscript("nope", join(dir, "does-not-exist"))).toBeNull();
	});
});

describe("installAgent", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-install-agent-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const definition: AgentDefinition = {
		content: "---\nmemory: project\n---\nYou are an agent.\n",
		model: "sonnet",
	};

	it("writes the definition and scoped permissions, and no MEMORY.md without rules", () => {
		installAgent(dir, "sql", definition, []);
		expect(readFileSync(join(dir, ".claude", "agents", "sql.md"), "utf8")).toBe(
			definition.content,
		);
		const settings = JSON.parse(
			readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
		) as { permissions: { allow: string[] } };
		// Bench agents run scoped: an allowlist, never bypassPermissions.
		expect(settings.permissions.allow).toContain("Bash(npx vitest:*)");
		expect(JSON.stringify(settings)).not.toContain("bypassPermissions");
		expect(
			existsSync(join(dir, ".claude", "agent-memory", "sql", "MEMORY.md")),
		).toBe(false);
	});

	it("compiles active rules into the project-scoped MEMORY.md", () => {
		const rules = [
			{ body: "Grep before reading." } as RuleRow,
			{ body: "Batch edits.", scope: "when editing" } as RuleRow,
		];
		installAgent(dir, "sql", definition, rules);
		const memory = readFileSync(
			join(dir, ".claude", "agent-memory", "sql", "MEMORY.md"),
			"utf8",
		);
		expect(memory).toBe(compileMemoryMd(rules));
		expect(memory).toContain("- Grep before reading.");
		expect(memory).toContain("- (when when editing) Batch edits.");
	});

	it("refuses an agent name that would escape the work directory", () => {
		expect(() => installAgent(dir, "../../pwn", definition, [])).toThrow(
			/filename-safe slug/,
		);
		expect(existsSync(join(dir, ".claude"))).toBe(false);
	});
});

describe("temp fixture-copy lifecycle", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-workdirs-"));
	});

	afterEach(() => {
		cleanupWorkDirs();
		rmSync(dir, { recursive: true, force: true });
	});

	function makeDir(name: string): string {
		const path = join(dir, name);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "file.txt"), "x");
		return path;
	}

	it("releaseWorkDir removes the copy and stops tracking it", () => {
		const path = makeDir("a");
		registerWorkDir(path);
		releaseWorkDir(path);
		expect(existsSync(path)).toBe(false);
		// Already released: the interrupt sweep finds nothing left to do.
		expect(cleanupWorkDirs()).toBe(0);
	});

	it("cleanupWorkDirs sweeps every copy an interrupt would have orphaned", () => {
		const paths = ["a", "b", "c"].map(makeDir);
		for (const path of paths) registerWorkDir(path);
		expect(cleanupWorkDirs()).toBe(3);
		for (const path of paths) expect(existsSync(path)).toBe(false);
		// Idempotent: a signal followed by the exit hook must not double-count.
		expect(cleanupWorkDirs()).toBe(0);
	});

	it("cleanupWorkDirs never throws (it runs from signal and exit handlers)", () => {
		const path = makeDir("gone");
		registerWorkDir(path);
		rmSync(path, { recursive: true, force: true });
		expect(() => cleanupWorkDirs()).not.toThrow();
	});

	it("installWorkDirCleanup is idempotent and fully reversible", () => {
		const before = {
			exit: process.listenerCount("exit"),
			sigint: process.listenerCount("SIGINT"),
			sigterm: process.listenerCount("SIGTERM"),
			sighup: process.listenerCount("SIGHUP"),
		};
		const uninstall = installWorkDirCleanup();
		expect(process.listenerCount("exit")).toBe(before.exit + 1);
		expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
		expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
		expect(process.listenerCount("SIGHUP")).toBe(before.sighup + 1);
		// A second install adds nothing (a 3-agent suite calls it per run).
		expect(installWorkDirCleanup()).toBe(uninstall);
		expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
		uninstall();
		expect(process.listenerCount("exit")).toBe(before.exit);
		expect(process.listenerCount("SIGINT")).toBe(before.sigint);
		expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
		expect(process.listenerCount("SIGHUP")).toBe(before.sighup);
	});
});

describe("runOnce (spawn boundary injected)", () => {
	let dir: string;
	let db: WardenDb;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-runonce-"));
		db = openDb(join(dir, "warden.db"));
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const task: GoldenTask = {
		id: "sql-01",
		agent: "sql",
		prompt: "Add an index on orders.user_id.",
		successCheck: "grep -qi 'create index' db/schema.sql",
		file: "golden-01.md",
		weight: 1,
	};
	const definition: AgentDefinition = {
		content: "---\nmemory: project\n---\nbody\n",
		model: "sonnet",
	};
	const options = (over: Partial<SuiteOptions> = {}): SuiteOptions => ({
		rules: [],
		runs: 1,
		recordBaselines: false,
		rulesetVersion: 3,
		label: "test-pass",
		config: "candidate",
		...over,
	});

	// 1000 + 200 + 300 + 500 = 2000 tokens.
	const transcript = [
		JSON.stringify({ type: "user", uuid: "u1", message: { content: "do x" } }),
		JSON.stringify({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				content: [{ type: "text", text: "done" }],
				usage: {
					input_tokens: 1000,
					output_tokens: 200,
					cache_creation_input_tokens: 300,
					cache_read_input_tokens: 500,
				},
			},
		}),
	].join("\n");

	interface Harness {
		deps: RunOnceDeps;
		spawns: Array<{
			command: string;
			args: string[];
			options: BenchSpawnOptions;
		}>;
		created: string[];
		disposed: string[];
	}

	const claudeOk = (over: Partial<SpawnResult> = {}): SpawnResult => ({
		status: 0,
		signal: null,
		stdout: JSON.stringify({ session_id: "sess-1", duration_ms: 4200 }),
		stderr: "",
		...over,
	});
	const checkResult = (
		status: number | null,
		over: Partial<SpawnResult> = {},
	): SpawnResult => ({
		status,
		signal: null,
		stdout: "",
		stderr: "",
		...over,
	});

	function harness(
		script: SpawnResult[],
		over: Partial<RunOnceDeps> = {},
	): Harness {
		const spawns: Harness["spawns"] = [];
		const created: string[] = [];
		const disposed: string[] = [];
		let i = 0;
		const deps: RunOnceDeps = {
			spawn: (command, args, spawnOptions) => {
				spawns.push({ command, args, options: spawnOptions });
				const next = script[i++];
				if (next === undefined) throw new Error("spawn script exhausted");
				return next;
			},
			makeWorkDir: (t) => {
				const workDir = join(dir, `work-${t.id}-${created.length}`);
				mkdirSync(workDir, { recursive: true });
				created.push(workDir);
				return workDir;
			},
			disposeWorkDir: (d) => {
				disposed.push(d);
				rmSync(d, { recursive: true, force: true });
			},
			copyFixture: () => {},
			installAgent: () => {},
			findTranscript: () => join(dir, "transcript.jsonl"),
			findTranscriptForWorkDir: () => null,
			readTranscript: () => transcript,
			now: () => "2026-07-25T00:00:00.000Z",
			...over,
		};
		return { deps, spawns, created, disposed };
	}

	function runCount(taskId: string): number {
		const row = db
			.prepare<unknown[], { n: number }>(
				"SELECT COUNT(*) AS n FROM runs WHERE task_hash = ?",
			)
			.get(taskId);
		return row?.n ?? 0;
	}

	it("records a completed run and returns its parsed cost", () => {
		const h = harness([claudeOk(), checkResult(0)]);
		const result = runOnce(db, task, definition, [], options(), h.deps);
		expect(result).toMatchObject({
			sessionId: "sess-1",
			tokens: 2000,
			completed: true,
		});
		expect(runCount("sql-01")).toBe(1);
		// The temp fixture copy is gone on the happy path.
		expect(h.disposed).toEqual(h.created);
		expect(existsSync(h.created[0] as string)).toBe(false);
	});

	it("records a passing check on a zero-token run as NOT completed", () => {
		// The `sql-01` / `backend-03` shape: a success check that passes on the
		// pristine fixture reports status 0 for a run that never reached a
		// model. Recorded as a success it becomes a zero-cost measurement no
		// environment-failure guard can see. 19 such rows are in the live
		// ledger (FINDINGS.md, 2026-08-13).
		const empty = JSON.stringify({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				content: [{ type: "text", text: "" }],
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			},
		});
		const h = harness([claudeOk(), checkResult(0)], {
			readTranscript: () => empty,
		});
		const result = runOnce(db, task, definition, [], options(), h.deps);
		expect(result).toMatchObject({ tokens: 0, completed: false });
		expect(isEnvironmentFailure(result)).toBe(true);
		const row = db
			.prepare<unknown[], { completed: number }>(
				"SELECT completed FROM runs WHERE task_hash = ?",
			)
			.get("sql-01");
		expect(row?.completed).toBe(0);
	});

	it("builds a hermetic, non-shell claude invocation with a timeout", () => {
		const h = harness([claudeOk(), checkResult(0)]);
		runOnce(db, task, definition, [], options({ model: "opus" }), h.deps);

		const claude = h.spawns[0];
		expect(claude?.command).toBe("claude");
		// The model-generated prompt is ONE argv element: no shell, so nothing in
		// it can be word-split, globbed, or interpreted as another flag's value.
		expect(claude?.args).toEqual([
			"-p",
			task.prompt,
			"--agent",
			"sql",
			"--model",
			"opus",
			"--permission-mode",
			"acceptEdits",
			"--max-turns",
			"60",
			"--output-format",
			"json",
		]);
		expect(claude?.options.cwd).toBe(h.created[0]);
		expect(claude?.options.timeout).toBeGreaterThan(0);
		expect(claude?.options.maxBuffer).toBeGreaterThan(0);
		expect(claude?.options.env?.TOKEN_WARDEN_NO_DISTILL).toBe("1");
		for (const key of SESSION_ENV_KEYS) {
			expect(claude?.options.env?.[key], key).toBeUndefined();
		}

		const check = h.spawns[1];
		expect(check?.command).toBe("bash");
		expect(check?.args).toEqual(["-c", task.successCheck]);
		expect(check?.options.timeout).toBeGreaterThan(0);
		// Regression guard for the ENOBUFS misread: the check spawn is capped
		// like the claude spawn, not left on the 1MB default.
		expect(check?.options.maxBuffer).toBe(claude?.options.maxBuffer);
	});

	it("passes an injection-shaped prompt through verbatim as a single argument", () => {
		const nasty: GoldenTask = {
			...task,
			prompt: "$(rm -rf ~); `id`; --dangerously-skip-permissions",
		};
		const h = harness([claudeOk(), checkResult(0)]);
		runOnce(db, nasty, definition, [], options(), h.deps);
		expect(h.spawns[0]?.args[1]).toBe(nasty.prompt);
		// It never becomes its own flag: it sits in the -p slot only.
		expect(h.spawns[0]?.args.filter((a) => a === nasty.prompt)).toHaveLength(1);
	});

	it("records a genuine check failure as an incomplete run, not an error", () => {
		const h = harness([claudeOk(), checkResult(1)]);
		const result = runOnce(
			db,
			task,
			definition,
			[],
			options({ recordBaselines: true }),
			h.deps,
		);
		expect(result.completed).toBe(false);
		expect(result.tokens).toBe(2000);
		// A failed run never freezes a baseline…
		expect(getBaseline(db, "sql", "sql-01")).toBeFalsy();
		// …but it IS recorded: a rule-broken run is evidence about the rule.
		expect(runCount("sql-01")).toBe(1);
	});

	// BUG FIX regression tests: a success check that could not RUN is an
	// infrastructure failure, and must never be recorded as "the task failed".
	it("throws when the success check could not be executed at all", () => {
		const h = harness([
			claudeOk(),
			checkResult(null, { error: new Error("spawnSync bash ENOENT") }),
		]);
		expect(() => runOnce(db, task, definition, [], options(), h.deps)).toThrow(
			/success check for sql-01 could not run/,
		);
		expect(runCount("sql-01")).toBe(0);
		expect(h.disposed).toEqual(h.created);
	});

	it("throws when the success check was killed before reporting (timeout, ENOBUFS)", () => {
		const h = harness([
			claudeOk(),
			checkResult(null, { signal: "SIGTERM" as NodeJS.Signals }),
		]);
		expect(() => runOnce(db, task, definition, [], options(), h.deps)).toThrow(
			/was killed before it could report/,
		);
		expect(runCount("sql-01")).toBe(0);
	});

	it("freezes a baseline only for a completed active-set run", () => {
		const h = harness([claudeOk(), checkResult(0)]);
		runOnce(
			db,
			task,
			definition,
			[],
			options({ recordBaselines: true }),
			h.deps,
		);
		expect(getBaseline(db, "sql", "sql-01")?.run1_tokens).toBe(2000);
	});

	it("never touches baselines for a candidate configuration", () => {
		const h = harness([claudeOk(), checkResult(0)]);
		runOnce(db, task, definition, [], options(), h.deps);
		expect(getBaseline(db, "sql", "sql-01")).toBeFalsy();
	});

	it("rethrows a spawn error (timeout, missing binary) and still disposes", () => {
		const boom = new Error("spawnSync claude ETIMEDOUT");
		const h = harness([claudeOk({ error: boom })]);
		expect(() => runOnce(db, task, definition, [], options(), h.deps)).toThrow(
			/ETIMEDOUT/,
		);
		expect(runCount("sql-01")).toBe(0);
		expect(h.disposed).toEqual(h.created);
		expect(existsSync(h.created[0] as string)).toBe(false);
	});

	it("reports unparseable output and a missing session id, with stderr context", () => {
		const noJson = harness([
			claudeOk({ status: 1, stdout: "not json", stderr: "quota exhausted" }),
		]);
		expect(() =>
			runOnce(db, task, definition, [], options(), noJson.deps),
		).toThrow(/unparseable output/);
		expect(() =>
			runOnce(
				db,
				task,
				definition,
				[],
				options(),
				harness([claudeOk({ stdout: JSON.stringify({ duration_ms: 1 }) })])
					.deps,
			),
		).toThrow(/no session_id/);
	});

	it("throws when the transcript for the reported session cannot be found", () => {
		const h = harness([claudeOk(), checkResult(0)], {
			findTranscript: () => null,
		});
		expect(() => runOnce(db, task, definition, [], options(), h.deps)).toThrow(
			/transcript not found for session sess-1/,
		);
		expect(runCount("sql-01")).toBe(0);
		expect(h.disposed).toEqual(h.created);
	});

	it("disposes the fixture copy even when installAgent throws before any spawn", () => {
		const h = harness([], {
			installAgent: () => {
				throw new Error("disk full");
			},
		});
		expect(() => runOnce(db, task, definition, [], options(), h.deps)).toThrow(
			/disk full/,
		);
		expect(h.spawns).toHaveLength(0);
		expect(h.disposed).toEqual(h.created);
	});

	it("tolerates a missing duration_ms (advisory latency axis only)", () => {
		const h = harness([
			claudeOk({ stdout: JSON.stringify({ session_id: "sess-2" }) }),
			checkResult(0),
		]);
		expect(runOnce(db, task, definition, [], options(), h.deps).sessionId).toBe(
			"sess-2",
		);
		const row = db
			.prepare<unknown[], { duration_ms: number | null }>(
				"SELECT duration_ms FROM runs WHERE session_id = ?",
			)
			.get("sess-2");
		expect(row?.duration_ms).toBeNull();
	});

	describe("timeout recovery (a hang must be evictable evidence, not a quota death)", () => {
		it("recovers the transcript and reports the run's REAL token cost", () => {
			// Before this, a 15-minute CLAUDE_TIMEOUT_MS kill threw, runSuite
			// synthesized { tokens: 0, completed: false }, and the <1,000-token
			// discriminator read it as an environment failure — so a rule that sent
			// the agent into an exploration loop was indistinguishable from the API
			// dying, and four such runs requeued it forever. The worst possible rule
			// could never be evicted.
			const timedOut = claudeOk({
				status: null,
				signal: "SIGTERM",
				stdout: "",
				error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
					code: "ETIMEDOUT",
				}),
			});
			const h = harness([timedOut], {
				findTranscriptForWorkDir: () => join(dir, "transcript.jsonl"),
			});

			const result = runOnce(db, task, definition, [], options(), h.deps);

			// The real cost is reported, NOT zero — this is the whole fix.
			expect(result.tokens).toBe(2000);
			expect(result.tokens).toBeGreaterThan(ENV_FAILURE_TOKEN_FLOOR);
			expect(result.completed).toBe(false);
			// Which means the discriminator classifies it as rule evidence.
			expect(isEnvironmentFailure(result)).toBe(false);
			// The run is persisted so the selector can see it.
			expect(runCount("sql-01")).toBe(1);
			// The success check is never run: the agent was killed mid-task and a
			// half-mutated fixture must not pass a check it did not earn.
			expect(h.spawns).toHaveLength(1);
			// Temp fixture copy still cleaned up.
			expect(h.disposed).toEqual(h.created);
		});

		it("still degrades to an environment failure when nothing is recoverable", () => {
			// A hang that burned NOTHING (an API stall before any turn) has no
			// transcript to recover, and must stay an environment failure.
			const timedOut = claudeOk({
				status: null,
				signal: "SIGTERM",
				stdout: "",
				error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
					code: "ETIMEDOUT",
				}),
			});
			const h = harness([timedOut], { findTranscriptForWorkDir: () => null });

			expect(() =>
				runOnce(db, task, definition, [], options(), h.deps),
			).toThrow();
			expect(runCount("sql-01")).toBe(0);
			expect(h.disposed).toEqual(h.created);
		});

		it("does not attempt recovery for a non-timeout spawn error", () => {
			// A missing `claude` binary is not a hang; recovering a transcript for
			// it would invent a measurement that never ran.
			let asked = 0;
			const failed = claudeOk({
				status: null,
				stdout: "",
				error: Object.assign(new Error("spawn claude ENOENT"), {
					code: "ENOENT",
				}),
			});
			const h = harness([failed], {
				findTranscriptForWorkDir: () => {
					asked++;
					return join(dir, "transcript.jsonl");
				},
			});

			expect(() =>
				runOnce(db, task, definition, [], options(), h.deps),
			).toThrow();
			expect(asked).toBe(0);
			expect(runCount("sql-01")).toBe(0);
		});
	});
});

describe("runSuite contract assertions", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-suite-contract-"));
		db = openDb(join(dir, "warden.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const task: GoldenTask = {
		id: "t1",
		agent: "sql",
		prompt: "do the thing",
		successCheck: "true",
		file: "t1.md",
		weight: 1,
	};
	const options = (over: Partial<SuiteOptions> = {}): SuiteOptions => ({
		rules: [],
		runs: 1,
		recordBaselines: false,
		rulesetVersion: 0,
		label: "test-pass",
		config: "candidate",
		definitionOverride: { content: "agent", model: "sonnet" },
		...over,
	});
	const never = (): RunResult => {
		throw new Error("runOnce must not be reached");
	};

	it("refuses an empty suite instead of returning an unmeasured pass", () => {
		expect(() => runSuite(db, "sql", [], options(), never as never)).toThrow(
			/no golden tasks/,
		);
	});

	it("refuses a non-positive or fractional run count", () => {
		for (const runs of [0, -1, 1.5, Number.NaN]) {
			expect(() =>
				runSuite(db, "sql", [task], options({ runs }), never as never),
			).toThrow(/runs must be a positive integer/);
		}
	});
});
