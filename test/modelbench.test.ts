import { describe, expect, it } from "vitest";
import {
	compareRuns,
	formatComparison,
	type ModelRuns,
	parseModelbenchArgs,
	poolRuns,
	type RunDatum,
	verdictLine,
} from "../src/modelbench.js";

/** Build one task's runs from (processing, cacheRead, completed) triples. */
function task(
	taskId: string,
	runs: [proc: number, cacheRead: number, completed?: boolean][],
): ModelRuns {
	return {
		taskId,
		runs: runs.map(
			([proc, cacheRead, completed = true]): RunDatum => ({
				processingTokens: proc,
				cacheRead,
				totalTokens: proc + cacheRead,
				completed,
			}),
		),
	};
}

describe("parseModelbenchArgs", () => {
	it("parses agent, model, and defaults", () => {
		expect(parseModelbenchArgs(["--agent", "sql", "--model", "haiku"])).toEqual(
			{
				agent: "sql",
				model: "haiku",
				baseline: null,
				runs: 2,
				topUp: 1,
				task: null,
			},
		);
	});

	it("parses overrides", () => {
		expect(
			parseModelbenchArgs([
				"--agent",
				"backend",
				"--model",
				"opus",
				"--baseline",
				"sonnet",
				"--runs",
				"3",
				"--top-up",
				"0",
				"--task",
				"backend-01",
			]),
		).toEqual({
			agent: "backend",
			model: "opus",
			baseline: "sonnet",
			runs: 3,
			topUp: 0,
			task: "backend-01",
		});
	});

	it("rejects bad input", () => {
		expect(() =>
			parseModelbenchArgs(["--agent", "main", "--model", "x"]),
		).toThrow(/--agent/);
		expect(() => parseModelbenchArgs(["--agent", "sql"])).toThrow(/--model/);
		expect(() =>
			parseModelbenchArgs(["--agent", "sql", "--model", "x", "--runs", "0"]),
		).toThrow(/--runs/);
		expect(() =>
			parseModelbenchArgs(["--agent", "sql", "--model", "x", "--top-up", "-1"]),
		).toThrow(/--top-up/);
		expect(() =>
			parseModelbenchArgs(["--agent", "sql", "--model", "x", "--bogus"]),
		).toThrow(/unknown flag/);
	});
});

describe("compareRuns", () => {
	it("scores a clearly cheaper candidate with positive delta (direction lock)", () => {
		// Candidate uses half the processing tokens on every task.
		const baseline = [
			task("t1", [[1000, 5000]]),
			task("t2", [[2000, 5000]]),
			task("t3", [[3000, 5000]]),
		];
		const candidate = [
			task("t1", [[500, 9000]]), // cheaper on processing despite MORE cache-read
			task("t2", [[1000, 9000]]),
			task("t3", [[1500, 9000]]),
		];
		const cmp = compareRuns("sql", "sonnet", "haiku", baseline, candidate);
		// delta = baseline processing − candidate processing, positive ⇒ cheaper.
		expect(cmp.delta).toBeGreaterThan(0);
		expect(cmp.regression).toBe(false);
		expect(cmp.comparableTasks).toBe(3);
		// The raw-total trap: candidate's totals are HIGHER (cache-read heavy),
		// but the verdict is on processing tokens, so it still reads cheaper.
		expect(verdictLine(cmp)).toContain("cheaper");
	});

	it("flags a regression when the candidate fails a baseline-passing task", () => {
		const baseline = [task("t1", [[1000, 0]]), task("t2", [[1000, 0]])];
		const candidate = [
			task("t1", [[400, 0]]),
			task("t2", [[400, 0, false]]), // failed
		];
		const cmp = compareRuns("sql", "sonnet", "opus", baseline, candidate);
		expect(cmp.regression).toBe(true);
		expect(verdictLine(cmp)).toContain("NOT a safe switch");
	});

	it("caveats a single-task comparison as indicative only (n<2)", () => {
		const cmp = compareRuns(
			"sql",
			"sonnet",
			"haiku",
			[task("t1", [[1000, 0]])],
			[task("t1", [[600, 0]])],
		);
		expect(cmp.comparableTasks).toBe(1);
		expect(verdictLine(cmp)).toContain("indicative only");
	});

	it("reports a within-noise verdict as uncertain", () => {
		// Tiny, inconsistent differences → |Δ| < standard error.
		const baseline = [
			task("t1", [[1000, 0]]),
			task("t2", [[1000, 0]]),
			task("t3", [[1000, 0]]),
		];
		const candidate = [
			task("t1", [[1010, 0]]),
			task("t2", [[980, 0]]),
			task("t3", [[1030, 0]]),
		];
		const cmp = compareRuns("sql", "sonnet", "haiku", baseline, candidate);
		expect(cmp.uncertain).toBe(true);
		expect(verdictLine(cmp)).toContain("within measurement noise");
	});
});

describe("poolRuns", () => {
	it("concatenates runs per task across two passes", () => {
		const first = [task("t1", [[1000, 0]])];
		const second = [task("t1", [[800, 0]])];
		const pooled = poolRuns(first, second);
		expect(pooled[0]?.runs).toHaveLength(2);
	});
});

describe("formatComparison", () => {
	it("shows processing means, cache-read shares, and both caveats", () => {
		const cmp = compareRuns(
			"sql",
			"sonnet",
			"haiku",
			[task("t1", [[1000, 5000]]), task("t2", [[2000, 5000]])],
			[task("t1", [[700, 8000]]), task("t2", [[1400, 8000]])],
		);
		const report = formatComparison(cmp);
		expect(report).toContain("candidate) vs sonnet (baseline)");
		expect(report).toContain("cache-read 5,000 → 8,000");
		expect(report).toContain("token count ≠ dollar cost");
		expect(report).toContain("verdict uses processing tokens");
	});
});
