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

// The benchmark boundary: runSuite spawns `claude` and runs the golden suite.
// We replace it with a mock that writes canned runs rows into the live DB and
// returns matching TaskSummary[], so the real comparison engine
// (runComparison -> gatherRuns -> getRunBySession) finds our token data without
// any benchmark executing. Everything else in modelbench's main() — loading the
// agent definition, golden tasks, active rules, scoring, and reporting — runs
// for real against a temp DB.
vi.mock("../src/bench.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/bench.js")>();
	return { ...actual, runSuite: vi.fn() };
});

import { runSuite, type TaskSummary } from "../src/bench.js";
import { openDb, upsertRun } from "../src/db.js";
import { main } from "../src/modelbench.js";

const runSuiteMock = runSuite as unknown as MockInstance;

describe("modelbench main() orchestration", () => {
	let dir: string;
	let logSpy: MockInstance;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-modelbench-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		runSuiteMock.mockReset();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		process.env.TOKEN_WARDEN_DB = undefined;
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	/** All console.log output for the run, joined. */
	function output(): string {
		return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
	}

	let session = 0;
	/**
	 * Write a real runs row for `(taskId, tokens, completed)` into the live DB
	 * and return a one-result TaskSummary pointing at it. gatherRuns reads the
	 * row back by session id, so this is how a mocked runSuite controls the
	 * processing-token cost of a side.
	 */
	function summaryFor(
		taskId: string,
		tokens: number,
		completed: boolean,
	): TaskSummary {
		session++;
		const sessionId = `modelbench-s-${session}`;
		const db = openDb();
		try {
			upsertRun(db, {
				agent: "sql",
				sessionId,
				taskHash: taskId,
				inputTokens: tokens,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed,
				rulesetVersion: 0,
				ts: new Date().toISOString(),
				config: "modelbench",
			});
		} finally {
			db.close();
		}
		return {
			taskId,
			results: [{ sessionId, tokens, completed }],
			meanCompletedTokens: completed ? tokens : 0,
			highVariance: false,
		};
	}

	/**
	 * Drive runSuite by the `model` it is asked to run (set by modelbench's
	 * runModel closure). The baseline pass requests the agent's default model
	 * (sonnet for sql); the candidate pass requests the --model id. We key on
	 * the model so baseline/candidate token costs are controlled independently
	 * of the "baseline"/"candidate" progress label. failedTasks names tasks the
	 * candidate fails.
	 */
	function wireRunSuite(
		candidateModel: string,
		baseline: Record<string, number>,
		candidate: Record<string, number>,
		failedTasks: ReadonlySet<string> = new Set(),
	): void {
		runSuiteMock.mockImplementation(
			(
				_db: unknown,
				_agent: unknown,
				tasks: Array<{ id: string }>,
				options: { model: string },
			): TaskSummary[] => {
				const isCandidate = options.model === candidateModel;
				return tasks.map((t) => {
					if (isCandidate) {
						return summaryFor(
							t.id,
							candidate[t.id] ?? 0,
							!failedTasks.has(t.id),
						);
					}
					return summaryFor(t.id, baseline[t.id] ?? 0, true);
				});
			},
		);
	}

	it("reports a cheaper candidate with no regression as a win", () => {
		// haiku ~40% cheaper than sonnet across all three sql golden tasks, all
		// passing.
		wireRunSuite(
			"haiku",
			{ "sql-01": 1000, "sql-02": 2000, "sql-03": 3000 },
			{ "sql-01": 600, "sql-02": 1200, "sql-03": 1800 },
		);

		main({
			agent: "sql",
			model: "haiku",
			baseline: null,
			runs: 2,
			topUp: 1,
			task: null,
		});

		const out = output();
		expect(out).toContain("Model-bench agent=sql: haiku vs sonnet");
		expect(out).toContain("cheaper for this workload on token count");
		expect(out).not.toContain("more expensive");
		expect(out).not.toContain("NOT a safe");
		// The meta-cost line is reported.
		expect(out).toContain("Meta-cost:");
		// A benchmark "ran" — the boundary was mocked, not the orchestration.
		expect(runSuiteMock).toHaveBeenCalled();
	});

	it("reports a regression as unsafe regardless of tokens", () => {
		// haiku would be cheaper, but it fails sql-02 that sonnet completed.
		wireRunSuite(
			"haiku",
			{ "sql-01": 1000, "sql-02": 1000, "sql-03": 1000 },
			{ "sql-01": 400, "sql-02": 400, "sql-03": 400 },
			new Set(["sql-02"]),
		);

		main({
			agent: "sql",
			model: "haiku",
			baseline: null,
			runs: 2,
			topUp: 0,
			task: null,
		});

		const out = output();
		expect(out).toContain(
			"NOT a safe model change for sql regardless of tokens",
		);
		expect(out).not.toContain("cheaper for this workload");
	});

	it("reports a within-noise comparison as no clear difference", () => {
		// Per-task costs jitter around equal — the delta is tiny next to genuine
		// run-to-run noise, so the verdict lands within measurement noise. The
		// top-up pass returns *different* values from the first (as real runs do),
		// giving the within-task estimator real noise to measure against; with
		// identical duplicate passes the variance would be a misleading zero.
		const baselineP1 = { "sql-01": 950, "sql-02": 1050, "sql-03": 950 };
		const baselineTU = { "sql-01": 1050, "sql-02": 950, "sql-03": 1050 };
		const candidateP1 = { "sql-01": 1060, "sql-02": 970, "sql-03": 1080 };
		const candidateTU = { "sql-01": 960, "sql-02": 990, "sql-03": 980 };
		runSuiteMock.mockImplementation(
			(
				_db: unknown,
				_agent: unknown,
				tasks: Array<{ id: string }>,
				options: { model: string; label: string },
			): TaskSummary[] => {
				const isCandidate = options.model === "haiku";
				const isTopUp = options.label.endsWith("-topup");
				const map = isCandidate
					? isTopUp
						? candidateTU
						: candidateP1
					: isTopUp
						? baselineTU
						: baselineP1;
				return tasks.map((t) =>
					summaryFor(t.id, map[t.id as keyof typeof map] ?? 0, true),
				);
			},
		);

		main({
			agent: "sql",
			model: "haiku",
			baseline: null,
			runs: 2,
			topUp: 1,
			task: null,
		});

		const out = output();
		expect(out).toContain("within measurement noise");
		// topUp=1 + an uncertain verdict spends a variance top-up pass.
		expect(out).toContain("variance top-up pass");
	});

	it("rejects comparing a model against itself before any benchmark runs", () => {
		expect(() =>
			main({
				agent: "sql",
				model: "sonnet",
				baseline: null,
				runs: 2,
				topUp: 1,
				task: null,
			}),
		).toThrow(/nothing to compare/);
		expect(runSuiteMock).not.toHaveBeenCalled();
	});

	it("narrows the suite to a single task via --task", () => {
		wireRunSuite("haiku", { "sql-02": 2000 }, { "sql-02": 1200 });

		main({
			agent: "sql",
			model: "haiku",
			baseline: null,
			runs: 2,
			topUp: 0,
			task: "sql-02",
		});

		const out = output();
		// Only one task completes in both → indicative-only caveat, and the per
		// task report mentions sql-02 only.
		expect(out).toContain("sql-02");
		expect(out).not.toContain("sql-01");
		expect(out).toContain("indicative only");
	});

	it("rejects an unknown --task before any benchmark runs", () => {
		expect(() =>
			main({
				agent: "sql",
				model: "haiku",
				baseline: null,
				runs: 2,
				topUp: 0,
				task: "sql-99",
			}),
		).toThrow(/no task with id sql-99/);
		expect(runSuiteMock).not.toHaveBeenCalled();
	});

	it("sweeps every suite with --agent all and rolls regressions up by category", () => {
		// haiku is cheaper on every task but fails testing-02.
		runSuiteMock.mockImplementation(
			(
				_db: unknown,
				_agent: unknown,
				tasks: Array<{ id: string }>,
				options: { model: string },
			): TaskSummary[] => {
				const isCandidate = options.model === "haiku";
				return tasks.map((t) =>
					summaryFor(
						t.id,
						isCandidate ? 600 : 1000,
						!(isCandidate && t.id === "testing-02"),
					),
				);
			},
		);

		main({
			agent: "all",
			model: "haiku",
			baseline: null,
			runs: 2,
			topUp: 0,
			task: null,
		});

		const out = output();
		expect(out).toContain("Regression by category:");
		expect(out).toContain("testing: REGRESSED — testing-02");
		expect(out).toContain("backend: none");
		expect(out).toContain("frontend: none");
		expect(out).toContain("sql: none");
		expect(out).toContain("NOT a safe change for the regressed categories");
		// One combined meta-cost line for the sweep, not one per agent.
		expect(out.match(/Meta-cost:/g)).toHaveLength(1);
	});

	it("--agent all throws when every baseline already matches the candidate", () => {
		expect(() =>
			main({
				agent: "all",
				model: "sonnet",
				baseline: null,
				runs: 2,
				topUp: 0,
				task: null,
			}),
		).toThrow(/nothing to compare/);
		expect(runSuiteMock).not.toHaveBeenCalled();
	});
});
