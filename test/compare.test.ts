import { describe, expect, it } from "vitest";
import {
	compareConfigs,
	formatComparison,
	poolRuns,
	type RunDatum,
	totalBenchTokens,
	type VariantRuns,
	verdictLine,
} from "../src/compare.js";

/** Build one task's runs from (processing, cacheRead, completed) triples. */
function task(
	taskId: string,
	runs: [proc: number, cacheRead: number, completed?: boolean][],
): VariantRuns {
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

const cmp = (b: VariantRuns[], c: VariantRuns[]) =>
	compareConfigs("sql", "model", "sonnet", "haiku", b, c);

describe("compareConfigs", () => {
	it("scores a clearly cheaper candidate with positive delta (direction lock)", () => {
		const baseline = [
			task("t1", [[1000, 5000]]),
			task("t2", [[2000, 5000]]),
			task("t3", [[3000, 5000]]),
		];
		// Candidate is cheaper on PROCESSING despite MORE cache-read — the
		// raw-total trap the metric is designed to avoid.
		const candidate = [
			task("t1", [[500, 9000]]),
			task("t2", [[1000, 9000]]),
			task("t3", [[1500, 9000]]),
		];
		const c = cmp(baseline, candidate);
		expect(c.delta).toBeGreaterThan(0);
		expect(c.regression).toBe(false);
		expect(c.comparableTasks).toBe(3);
		expect(verdictLine(c)).toContain("cheaper");
	});

	it("flags a regression when the candidate fails a baseline-passing task", () => {
		const c = cmp(
			[task("t1", [[1000, 0]]), task("t2", [[1000, 0]])],
			[task("t1", [[400, 0]]), task("t2", [[400, 0, false]])],
		);
		expect(c.regression).toBe(true);
		expect(verdictLine(c)).toContain("NOT a safe model change");
	});

	it("caveats a single-task comparison as indicative only (n<2)", () => {
		const c = cmp([task("t1", [[1000, 0]])], [task("t1", [[600, 0]])]);
		expect(c.comparableTasks).toBe(1);
		expect(verdictLine(c)).toContain("indicative only");
	});

	it("reports a within-noise verdict as uncertain", () => {
		const c = cmp(
			[
				task("t1", [[1000, 0]]),
				task("t2", [[1000, 0]]),
				task("t3", [[1000, 0]]),
			],
			[
				task("t1", [[1010, 0]]),
				task("t2", [[980, 0]]),
				task("t3", [[1030, 0]]),
			],
		);
		expect(c.uncertain).toBe(true);
		expect(verdictLine(c)).toContain("within measurement noise");
	});

	it("uses the dimension word in the verdict (prompt vs model)", () => {
		const promptCmp = compareConfigs(
			"sql",
			"prompt",
			"current",
			"variant",
			[task("t1", [[1000, 0]]), task("t2", [[1000, 0]])],
			[task("t1", [[400, 0]]), task("t2", [[400, 0, false]])],
		);
		expect(verdictLine(promptCmp)).toContain("NOT a safe prompt change");
	});
});

describe("poolRuns", () => {
	it("concatenates runs per task across two passes", () => {
		const pooled = poolRuns(
			[task("t1", [[1000, 0]])],
			[task("t1", [[800, 0]])],
		);
		expect(pooled[0]?.runs).toHaveLength(2);
	});
});

describe("totalBenchTokens", () => {
	it("sums total tokens across both sides", () => {
		expect(
			totalBenchTokens([task("t1", [[100, 50]])], [task("t1", [[200, 30]])]),
		).toBe(380);
	});
});

describe("formatComparison", () => {
	it("shows processing means, cache-read shares, dimension, and both caveats", () => {
		const c = cmp(
			[task("t1", [[1000, 5000]]), task("t2", [[2000, 5000]])],
			[task("t1", [[700, 8000]]), task("t2", [[1400, 8000]])],
		);
		const report = formatComparison(c);
		expect(report).toContain(
			"Model comparison — sql: haiku (candidate) vs sonnet (baseline)",
		);
		expect(report).toContain("cache-read 5,000 → 8,000");
		expect(report).toContain("token count ≠ dollar cost");
		expect(report).toContain("verdict uses processing tokens");
	});
});
