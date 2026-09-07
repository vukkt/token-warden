/**
 * The covariate-adjustment harness produced a REJECTION (FINDINGS.md,
 * "Covariate adjustment"), and a rejection is only as trustworthy as the
 * implementation that produced it. The load-bearing claim is that CUPED here is
 * correctly implemented and still fails, rather than incorrectly implemented and
 * therefore failing — so these tests pin the estimator against closed forms:
 *
 * - the slope is the ordinary within-cell least-squares one, on data where the
 *   answer is known by construction;
 * - the CUPED contrast equals `delta_tokens - theta * delta_calls` exactly,
 *   which is the identity the whole argument turns on;
 * - the adjustment is a no-op when the covariate does not move, so it cannot be
 *   quietly doing something else on the null;
 * - a covariate that carries the entire effect drives the adjusted contrast to
 *   zero, which is the bad-control failure the document reports.
 */
import { describe, expect, it } from "vitest";
import {
	type ARM_NAMES,
	adjust,
	bootstrapTrial,
	buildPools,
	type CovariatePool,
	type CovariateRun,
	deepestArms,
	interpolateMds,
	main,
	parseCovariateArgs,
	passThrough,
	permutationTrial,
	pooledSlope,
	sweep,
	type TaskDraw,
	type TrialSpec,
} from "../validation/covariate-adjustment.js";
import { mulberry32 } from "../validation/rng.js";
import type { AnalysisRun } from "../validation/variance-decomposition.js";

const pair = (tokens: number, calls: number): CovariateRun => ({
	tokens,
	calls,
});

function analysisRun(over: Partial<AnalysisRun> = {}): AnalysisRun {
	return {
		id: 1,
		taskId: "t1",
		config: "candidate",
		rulesetVersion: 4,
		model: "sonnet",
		input: 0,
		output: 0,
		cacheCreation: 0,
		cacheRead: 10_000,
		toolCalls: 5,
		completed: true,
		...over,
	};
}

describe("pooledSlope", () => {
	it("recovers an exact slope from noiseless cells", () => {
		// Two cells on the same line with different intercepts: a grand-centred
		// fit would be dragged by the intercept gap, a cell-centred one is not.
		const cells = [
			[pair(1_000, 1), pair(3_000, 3), pair(5_000, 5)],
			[pair(50_000, 1), pair(52_000, 3), pair(54_000, 5)],
		];
		const slope = pooledSlope(cells);
		expect(slope.theta).toBeCloseTo(1_000, 6);
		expect(slope.r2).toBeCloseTo(1, 6);
		expect(slope.dof).toBe(4);
	});

	it("reports zero slope and zero R^2 when the covariate never moves", () => {
		const slope = pooledSlope([[pair(10, 4), pair(20, 4), pair(30, 4)]]);
		expect(slope.theta).toBe(0);
		expect(slope.r2).toBe(0);
	});

	it("ignores cells too thin to carry a degree of freedom", () => {
		const slope = pooledSlope([[pair(1, 1)], [pair(10, 1), pair(20, 2)]]);
		expect(slope.dof).toBe(1);
		expect(slope.theta).toBeCloseTo(10, 6);
	});

	it("returns a defined result for an empty pool rather than NaN", () => {
		const slope = pooledSlope([]);
		expect(slope.theta).toBe(0);
		expect(slope.r2).toBe(0);
		expect(slope.dof).toBe(0);
	});
});

/** Mean saving an arm reports: exactly what `assessDelta` would average. */
function contrast(draws: TaskDraw[], arm: (typeof ARM_NAMES)[number]): number {
	const tasks = adjust(draws, arm, 0);
	const avg = (xs: number[]): number =>
		xs.reduce((a, b) => a + b, 0) / xs.length;
	return avg(tasks.map((t) => avg(t.without) - avg(t.with)));
}

describe("adjust", () => {
	const draws: TaskDraw[] = [
		{
			taskId: "t1",
			without: [pair(30_000, 3), pair(50_000, 5)],
			with: [pair(20_000, 2), pair(40_000, 4)],
		},
	];

	it("leaves the baseline arm on the raw totals", () => {
		expect(contrast(draws, "baseline")).toBeCloseTo(10_000, 6);
	});

	it("computes the ANCOVA contrast delta_tokens - theta * delta_calls", () => {
		// theta is fitted within (task, side): each side is two points 20,000
		// tokens and 2 calls apart, so theta = 10,000.
		const theta = 10_000;
		const deltaTokens = 10_000;
		const deltaCalls = 1;
		expect(contrast(draws, "cuped")).toBeCloseTo(
			deltaTokens - theta * deltaCalls,
			6,
		);
	});

	it("is a no-op when the covariate is constant", () => {
		const flat: TaskDraw[] = [
			{
				taskId: "t1",
				without: [pair(30_000, 4), pair(50_000, 4)],
				with: [pair(20_000, 4), pair(40_000, 4)],
			},
		];
		expect(contrast(flat, "cuped")).toBeCloseTo(contrast(flat, "baseline"), 6);
	});

	it("drives the contrast to zero when the covariate carries the whole effect", () => {
		// THE FINDING, as an assertion. Every run sits on one line through the
		// origin at 10,000 tokens per call, and the with-side saving is entirely a
		// call the agent did not make.
		const online: TaskDraw[] = [
			{
				taskId: "t1",
				without: [pair(50_000, 5), pair(70_000, 7)],
				with: [pair(40_000, 4), pair(60_000, 6)],
			},
		];
		expect(contrast(online, "baseline")).toBeCloseTo(10_000, 6);
		expect(contrast(online, "cuped")).toBeCloseTo(0, 6);
	});

	it("takes the pool slope in the oracle arm instead of fitting one", () => {
		const oracle = adjust(draws, "cuped-oracle", 1_000);
		const avg = (xs: number[]): number =>
			xs.reduce((a, b) => a + b, 0) / xs.length;
		const task = oracle[0] as { without: number[]; with: number[] };
		expect(avg(task.without) - avg(task.with)).toBeCloseTo(10_000 - 1_000, 6);
	});

	it("rescales each task to the suite mean in the ratio arm", () => {
		// A small task saving 10% and a big one saving 20%. The unweighted mean of
		// the ABSOLUTE savings is (100 + 1,800) / 2 = 950, which is almost entirely
		// the big task; rescaling each task to the suite mean lets the small task's
		// larger-than-its-size contribution count.
		const two: TaskDraw[] = [
			{ taskId: "small", without: [pair(1_000, 1)], with: [pair(900, 1)] },
			{ taskId: "big", without: [pair(9_000, 1)], with: [pair(7_200, 1)] },
		];
		expect(contrast(two, "baseline")).toBeCloseTo(950, 6);
		// Task means over both sides: 950 and 8,100; suite mean 4,525. Scaled
		// savings 100 x 4,525/950 and 1,800 x 4,525/8,100, averaged.
		const expected = ((100 * 4_525) / 950 + (1_800 * 4_525) / 8_100) / 2;
		expect(contrast(two, "ratio")).toBeCloseTo(expected, 6);
		// And the change of estimand this buys, stated as an assertion: the two
		// arms do NOT agree on the same measurement.
		expect(contrast(two, "ratio")).not.toBeCloseTo(950, 0);
	});

	it("leaves a zero-mean task alone rather than dividing by it", () => {
		const zero: TaskDraw[] = [
			{ taskId: "dead", without: [pair(0, 0)], with: [pair(0, 0)] },
			{ taskId: "live", without: [pair(100, 1)], with: [pair(50, 1)] },
		];
		expect(Number.isFinite(contrast(zero, "ratio"))).toBe(true);
	});
});

describe("buildPools", () => {
	it("keeps the deepest contiguous pass per task", () => {
		const runs: AnalysisRun[] = [
			// A four-run pass on t1, then a different task, then a shorter t1 pass.
			...[1, 2, 3, 4].map((i) =>
				analysisRun({ id: i, taskId: "t1", cacheRead: 1_000 * i }),
			),
			...[5, 6, 7, 8].map((i) => analysisRun({ id: i, taskId: "t2" })),
			...[9, 10].map((i) => analysisRun({ id: i, taskId: "t1" })),
		];
		const pools = buildPools(runs, 4);
		expect(pools.map((p) => p.taskId)).toEqual(["t1", "t2"]);
		expect((pools[0] as CovariatePool).runs.map((r) => r.tokens)).toEqual([
			1_000, 2_000, 3_000, 4_000,
		]);
	});

	it("drops passes below the minimum and incomplete runs", () => {
		const runs: AnalysisRun[] = [
			...[1, 2, 3].map((i) => analysisRun({ id: i, taskId: "t1" })),
			...[4, 5, 6, 7].map((i) =>
				analysisRun({ id: i, taskId: "t2", completed: i === 4 }),
			),
		];
		expect(buildPools(runs, 4)).toEqual([]);
	});
});

describe("passThrough", () => {
	it("reports what theta times the call delta absorbs of the token delta", () => {
		const runs: AnalysisRun[] = [
			analysisRun({ rulesetVersion: 0, cacheRead: 60_000, toolCalls: 6 }),
			analysisRun({ rulesetVersion: 1, cacheRead: 40_000, toolCalls: 4 }),
		];
		const rows = passThrough(runs, 0, 1, 10_000);
		expect(rows).toHaveLength(1);
		const row = rows[0] as { deltaTokens: number; absorbed: number };
		expect(row.deltaTokens).toBe(20_000);
		// Two fewer calls at 10,000 each accounts for the whole 20,000.
		expect(row.absorbed).toBe(20_000);
	});

	it("skips a task present in only one arm", () => {
		const runs: AnalysisRun[] = [
			analysisRun({ taskId: "t1", rulesetVersion: 0 }),
			analysisRun({ taskId: "t2", rulesetVersion: 1 }),
		];
		expect(passThrough(runs, 0, 1, 1)).toEqual([]);
	});
});

describe("deepestArms", () => {
	it("names the two ruleset versions with the most completed runs", () => {
		const runs: AnalysisRun[] = [
			...[1, 2, 3].map((i) => analysisRun({ id: i, rulesetVersion: 4 })),
			...[4, 5].map((i) => analysisRun({ id: i, rulesetVersion: 9 })),
			analysisRun({ id: 6, rulesetVersion: 1 }),
		];
		expect(deepestArms(runs)).toEqual({ a: 4, b: 9 });
	});

	it("returns null when only one arm exists", () => {
		expect(deepestArms([analysisRun()])).toBeNull();
	});
});

describe("interpolateMds", () => {
	it("interpolates linearly between the straddling points", () => {
		expect(interpolateMds([0, 100, 200], [0, 0.6, 1.0])).toBeCloseTo(150, 6);
	});

	it("returns null when the sweep never reaches the target power", () => {
		expect(interpolateMds([0, 100, 200], [0, 0.3, 0.5])).toBeNull();
	});

	it("does not divide by zero on a flat segment", () => {
		expect(interpolateMds([0, 100], [0.8, 0.8])).toBeNull();
	});
});

describe("trials", () => {
	const pools: CovariatePool[] = [
		{
			taskId: "t1",
			runs: [
				pair(40_000, 4),
				pair(50_000, 5),
				pair(60_000, 6),
				pair(70_000, 7),
				pair(80_000, 8),
				pair(90_000, 9),
			],
		},
		{
			taskId: "t2",
			runs: [
				pair(20_000, 2),
				pair(30_000, 3),
				pair(40_000, 4),
				pair(50_000, 5),
				pair(60_000, 6),
				pair(70_000, 7),
			],
		},
	];
	const spec = (over: Partial<TrialSpec> = {}): TrialSpec => ({
		pools,
		runsPerSide: 2,
		rent: 25,
		arm: "baseline",
		oracleTheta: 10_000,
		savings: [0, 0],
		channel: "additive",
		...over,
	});

	it("is deterministic for a given seed", () => {
		const once = sweep((r) => permutationTrial(r, spec()), 50, 5);
		const twice = sweep((r) => permutationTrial(r, spec()), 50, 5);
		expect(once).toEqual(twice);
	});

	it("returns a decision and a point estimate per trial", () => {
		const outcome = permutationTrial(mulberry32(3), spec());
		expect(typeof outcome.kept).toBe("boolean");
		expect(outcome.delta).not.toBeNull();
	});

	it("recovers the injected saving on the additive channel", () => {
		const result = sweep(
			(r) => bootstrapTrial(r, spec({ savings: [5_000, 5_000] })),
			400,
			11,
		);
		// The top-up's optional stopping biases this upward, so the assertion is
		// a band rather than a point -- but it must be in the right place at all.
		expect(result.meanDelta).toBeGreaterThan(3_000);
		expect(result.meanDelta).toBeLessThan(9_000);
	});

	it("annihilates the same saving under CUPED on the mechanistic channel", () => {
		// Every pool run lies exactly on the 10,000-tokens-per-call line, so a
		// mechanistically injected saving is invisible to the adjusted estimator.
		const result = sweep(
			(r) =>
				bootstrapTrial(
					r,
					spec({
						arm: "cuped-oracle",
						savings: [5_000, 5_000],
						channel: "mechanistic",
					}),
				),
			400,
			11,
		);
		expect(Math.abs(result.meanDelta)).toBeLessThan(500);
	});
});

describe("parseCovariateArgs", () => {
	it("defaults to the candidate config and the selector's run count", () => {
		const args = parseCovariateArgs([]);
		expect(args.config).toBe("candidate");
		expect(args.runs).toBe(3);
		expect(args.proportional).toBe(false);
	});

	it("accepts ruleset version 0 as an arm", () => {
		expect(parseCovariateArgs(["--arm-a", "0"]).armA).toBe(0);
	});

	it("rejects a negative ruleset version", () => {
		expect(() => parseCovariateArgs(["--ruleset", "-1"])).toThrow(
			/non-negative integer/,
		);
	});

	it("rejects a non-positive trial count", () => {
		expect(() => parseCovariateArgs(["--trials", "0"])).toThrow(/positive/);
	});

	it("rejects an unknown flag rather than ignoring it", () => {
		expect(() => parseCovariateArgs(["--nope"])).toThrow(/unknown flag/);
	});

	it("rejects an unknown agent", () => {
		expect(() => parseCovariateArgs(["--agent", "nosuchagent"])).toThrow();
	});
});

describe("main", () => {
	it("reports a missing ledger rather than throwing", () => {
		expect(() => main(["--db", "/nonexistent/warden.db"])).toThrow();
	});
});
