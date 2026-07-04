import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import {
	assertPosixPlatform,
	type BenchArgs,
	benchAgent,
	main,
	type runSuite,
	type TaskSummary,
} from "../src/bench.js";
import { insertRule, openDb, recordBaseline, upsertRun } from "../src/db.js";

// The spawn boundary (runSuite -> runOnce -> `claude -p`) stays real-run-only;
// these tests inject a suite stub so the CLI orchestration — task/rule
// resolution, baseline notes, meta-cost reporting — runs for real against a
// temp DB without benchmarking anything.
type Suite = typeof runSuite;

describe("bench main() orchestration", () => {
	let dir: string;
	let logSpy: MockInstance;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-bench-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	/** All console.log output for the run, joined. */
	function output(): string {
		return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
	}

	function summaryFor(taskId: string, tokens: number): TaskSummary {
		const completed = tokens > 0;
		return {
			taskId,
			results: [{ sessionId: `bench-${taskId}`, tokens, completed }],
			meanCompletedTokens: completed ? tokens : 0,
			highVariance: false,
		};
	}

	/** A suite stub returning `tokens` for every task it is asked to run. */
	function fakeSuite(tokens: number): Suite & MockInstance {
		return vi.fn(((_db, _agent, tasks) =>
			tasks.map((t) => summaryFor(t.id, tokens))) as Suite) as Suite &
			MockInstance;
	}

	function args(overrides: Partial<BenchArgs> = {}): BenchArgs {
		return { agent: "sql", rule: null, runs: 2, task: null, ...overrides };
	}

	/** A recent real-work run so meta-cost has a denominator. */
	function collectRealWork(tokens: number): void {
		const db = openDb();
		try {
			upsertRun(db, {
				agent: "sql",
				sessionId: "real-1",
				taskHash: null,
				inputTokens: tokens,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: new Date().toISOString(),
				config: "real",
			});
		} finally {
			db.close();
		}
	}

	it("benches the active set, comparing against frozen baselines", () => {
		const db = openDb();
		try {
			recordBaseline(db, "sql", "sql-01", 1000, "t");
		} finally {
			db.close();
		}
		collectRealWork(1_000_000);
		const suite = fakeSuite(900);

		main(args(), suite);

		expect(suite).toHaveBeenCalledTimes(1);
		const options = suite.mock.calls[0]?.[3];
		expect(options).toMatchObject({
			recordBaselines: true,
			label: "active-set",
			config: "active",
			runs: 2,
		});
		const out = output();
		expect(out).toContain("Benching agent=sql");
		// The baselined task reports the drift from its frozen run1…
		expect(out).toContain("sql-01: vs run1=1000 (-10.0% vs run1)");
		// …and unbaselined tasks say so instead of inventing a comparison.
		expect(out).toContain("no baseline (no completed run yet)");
		// Real work was collected, so meta-cost reports a ratio, not a warning.
		expect(out).toContain("% of the week's real-work tokens");
		expect(out).not.toContain("WARNING");
	});

	it("reports growth over run1 with a sign and n/a for a failed task", () => {
		const db = openDb();
		try {
			recordBaseline(db, "sql", "sql-01", 1000, "t");
			recordBaseline(db, "sql", "sql-02", 1000, "t");
		} finally {
			db.close();
		}
		const suite = vi.fn(((_db, _agent, tasks) =>
			tasks.map((t) =>
				// sql-01 got more expensive; sql-02 never completed (0 tokens).
				summaryFor(t.id, t.id === "sql-01" ? 1200 : 0),
			)) as Suite);

		main(args(), suite);

		const out = output();
		expect(out).toContain("sql-01: vs run1=1000 (+20.0% vs run1)");
		expect(out).toContain("sql-02: vs run1=1000 (n/a)");
	});

	it("warns when benchmarking with no collected real work to amortize it", () => {
		main(args(), fakeSuite(900));

		const out = output();
		expect(out).toContain("no real-work tokens collected in the last 7 days");
		expect(out).toContain("WARNING: Benchmarking overhead exceeded 10%");
	});

	it("narrows the suite to one task with --task and rejects unknown ids", () => {
		const suite = fakeSuite(900);
		main(args({ task: "sql-02" }), suite);
		const tasks = suite.mock.calls[0]?.[2] as Array<{ id: string }>;
		expect(tasks.map((t) => t.id)).toEqual(["sql-02"]);

		expect(() => main(args({ task: "sql-99" }), fakeSuite(900))).toThrow(
			/no task with id sql-99/,
		);
	});

	it("benches a candidate rule on top of the active set without recording baselines", () => {
		const db = openDb();
		let id: number;
		try {
			id = insertRule(db, {
				agent: "sql",
				body: "Prefer a single query over per-row lookups.",
				contextCost: 12,
				sourceRun: null,
				createdAt: "t",
			});
		} finally {
			db.close();
		}
		const suite = fakeSuite(800);

		main(args({ rule: id }), suite);

		const options = suite.mock.calls[0]?.[3] as {
			rules: Array<{ id: number }>;
			recordBaselines: boolean;
			label: string;
			config: string;
		};
		expect(options.recordBaselines).toBe(false);
		expect(options.label).toBe(`candidate-${id}`);
		expect(options.config).toBe("candidate");
		expect(options.rules.map((r) => r.id)).toContain(id);
		expect(output()).toContain(`(candidate ${id})`);
	});

	it("rejects a missing rule and a rule belonging to another agent", () => {
		const db = openDb();
		let backendRule: number;
		try {
			backendRule = insertRule(db, {
				agent: "backend",
				body: "A backend-only rule.",
				contextCost: 10,
				sourceRun: null,
				createdAt: "t",
			});
		} finally {
			db.close();
		}

		expect(() => main(args({ rule: 999 }), fakeSuite(900))).toThrow(
			/no rule with id 999/,
		);
		expect(() => main(args({ rule: backendRule }), fakeSuite(900))).toThrow(
			/belongs to agent "backend"/,
		);
	});

	it("benches every domain agent with --agent all", () => {
		const suite = fakeSuite(900);
		main(args({ agent: "all" }), suite);

		const agents = suite.mock.calls.map((c) => c[1]);
		expect([...agents].sort()).toEqual([
			"backend",
			"frontend",
			"sql",
			"testing",
		]);
	});

	it("sums bench tokens across runs for the meta-cost line", () => {
		const db = openDb();
		try {
			recordBaseline(db, "sql", "sql-01", 1000, "t");
		} finally {
			db.close();
		}
		collectRealWork(10_000);
		const dbRead = openDb();
		let benchTokens = 0;
		try {
			benchTokens = benchAgent(dbRead, "sql", args(), fakeSuite(500));
		} finally {
			dbRead.close();
		}
		// 5 golden sql tasks × 1 result × 500 tokens from the stub.
		expect(benchTokens).toBe(2500);
	});

	it("fails fast on Windows, where the fixture-copy benchmark cannot run", () => {
		const original = process.platform;
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		try {
			expect(() => assertPosixPlatform()).toThrow(/POSIX/);
		} finally {
			Object.defineProperty(process, "platform", {
				value: original,
				configurable: true,
			});
		}
		expect(() => assertPosixPlatform()).not.toThrow();
	});
});
