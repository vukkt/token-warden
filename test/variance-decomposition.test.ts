import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, upsertRun, type WardenDb } from "../src/db.js";
import {
	type AnalysisRun,
	bootstrapShares,
	burnPlan,
	candidateSubsets,
	groupIntoPasses,
	loadRuns,
	main,
	metricValue,
	type PassGroup,
	parseVarianceArgs,
	renderReport,
	subsetAtBudget,
	taskNoise,
	turnCostFit,
	varianceShares,
} from "../validation/variance-decomposition.js";

function run(over: Partial<AnalysisRun> = {}): AnalysisRun {
	return {
		id: 1,
		taskId: "t1",
		config: "candidate",
		rulesetVersion: 4,
		model: "sonnet",
		input: 1_000,
		output: 200,
		cacheCreation: 300,
		cacheRead: 8_500,
		toolCalls: 5,
		completed: true,
		...over,
	};
}

/** A pass of `values` total-token runs on one task, with cache-read carrying
 * whatever the value does not account for — the real shape of a golden run. */
function pass(taskId: string, values: number[], pass = 1): PassGroup {
	return {
		taskId,
		config: "candidate",
		rulesetVersion: 4,
		model: "sonnet",
		pass,
		runs: values.map((v, i) =>
			run({ id: i, taskId, cacheRead: v - 1_500, toolCalls: 5 }),
		),
	};
}

describe("metricValue", () => {
	it("splits the three prices apart", () => {
		const r = run();
		expect(metricValue(r, "total")).toBe(10_000);
		expect(metricValue(r, "processing")).toBe(1_500);
		// Sonnet: output 5x input, cache-write 1.25x, cache-read 0.1x. In
		// input-equivalent tokens: 1000 + 200*5 + 300*1.25 + 8500*0.1 = 3225.
		expect(metricValue(r, "costEquivalent")).toBeCloseTo(3_225, 6);
	});

	it("prices an unrecorded model at the default rather than throwing", () => {
		expect(metricValue(run({ model: "" }), "costEquivalent")).toBeCloseTo(
			3_225,
			6,
		);
	});
});

describe("groupIntoPasses", () => {
	it("separates the two arms of an A/B burn that share a ruleset version", () => {
		// runSuite order: side A runs t1,t1,t2,t2 then side B runs t1,t1,t2,t2.
		// Grouping on (task, ruleset version, model) alone would pool the arms
		// and report the treatment effect as run-to-run noise.
		const runs = [
			run({ id: 1, taskId: "t1", cacheRead: 10_000 }),
			run({ id: 2, taskId: "t1", cacheRead: 10_000 }),
			run({ id: 3, taskId: "t2", cacheRead: 20_000 }),
			run({ id: 4, taskId: "t2", cacheRead: 20_000 }),
			run({ id: 5, taskId: "t1", cacheRead: 90_000 }),
			run({ id: 6, taskId: "t1", cacheRead: 90_000 }),
			run({ id: 7, taskId: "t2", cacheRead: 80_000 }),
			run({ id: 8, taskId: "t2", cacheRead: 80_000 }),
		];
		const groups = groupIntoPasses(runs);
		expect(groups).toHaveLength(4);
		expect(groups.map((g) => `${g.taskId}#${g.pass}`)).toEqual([
			"t1#1",
			"t2#1",
			"t1#2",
			"t2#2",
		]);
		// Every arm is internally identical, so the measured noise is zero —
		// the whole spread is treatment, and the grouping did not absorb it.
		for (const t of taskNoise(groups, "total")) expect(t.variance).toBe(0);
	});

	it("keeps configurations apart even when they interleave", () => {
		const groups = groupIntoPasses([
			run({ id: 1, taskId: "t1", config: "active" }),
			run({ id: 2, taskId: "t1", config: "candidate" }),
			run({ id: 3, taskId: "t1", config: "active" }),
		]);
		expect(groups).toHaveLength(3);
		expect(groups.map((g) => g.pass)).toEqual([1, 1, 2]);
	});

	it("returns nothing for no runs", () => {
		expect(groupIntoPasses([])).toEqual([]);
	});
});

describe("taskNoise", () => {
	it("pools passes by degrees of freedom and reports the CV", () => {
		// Pass 1 deviations {-1000,+1000}, pass 2 deviations {-1000,+1000}:
		// pooled variance = (2e6 + 2e6) / 2 = 2e6, sd 1414.2.
		const groups = [
			pass("t1", [9_000, 11_000], 1),
			pass("t1", [19_000, 21_000], 2),
		];
		const [noise] = taskNoise(groups, "total");
		expect(noise?.variance).toBeCloseTo(2_000_000, 6);
		expect(noise?.n).toBe(4);
		expect(noise?.passes).toBe(2);
		expect(noise?.metricMean).toBe(15_000);
		expect(noise?.cv).toBeCloseTo(Math.sqrt(2_000_000) / 15_000, 9);
	});

	it("ignores passes too short to carry a variance", () => {
		expect(taskNoise([pass("t1", [10_000])], "total")).toEqual([]);
	});
});

describe("varianceShares", () => {
	it("splits Var(delta) in proportion to each task's variance", () => {
		expect(
			varianceShares([
				{ taskId: "a", n: 4, variance: 300 },
				{ taskId: "b", n: 4, variance: 100 },
			]),
		).toEqual([0.75, 0.25]);
	});

	it("returns zeros rather than NaN when nothing varies", () => {
		expect(varianceShares([{ taskId: "a", n: 4, variance: 0 }])).toEqual([0]);
	});
});

describe("bootstrapShares", () => {
	it("brackets the point estimate and is deterministic under a seed", () => {
		const groups = [
			pass("noisy", [50_000, 150_000, 60_000, 140_000], 1),
			pass("quiet", [50_000, 50_100, 50_050, 49_950], 1),
		];
		const a = bootstrapShares(groups, "total", 400, 7);
		const b = bootstrapShares(groups, "total", 400, 7);
		expect(a).toEqual(b);
		expect(a[0]?.taskId).toBe("noisy");
		expect(a[0]?.share).toBeGreaterThan(0.99);
		expect(a[0]?.lo).toBeLessThanOrEqual(a[0]?.share as number);
		expect(a[0]?.hi).toBeGreaterThanOrEqual(a[0]?.lo as number);
	});

	it("a different seed gives a different interval", () => {
		const groups = [
			pass("noisy", [50_000, 150_000, 60_000, 140_000], 1),
			pass("quiet", [50_000, 90_000, 50_050, 88_000], 1),
		];
		const a = bootstrapShares(groups, "total", 200, 1);
		const b = bootstrapShares(groups, "total", 200, 2);
		expect(a[0]?.share).toBe(b[0]?.share);
		expect([a[0]?.lo, a[0]?.hi]).not.toEqual([b[0]?.lo, b[0]?.hi]);
	});
});

describe("turnCostFit", () => {
	it("recovers a known per-tool-call cost exactly when the relation is linear", () => {
		const runs = [3, 4, 5, 6].map((tc, i) =>
			run({ id: i, taskId: "t1", cacheRead: 10_000 * tc, toolCalls: tc }),
		);
		const fit = turnCostFit([{ ...pass("t1", []), runs }], "total");
		expect(fit?.slope).toBeCloseTo(10_000, 6);
		expect(fit?.r2).toBeCloseTo(1, 9);
		expect(fit?.n).toBe(4);
	});

	it("centres per task, so between-task level differences do not inflate it", () => {
		// Two tasks with opposite level offsets but the same slope. Without
		// per-task centring the fit would be dominated by the offsets.
		const cheap = [2, 3].map((tc, i) =>
			run({ id: i, taskId: "cheap", cacheRead: 1_000 * tc, toolCalls: tc }),
		);
		const dear = [8, 9].map((tc, i) =>
			run({
				id: 10 + i,
				taskId: "dear",
				cacheRead: 500_000 + 1_000 * tc,
				toolCalls: tc,
			}),
		);
		const fit = turnCostFit(
			[
				{ ...pass("cheap", []), runs: cheap },
				{ ...pass("dear", []), taskId: "dear", runs: dear },
			],
			"total",
		);
		expect(fit?.slope).toBeCloseTo(1_000, 6);
		expect(fit?.r2).toBeCloseTo(1, 9);
	});

	it("is null when nothing varies", () => {
		expect(turnCostFit([pass("t1", [10_000, 10_000])], "total")).toBeNull();
		expect(turnCostFit([], "total")).toBeNull();
	});
});

describe("burnPlan", () => {
	it("bills the burn in TOTAL tokens whatever metric scores it", () => {
		const groups = [
			pass("t1", [90_000, 110_000], 1),
			pass("t2", [90_000, 110_000], 2),
		];
		const total = burnPlan(groups, "total", 14, 0.1, 5);
		const processing = burnPlan(groups, "processing", 14, 0.1, 5);
		expect(total?.tokensPerRun).toBe(processing?.tokensPerRun);
		// Processing tokens are a constant 1,500 here, so their variance is zero
		// and any positive target clears the bar at the minimum run count.
		expect(processing?.runsPerSide).toBe(2);
		expect(total?.runsPerSide).toBeGreaterThan(
			processing?.runsPerSide as number,
		);
	});

	it("is null with no usable group", () => {
		expect(burnPlan([], "total", 14, 0.1, 5)).toBeNull();
	});
});

describe("subsetAtBudget", () => {
	it("shrinks the delta with the suite, not just the standard error", () => {
		// An expensive noisy task and a cheap quiet one. Dropping the expensive
		// one drops most of the noise AND most of the signal.
		const groups = [
			pass("dear", [150_000, 250_000], 1),
			pass("cheap", [20_000, 22_000], 1),
		];
		const both = subsetAtBudget(
			groups,
			"total",
			14,
			0.1,
			20_000_000,
			["dear", "cheap"],
			"both",
		);
		const cheapOnly = subsetAtBudget(
			groups,
			"total",
			14,
			0.1,
			20_000_000,
			["cheap"],
			"cheap only",
		);
		expect(both?.targetSaving).toBeGreaterThan(
			cheapOnly?.targetSaving as number,
		);
		expect(both?.standardError).toBeGreaterThan(
			cheapOnly?.standardError as number,
		);
		// The cheap subset buys far more runs for the same tokens, so it wins on
		// the ratio — the gain is the run count, not the removed noise.
		expect(cheapOnly?.runsPerSide).toBeGreaterThan(both?.runsPerSide as number);
	});

	it("is null when the budget cannot buy two runs per side", () => {
		expect(
			subsetAtBudget(
				[pass("dear", [150_000, 250_000], 1)],
				"total",
				14,
				0.1,
				1_000,
				["dear"],
				"dear",
			),
		).toBeNull();
	});

	it("is null for a subset with no data", () => {
		expect(
			subsetAtBudget(
				[pass("t1", [10_000, 12_000], 1)],
				"total",
				14,
				0.1,
				1_000_000,
				["absent"],
				"absent",
			),
		).toBeNull();
	});
});

describe("candidateSubsets", () => {
	it("drops the largest variance contributors first", () => {
		const groups = [
			pass("loud", [50_000, 250_000], 1),
			pass("mid", [50_000, 90_000], 1),
			pass("quiet", [50_000, 51_000], 1),
			pass("quietest", [50_000, 50_100], 1),
		];
		const subsets = candidateSubsets(groups, "total");
		expect(subsets[0]?.label).toBe("whole suite");
		expect(subsets[1]?.label).toContain("loud");
		expect(subsets[1]?.taskIds).not.toContain("loud");
	});

	it("does not offer a subset with fewer than two tasks", () => {
		const subsets = candidateSubsets(
			[pass("a", [1_000, 2_000], 1), pass("b", [1_000, 3_000], 1)],
			"total",
		);
		for (const s of subsets) expect(s.taskIds.length).toBeGreaterThanOrEqual(2);
	});
});

describe("parseVarianceArgs", () => {
	it("defaults to the sql agent and the recorded window budget", () => {
		const args = parseVarianceArgs([]);
		expect(args.agent).toBe("sql");
		expect(args.dbPath).toBeNull();
		expect(args.budget).toBe(6_000_000);
	});

	it("reads every flag", () => {
		const args = parseVarianceArgs([
			"--agent",
			"backend",
			"--db",
			"/tmp/x.db",
			"--config",
			"active",
			"--rent",
			"25",
			"--effect",
			"0.2",
			"--trials",
			"100",
			"--seed",
			"9",
			"--runs",
			"3",
			"--budget",
			"1000000",
		]);
		expect(args).toMatchObject({
			agent: "backend",
			dbPath: "/tmp/x.db",
			config: "active",
			rent: 25,
			effect: 0.2,
			trials: 100,
			seed: 9,
			runs: 3,
			budget: 1_000_000,
		});
	});

	it("rejects an unknown agent, an unknown flag and a non-positive number", () => {
		expect(() => parseVarianceArgs(["--agent", "nope"])).toThrow();
		expect(() => parseVarianceArgs(["--wat"])).toThrow(/unknown flag/);
		expect(() => parseVarianceArgs(["--trials", "0"])).toThrow(/positive/);
		expect(() => parseVarianceArgs(["--rent", "junk"])).toThrow(/positive/);
	});
});

describe("loadRuns and the report", () => {
	let dir: string;
	let dbPath: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-variance-"));
		dbPath = join(dir, "warden.db");
		db = openDb(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const record = (
		taskId: string,
		session: string,
		cacheRead: number,
		toolCalls: number,
		completed = true,
	): void => {
		upsertRun(db, {
			agent: "sql",
			sessionId: session,
			taskHash: taskId,
			inputTokens: cacheRead === 0 ? 0 : 1_000,
			outputTokens: cacheRead === 0 ? 0 : 200,
			cacheCreation: cacheRead === 0 ? 0 : 300,
			cacheRead,
			toolCalls,
			fileRereads: 0,
			completed,
			rulesetVersion: 4,
			ts: "2026-08-13T00:00:00.000Z",
			config: "candidate",
			model: "sonnet",
			durationMs: 1_000,
		});
	};

	it("excludes sub-floor runs and counts them, whatever the success check said", () => {
		record("sql-01", "a", 40_000, 6);
		record("sql-01", "b", 60_000, 9);
		// A quota death that a vacuous success_check recorded as a SUCCESS: the
		// exact shape of the 19 rows on sql-01 in the live ledger.
		record("sql-01", "dead", 0, 0, true);
		const loaded = loadRuns(dbPath, "sql", null);
		expect(loaded.excluded).toBe(1);
		expect(loaded.runs).toHaveLength(2);
		expect(loaded.runs.map((r) => r.taskId)).toEqual(["sql-01", "sql-01"]);
	});

	it("filters by config and never writes to the database", () => {
		record("sql-01", "a", 40_000, 6);
		record("sql-01", "b", 60_000, 9);
		expect(loadRuns(dbPath, "sql", "candidate").runs).toHaveLength(2);
		expect(loadRuns(dbPath, "sql", "active").runs).toHaveLength(0);
		expect(loadRuns(dbPath, "backend", null).runs).toHaveLength(0);
	});

	it("renders every section on a real pool", () => {
		let n = 0;
		for (const [taskId, values] of [
			["sql-01", [4, 6, 5, 7]],
			["sql-02", [8, 9, 8, 10]],
			["sql-03", [3, 3, 4, 4]],
		] as const) {
			for (const tc of values) record(taskId, `s${n++}`, 12_000 * tc, tc);
		}
		const { runs, excluded } = loadRuns(dbPath, "sql", null);
		const text = renderReport(
			{ ...parseVarianceArgs([]), trials: 50 },
			runs,
			excluded,
		).join("\n");
		expect(text).toContain("per-task run-to-run noise");
		expect(text).toContain("share of the suite standard error");
		expect(text).toContain("one extra tool call costs");
		expect(text).toContain("the prize");
		expect(text).toContain("does removing the noisiest tasks help");
		// The seeded fixture is exactly linear in tool calls, which is the
		// mechanism claim: the fit should explain essentially all of it.
		expect(text).toMatch(/explains 100\.0% of the within-task spread/);
	});

	it("reports honestly when no configuration has repeated runs", () => {
		record("sql-01", "a", 40_000, 6);
		const { runs, excluded } = loadRuns(dbPath, "sql", null);
		const text = renderReport(parseVarianceArgs([]), runs, excluded).join("\n");
		expect(text).toContain("nothing to decompose");
	});

	it("main exits non-zero with no runs and zero with runs", () => {
		expect(main(["--db", dbPath, "--agent", "sql"])).toBe(1);
		record("sql-01", "a", 40_000, 6);
		record("sql-01", "b", 60_000, 9);
		expect(main(["--db", dbPath, "--agent", "sql", "--trials", "20"])).toBe(0);
	});
});
