/**
 * PINS THE PUBLISHED VARIANCE NUMBERS.
 *
 * Every figure in FINDINGS.md's "Where the variance actually lives" section is
 * asserted here against a frozen extract of the runs it was computed from
 * (test/fixtures/sql-compression-burn-1.json: all 168 rows the selector
 * recorded for compression burn 1, agent `sql`, config `candidate`, ruleset
 * version 4, 2026-07-08). If an estimator changes, these fail and the document
 * gets corrected in the same commit.
 *
 * This exists because of a failure this project has already had: a published
 * headline number was wrong for weeks while an accurate caveat travelled
 * beside it, because no test pinned any published number. A caveat is not a
 * check.
 *
 * The fixture is a static artifact, not a live read. Tests must never touch
 * `~/.token-warden` (test/setup.ts enforces that), and pinning against a
 * moving ledger would not pin anything anyway.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_FAILURE_TOKEN_FLOOR } from "../src/bench.js";
import {
	type AnalysisRun,
	armDelta,
	bootstrapShares,
	burnPlan,
	groupIntoPasses,
	metricValue,
	type PassGroup,
	subsetAtBudget,
	taskNoise,
	turnCostFit,
} from "../validation/variance-decomposition.js";

const RAW: AnalysisRun[] = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("./fixtures/sql-compression-burn-1.json", import.meta.url),
		),
		"utf8",
	),
);

/** The same filter `loadRuns` applies: a run that spent nothing measured
 * nothing. Kept in the fixture so the exclusion count is pinned too. */
const RUNS = RAW.filter(
	(r) => metricValue(r, "total") >= ENV_FAILURE_TOKEN_FLOOR,
);
const GROUPS: PassGroup[] = groupIntoPasses(RUNS).filter(
	(g) => g.runs.length >= 2,
);

/** The rent of the compressed candidate, per FINDINGS: rule 4 at rent 28 was
 * rewritten to rule 5 at rent 14. */
const RENT = 14;
/** The compression point estimate FINDINGS records, as a fraction of the
 * suite's mean run: 10,851 / 100,702. */
const EFFECT = 0.108;

describe("the recorded pool", () => {
	it("is the burn FINDINGS describes: 168 rows, 53 dead, 115 usable", () => {
		expect(RAW).toHaveLength(168);
		expect(RAW.length - RUNS.length).toBe(53);
		expect(RUNS).toHaveLength(115);
	});

	it("carries the 7 zero-token runs a vacuous success check banked as passes", () => {
		// The defect fd20b72 closed, preserved as evidence. Every one is sql-01,
		// whose check passes on the pristine fixture; no other task has any.
		const fakes = RAW.filter(
			(r) => r.completed && metricValue(r, "total") < ENV_FAILURE_TOKEN_FLOOR,
		);
		expect(fakes).toHaveLength(7);
		expect(new Set(fakes.map((r) => r.taskId))).toEqual(new Set(["sql-01"]));
	});

	it("bias they caused on sql-01: recorded mean 46,815 vs true 70,855", () => {
		const sql01 = RAW.filter((r) => r.taskId === "sql-01" && r.completed);
		// The whole ledger's sql-01 candidate pool is 56 completed rows across
		// both burns; this fixture is burn 1 alone, so assert the same DIRECTION
		// and magnitude of bias on the rows it holds rather than the headline.
		const withDead =
			sql01.reduce((a, r) => a + metricValue(r, "total"), 0) / sql01.length;
		const live = sql01.filter(
			(r) => metricValue(r, "total") >= ENV_FAILURE_TOKEN_FLOOR,
		);
		const withoutDead =
			live.reduce((a, r) => a + metricValue(r, "total"), 0) / live.length;
		expect(Math.round(withDead)).toBe(60_582);
		expect(Math.round(withoutDead)).toBe(82_901);
		// A 27% downward bias on this task, from 7 rows out of 26.
		expect((withoutDead - withDead) / withoutDead).toBeCloseTo(0.269, 2);
	});

	it("splits into the two 8-runs-per-side arms plus the aborted third pass", () => {
		const passes = new Map<number, number>();
		for (const g of GROUPS) passes.set(g.pass, (passes.get(g.pass) ?? 0) + 1);
		// Passes 1 and 2 cover all 7 tasks; pass 3 died after sql-01.
		expect(passes.get(1)).toBe(7);
		expect(passes.get(2)).toBe(7);
		expect(passes.get(3)).toBe(1);
	});
});

describe("published: per-task noise (FINDINGS table 1)", () => {
	const expected: Record<string, [number, number, number]> = {
		// task: [total SD, processing SD, cost-equivalent SD]
		"sql-01": [35_013, 2_401, 7_020],
		"sql-02": [22_253, 793, 4_188],
		"sql-03": [64_745, 1_902, 11_084],
		"sql-04": [48_978, 1_318, 8_020],
		"sql-05": [59_469, 1_562, 10_134],
		"sql-06": [11_333, 308, 1_885],
		"sql-07": [15_790, 850, 3_259],
	};

	it.each(
		Object.entries(expected),
	)("%s standard deviations are unchanged", (taskId, [
		total,
		processing,
		costEquivalent,
	]) => {
		const sd = (metric: "total" | "processing" | "costEquivalent") =>
			Math.round(
				Math.sqrt(
					taskNoise(GROUPS, metric).find((t) => t.taskId === taskId)
						?.variance as number,
				),
			);
		expect(sd("total")).toBe(total);
		expect(sd("processing")).toBe(processing);
		expect(sd("costEquivalent")).toBe(costEquivalent);
	});

	it("total-token CV spans 18.3% to 48.8%; processing 4.5% to 26.6%", () => {
		const cvs = (metric: "total" | "processing") =>
			taskNoise(GROUPS, metric)
				.map((t) => Number((100 * t.cv).toFixed(1)))
				.sort((a, b) => a - b);
		const total = cvs("total");
		const processing = cvs("processing");
		expect([total[0], total[total.length - 1]]).toEqual([18.3, 48.8]);
		expect([processing[0], processing[processing.length - 1]]).toEqual([
			4.5, 26.6,
		]);
	});

	it("cache-read is 85-95% of every task's recorded cost", () => {
		for (const t of taskNoise(GROUPS, "total")) {
			const runs = RUNS.filter((r) => r.taskId === t.taskId);
			const share =
				runs.reduce((a, r) => a + r.cacheRead, 0) /
				runs.reduce((a, r) => a + metricValue(r, "total"), 0);
			expect(share, t.taskId).toBeGreaterThan(0.85);
			expect(share, t.taskId).toBeLessThan(0.955);
		}
	});
});

describe("published: variance shares (FINDINGS table 2)", () => {
	it("the top three tasks carry 82.8% of the total-token variance", () => {
		const shares = bootstrapShares(GROUPS, "total", 200, 1);
		const top3 = shares.slice(0, 3).reduce((a, s) => a + s.share, 0);
		expect(Number((100 * top3).toFixed(1))).toBe(82.8);
		expect(
			shares
				.slice(0, 3)
				.map((s) => s.taskId)
				.sort(),
		).toEqual(["sql-03", "sql-04", "sql-05"]);
	});

	it("the point shares do not depend on the bootstrap at all", () => {
		// The share is a property of the pool; only the INTERVAL is resampled.
		// This is why the published shares are stable from 400 to 20,000 trials.
		const a = bootstrapShares(GROUPS, "total", 50, 1).map((s) => s.share);
		const b = bootstrapShares(GROUPS, "total", 4_000, 99).map((s) => s.share);
		expect(a).toEqual(b);
	});

	it("no single task's share is resolved: every 95% interval is wide", () => {
		// The honest half of the finding. "The top three dominate" is supported;
		// "sql-03 is the worst" is not, and the interval is why.
		const shares = bootstrapShares(GROUPS, "total", 4_000, 1);
		const worst = shares[0];
		expect(worst?.taskId).toBe("sql-03");
		expect((worst?.hi as number) - (worst?.lo as number)).toBeGreaterThan(0.3);
		// Its interval overlaps the runner-up's, so the ranking is not decided.
		expect(worst?.lo).toBeLessThan(shares[1]?.hi as number);
	});
});

describe("published: the mechanism (FINDINGS table 3)", () => {
	it("tool-call count explains 94.6% of the within-task spread in total tokens", () => {
		const fit = turnCostFit(GROUPS, "total");
		expect(fit?.n).toBe(115);
		expect(Number((100 * (fit?.r2 as number)).toFixed(1))).toBe(94.6);
		expect(Math.round(fit?.slope as number)).toBe(14_018);
	});

	it("one extra tool call costs 14,018 total but only 428 processing tokens", () => {
		expect(Math.round(turnCostFit(GROUPS, "processing")?.slope as number)).toBe(
			428,
		);
		const costEq = Math.round(
			turnCostFit(GROUPS, "costEquivalent")?.slope as number,
		);
		expect(costEq).toBe(2_446);
		// The gate's metric prices an agentic turn at 5.7x its real cost.
		expect(14_018 / costEq).toBeCloseTo(5.73, 1);
	});

	it("turn-count CV is flat across tasks of very different sizes", () => {
		// The load-bearing claim: the noise is the AGENT's, not any task's. If
		// the CV tracked task size, task redesign would be a lever.
		const turns = taskNoise(GROUPS, "toolCalls");
		const means = turns.map((t) => t.metricMean);
		const cvs = turns.map((t) => t.cv);
		expect(Math.min(...means)).toBeCloseTo(3.8, 1);
		expect(Math.max(...means)).toBeCloseTo(13.3, 1);
		// Means span 3.5x; CVs stay inside a 2x band with no trend.
		expect(Math.max(...means) / Math.min(...means)).toBeGreaterThan(3);
		expect(Math.min(...cvs)).toBeGreaterThan(0.22);
		expect(Math.max(...cvs)).toBeLessThan(0.43);
	});

	it("THE HEADLINE: the effect is smaller than one unit of what varies", () => {
		// 0.77 of a tool call, against a per-run turn spread of 1.0 to 4.2 calls.
		// This one sentence is why no redesign of the suite can rescue the
		// experiment, so it is pinned rather than left to prose.
		const perCall = turnCostFit(GROUPS, "total")?.slope as number;
		const effect = burnPlan(GROUPS, "total", RENT, EFFECT, 5)
			?.targetSaving as number;
		expect(Number((effect / perCall).toFixed(2))).toBe(0.77);
		const turnSds = taskNoise(GROUPS, "toolCalls").map((t) =>
			Math.sqrt(t.variance),
		);
		expect(Number(Math.min(...turnSds).toFixed(1))).toBe(1.0);
		expect(Number(Math.max(...turnSds).toFixed(1))).toBe(4.2);
		// The effect is below even the QUIETEST task's run-to-run turn spread.
		expect(effect / perCall).toBeLessThan(Math.min(...turnSds));
	});
});

describe("published: the prize (FINDINGS table 4)", () => {
	it("the compression effect needs 35 runs/side and 49.2M tokens on the gate's metric", () => {
		const plan = burnPlan(GROUPS, "total", RENT, EFFECT, 5);
		expect(plan?.runsPerSide).toBe(35);
		expect(Math.round((plan?.burnTokens as number) / 1e5) / 10).toBe(49.2);
		expect(Math.round(plan?.mds80 as number)).toBe(28_418);
		expect(Math.round(plan?.mds90 as number)).toBe(32_814);
		// The recorded point estimate is far below the 5-run detection floor.
		expect(plan?.targetSaving).toBeLessThan(plan?.mds80 as number);
	});

	it("a quieter metric cuts the required burn but never below a window", () => {
		const processing = burnPlan(GROUPS, "processing", RENT, EFFECT, 5);
		const costEq = burnPlan(GROUPS, "costEquivalent", RENT, EFFECT, 5);
		expect(processing?.runsPerSide).toBe(7);
		expect(costEq?.runsPerSide).toBe(18);
		// Every one still exceeds the ~6M-token windows this environment gives.
		for (const plan of [processing, costEq]) {
			expect(plan?.burnTokens).toBeGreaterThan(6_000_000);
		}
	});

	it("a burn costs the same tokens whatever metric scores it", () => {
		const total = burnPlan(GROUPS, "total", RENT, EFFECT, 5);
		const processing = burnPlan(GROUPS, "processing", RENT, EFFECT, 5);
		expect(total?.tokensPerRun).toBe(processing?.tokensPerRun);
		expect(Math.round(total?.tokensPerRun as number)).toBe(100_389);
	});
});

describe("published: removing the noisiest tasks (FINDINGS table 5)", () => {
	const BUDGET = 6_000_000;
	const ids = [
		"sql-01",
		"sql-02",
		"sql-03",
		"sql-04",
		"sql-05",
		"sql-06",
		"sql-07",
	];

	const ratio = (subset: string[]): number =>
		Number(
			(
				subsetAtBudget(GROUPS, "total", RENT, EFFECT, BUDGET, subset, "x")
					?.detectionRatio as number
			).toFixed(2),
		);

	it("THE HEADLINE: no subset reaches 80% power inside a real window", () => {
		expect(ratio(ids)).toBe(0.97);
		expect(ratio(ids.filter((i) => i !== "sql-03"))).toBe(1.08);
		expect(ratio(ids.filter((i) => !["sql-03", "sql-05"].includes(i)))).toBe(
			1.18,
		);
		expect(
			ratio(ids.filter((i) => !["sql-03", "sql-05", "sql-04"].includes(i))),
		).toBe(1.38);
		expect(ratio(["sql-02", "sql-06", "sql-07"])).toBe(1.78);
		// 80% power needs z + z_80 = 2.84. The best subset reaches 1.78.
		expect(1.78).toBeLessThan(2.84);
	});

	it("removing a task removes its SIGNAL in the same proportion as its noise", () => {
		// This is why the ratio barely moves, and it is the reason task-splitting
		// is not the remedy the roadmap assumed it was.
		const whole = subsetAtBudget(
			GROUPS,
			"total",
			RENT,
			EFFECT,
			BUDGET,
			ids,
			"whole",
		);
		const quiet = subsetAtBudget(
			GROUPS,
			"total",
			RENT,
			EFFECT,
			BUDGET,
			["sql-02", "sql-06", "sql-07"],
			"quiet",
		);
		expect(quiet?.standardError).toBeLessThan(whole?.standardError as number);
		expect(quiet?.targetSaving).toBeLessThan(whole?.targetSaving as number);
		// The gain is entirely the extra runs the cheaper suite buys.
		expect(quiet?.runsPerSide).toBeGreaterThan(
			4 * (whole?.runsPerSide as number),
		);
	});
});

describe("published: the arms differenced (FINDINGS table 6)", () => {
	it("the burn's own arms are noise on EVERY metric", () => {
		const total = armDelta(GROUPS, "total");
		const processing = armDelta(GROUPS, "processing");
		const costEq = armDelta(GROUPS, "costEquivalent");
		expect(Math.round(total?.delta as number)).toBe(5_035);
		expect(Math.round(total?.standardError as number)).toBe(7_948);
		expect(Math.round(processing?.delta as number)).toBe(72);
		expect(Math.round(processing?.standardError as number)).toBe(284);
		expect(Math.round(costEq?.delta as number)).toBe(777);
		expect(Math.round(costEq?.standardError as number)).toBe(1_388);
	});

	it("the quieter metrics do NOT improve detectability of this effect", () => {
		// The check that kills "just switch the gate to processing tokens" as a
		// rescue for the compression experiment: the error bar shrinks 28x, and
		// the ratio gets WORSE, because the effect lives in cache-read.
		const r = (m: "total" | "processing" | "costEquivalent") => {
			const a = armDelta(GROUPS, m);
			return (a?.delta as number) / (a?.standardError as number);
		};
		expect(Number(r("total").toFixed(2))).toBe(0.63);
		expect(Number(r("processing").toFixed(2))).toBe(0.26);
		expect(Number(r("costEquivalent").toFixed(2))).toBe(0.56);
		expect(r("processing")).toBeLessThan(r("total"));
		expect(r("costEquivalent")).toBeLessThan(r("total"));
	});
});
