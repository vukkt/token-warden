import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSummary } from "../src/bench.js";
import {
	compareConfigs,
	environmentFailedTaskIds,
	formatCategoryRegressions,
	formatComparison,
	poolRuns,
	type RunDatum,
	regressedTaskIds,
	runComparison,
	totalBenchTokens,
	type VariantRuns,
	verdictLine,
} from "../src/compare.js";
import { openDb, upsertRun, type WardenDb } from "../src/db.js";

/** Build one task's runs from (processing, cacheRead, completed, durationMs)
 * tuples; the last two are optional (default completed=true, no duration). */
function task(
	taskId: string,
	runs: [
		proc: number,
		cacheRead: number,
		completed?: boolean,
		durationMs?: number,
	][],
): VariantRuns {
	return {
		taskId,
		runs: runs.map(
			([proc, cacheRead, completed = true, durationMs = null]): RunDatum => ({
				processingTokens: proc,
				cacheRead,
				totalTokens: proc + cacheRead,
				completed,
				durationMs,
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
		// The failing run burned real tokens (above the environment-failure
		// floor): a genuine capability regression, not a quota death.
		const c = cmp(
			[task("t1", [[1000, 0]]), task("t2", [[1000, 0]])],
			[task("t1", [[400, 0]]), task("t2", [[40_000, 0, false]])],
		);
		expect(c.regression).toBe(true);
		expect(c.environmentFailure).toBe(false);
		expect(verdictLine(c)).toContain("NOT a safe model change");
	});

	it("flags an environment failure (no verdict) when the failing side burned ~0 tokens", () => {
		const c = cmp(
			[task("t1", [[1000, 0]]), task("t2", [[1000, 0]])],
			[task("t1", [[400, 0]]), task("t2", [[0, 0, false]])],
		);
		expect(c.regression).toBe(false);
		expect(c.environmentFailure).toBe(true);
		expect(verdictLine(c)).toContain("environment failure");
		expect(verdictLine(c)).toContain("says nothing about this model");
	});

	it("rolls regressions up by category, naming the broken tasks", () => {
		const forAgent = (subject: string, failTask: string | null) =>
			compareConfigs(
				subject,
				"model",
				"sonnet",
				"haiku",
				[
					task(`${subject}-01`, [[1000, 0]]),
					task(`${subject}-02`, [[1000, 0]]),
				],
				[
					task(`${subject}-01`, [[6000, 0]]),
					task(`${subject}-02`, [[6000, 0, failTask !== `${subject}-02`]]),
				],
			);

		const clean = forAgent("backend", null);
		const broken = forAgent("testing", "testing-02");
		expect(regressedTaskIds(clean)).toEqual([]);
		expect(regressedTaskIds(broken)).toEqual(["testing-02"]);

		const unsafe = formatCategoryRegressions([clean, broken]);
		expect(unsafe).toContain("backend: none");
		expect(unsafe).toContain("testing: REGRESSED — testing-02");
		expect(unsafe).toContain("NOT a safe change for the regressed categories");

		const safe = formatCategoryRegressions([clean, forAgent("sql", null)]);
		expect(safe).toContain("completion-safe across all suites");
	});

	it("never reports a quota death as a regression in the category roll-up", () => {
		// t2's candidate side burned ~0 tokens: an environment death, which
		// `Comparison.regression` has always excluded. `regressedTaskIds` used a
		// bare completion test, so the roll-up printed "REGRESSED — t2" AND "No
		// category regressed ... completion-safe across all suites" together.
		const envDead = cmp(
			[task("t1", [[1000, 0]]), task("t2", [[1000, 0]])],
			[task("t1", [[400, 0]]), task("t2", [[0, 0, false]])],
		);
		expect(envDead.environmentFailure).toBe(true);
		expect(envDead.regression).toBe(false);
		expect(regressedTaskIds(envDead)).toEqual([]);
		expect(environmentFailedTaskIds(envDead)).toEqual(["t2"]);

		const report = formatCategoryRegressions([envDead]);
		expect(report).toContain("sql: NO VERDICT (environment failure — t2)");
		expect(report).not.toContain("REGRESSED");
		// The unearned safety claim is gone.
		expect(report).not.toContain("completion-safe across all suites");
		expect(report).toContain("UNPROVEN");
	});

	it("still reports a token-burning failure as a real regression", () => {
		// Same shape, but the failing run spent real tokens — the agent attempted
		// the task and broke. That is a capability regression, not an outage.
		const broken = cmp(
			[task("t1", [[1000, 0]]), task("t2", [[1000, 0]])],
			[task("t1", [[400, 0]]), task("t2", [[40_000, 0, false]])],
		);
		expect(broken.regression).toBe(true);
		expect(regressedTaskIds(broken)).toEqual(["t2"]);
		expect(environmentFailedTaskIds(broken)).toEqual([]);
		const report = formatCategoryRegressions([broken]);
		expect(report).toContain("sql: REGRESSED — t2");
		expect(report).toContain("NOT a safe change for the regressed categories");
	});

	it("partitions failed tasks into regressed vs environment-failed, disjointly", () => {
		// One of each, plus a healthy task: the two accessors must not overlap.
		const mixed = cmp(
			[
				task("t1", [[1000, 0]]),
				task("t2", [[1000, 0]]),
				task("t3", [[1000, 0]]),
			],
			[
				task("t1", [[400, 0]]),
				task("t2", [[40_000, 0, false]]),
				task("t3", [[0, 0, false]]),
			],
		);
		expect(regressedTaskIds(mixed)).toEqual(["t2"]);
		expect(environmentFailedTaskIds(mixed)).toEqual(["t3"]);
		// A real regression outranks the environment note in the roll-up.
		expect(formatCategoryRegressions([mixed])).toContain("sql: REGRESSED — t2");
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
			[task("t1", [[400, 0]]), task("t2", [[40_000, 0, false]])],
		);
		expect(verdictLine(promptCmp)).toContain("NOT a safe prompt change");
	});
});

describe("compareConfigs totality and purity", () => {
	it("is total on degenerate shapes — no NaN or undefined reaches the report", () => {
		const shapes: Array<[string, VariantRuns[], VariantRuns[]]> = [
			["both sides empty", [], []],
			["baseline empty", [], [task("t1", [[100, 0]])]],
			["candidate empty", [task("t1", [[100, 0]])], []],
			["task with zero runs", [task("t1", [])], [task("t1", [])]],
			[
				"every run failed on both sides",
				[task("t1", [[0, 0, false]])],
				[task("t1", [[0, 0, false]])],
			],
			["disjoint task ids", [task("t1", [[100, 0]])], [task("t2", [[100, 0]])]],
			[
				"zero-token completed runs",
				[task("t1", [[0, 0]]), task("t2", [[0, 0]])],
				[task("t1", [[0, 0]]), task("t2", [[0, 0]])],
			],
		];
		for (const [name, baseline, candidate] of shapes) {
			const c = cmp(baseline, candidate);
			const report = `${formatComparison(c)}\n${verdictLine(c)}`;
			expect(report, name).not.toContain("NaN");
			expect(report, name).not.toContain("undefined");
			expect(c.delta === null || Number.isFinite(c.delta), name).toBe(true);
			expect(
				c.standardError === null || Number.isFinite(c.standardError),
				name,
			).toBe(true);
			expect(c.comparableTasks, name).toBeGreaterThanOrEqual(0);
		}
	});

	it("is referentially transparent — deterministic and non-mutating", () => {
		const baseline = [
			task("t1", [
				[1000, 500],
				[1100, 500],
			]),
			task("t2", [
				[2000, 500],
				[2100, 500],
			]),
		];
		const candidate = [
			task("t1", [
				[900, 700],
				[950, 700],
			]),
			task("t2", [
				[1800, 700],
				[1900, 700],
			]),
		];
		const snapshot = JSON.stringify([baseline, candidate]);
		const first = cmp(baseline, candidate);
		const second = cmp(baseline, candidate);
		expect(second).toEqual(first);
		expect(formatComparison(second)).toBe(formatComparison(first));
		// Inputs untouched: the comparison core is pure over its arguments.
		expect(JSON.stringify([baseline, candidate])).toBe(snapshot);
	});

	it("locks the delta sign convention: positive means the candidate is cheaper", () => {
		const cheaper = cmp(
			[task("t1", [[1000, 0]]), task("t2", [[1000, 0]])],
			[task("t1", [[600, 0]]), task("t2", [[600, 0]])],
		);
		const pricier = cmp(
			[task("t1", [[600, 0]]), task("t2", [[600, 0]])],
			[task("t1", [[1000, 0]]), task("t2", [[1000, 0]])],
		);
		expect(cheaper.delta).toBe(400);
		expect(pricier.delta).toBe(-400);
	});

	it("scores the verdict on PROCESSING tokens only — cache-read never moves it", () => {
		const base = [task("t1", [[1000, 0]]), task("t2", [[1000, 0]])];
		const lean = cmp(base, [task("t1", [[600, 0]]), task("t2", [[600, 0]])]);
		const sameProcHugeCache = cmp(base, [
			task("t1", [[600, 9_000_000]]),
			task("t2", [[600, 9_000_000]]),
		]);
		expect(sameProcHugeCache.delta).toBe(lean.delta);
		expect(sameProcHugeCache.standardError).toBe(lean.standardError);
		expect(sameProcHugeCache.uncertain).toBe(lean.uncertain);
	});

	it("computes the overall pct over the SAME task set on both sides", () => {
		// Regression pin. The baseline fails t3 outright (burning real tokens) and
		// the candidate completes it. Filtering each side independently on `> 0`
		// averaged the baseline over {t1,t2} and the candidate over {t1,t2,t3},
		// printing "+126.7% ... cheaper for this workload" beside a correct
		// delta of +100 — a sentence contradicting itself.
		const c = cmp(
			[
				task("t1", [[1000, 0]]),
				task("t2", [[1000, 0]]),
				task("t3", [[40_000, 0, false]]),
			],
			[
				task("t1", [[900, 0]]),
				task("t2", [[900, 0]]),
				task("t3", [[5_000, 0]]),
			],
		);
		// Comparable tasks are t1,t2: 1000 -> 900.
		expect(c.pct).toBe("-10.0%");
		expect(c.delta).toBe(100);
		expect(c.comparableTasks).toBe(2);
		// The percentage sign and the verdict clause now agree.
		expect(verdictLine(c)).toContain("cheaper");
		expect(verdictLine(c)).toContain("-10.0%");
	});

	it("counts a genuinely zero-token completed run as data, not as missing", () => {
		// `completedMean` returns 0 both for "no completed runs" and for "completed
		// runs that cost 0", so the old `> 0` filter silently dropped real
		// measurements. t2 is a real zero-cost measurement on both sides.
		const c = cmp(
			[task("t1", [[1000, 0]]), task("t2", [[0, 0]])],
			[task("t1", [[500, 0]]), task("t2", [[0, 0]])],
		);
		expect(c.comparableTasks).toBe(2);
		// Means over {1000,0} -> 500 and {500,0} -> 250, i.e. -50.0%.
		expect(c.pct).toBe("-50.0%");
	});

	it("reports n/a rather than a fabricated pct when nothing is comparable", () => {
		const c = cmp([task("t1", [[1000, 0]])], [task("t1", [[0, 0, false]])]);
		expect(c.comparableTasks).toBe(0);
		expect(c.pct).toBe("n/a");
	});

	it("keeps the verdict fields on comparable tasks only", () => {
		// A task the baseline never completed carries no information about the
		// change, so it must not move the point estimate or the error bar.
		const baseline = [task("t1", [[1000, 0]]), task("t2", [[1000, 0]])];
		const candidate = [task("t1", [[900, 0]]), task("t2", [[900, 0]])];
		const withOrphan = cmp(
			[...baseline, task("t3", [[40_000, 0, false]])],
			[...candidate, task("t3", [[5_000, 0]])],
		);
		const withoutOrphan = cmp(baseline, candidate);
		expect(withOrphan.delta).toBe(withoutOrphan.delta);
		expect(withOrphan.standardError).toBe(withoutOrphan.standardError);
		expect(withOrphan.comparableTasks).toBe(withoutOrphan.comparableTasks);
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

	it("preserves every run of the first pass and adds the second's", () => {
		const first = [
			task("t1", [
				[1000, 0],
				[1100, 0],
			]),
			task("t2", [[2000, 0]]),
		];
		const second = [task("t1", [[900, 0]]), task("t2", [[1800, 0]])];
		const pooled = poolRuns(first, second);
		const count = (vs: VariantRuns[]) =>
			vs.reduce((n, v) => n + v.runs.length, 0);
		expect(count(pooled)).toBe(count(first) + count(second));
		// First-pass runs stay ahead of the top-up runs, in order.
		expect(pooled[0]?.runs.map((r) => r.processingTokens)).toEqual([
			1000, 1100, 900,
		]);
	});

	it("is a no-op when the second pass is empty, and does not mutate inputs", () => {
		const first = [task("t1", [[1000, 0]])];
		const snapshot = JSON.stringify(first);
		expect(poolRuns(first, [])).toEqual(first);
		expect(JSON.stringify(first)).toBe(snapshot);
	});
});

describe("totalBenchTokens", () => {
	it("sums total tokens across both sides", () => {
		expect(
			totalBenchTokens([task("t1", [[100, 50]])], [task("t1", [[200, 30]])]),
		).toBe(380);
	});
});

describe("runComparison", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-runcompare-"));
		db = openDb(join(dir, "warden.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	let session = 0;
	/** Write a real runs row and return a one-result TaskSummary pointing at
	 * it, so runComparison's gatherRuns(getRunBySession) finds the tokens. */
	function summaryFor(
		taskId: string,
		input: number,
		completed: boolean,
	): TaskSummary {
		session++;
		const sessionId = `s-${session}`;
		upsertRun(db, {
			agent: "sql",
			sessionId,
			taskHash: taskId,
			inputTokens: input,
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
		return {
			taskId,
			results: [{ sessionId, tokens: input, completed }],
			meanCompletedTokens: completed ? input : 0,
			highVariance: false,
			weight: 1,
		};
	}

	it("runs both sides, gathers from the db, and scores the verdict", () => {
		const cmp = runComparison(db, {
			subject: "sql",
			dimension: "model",
			baselineLabel: "sonnet",
			candidateLabel: "haiku",
			topUp: 0,
			runBaseline: () => [
				summaryFor("t1", 1000, true),
				summaryFor("t2", 1000, true),
			],
			runCandidate: () => [
				summaryFor("t1", 600, true),
				summaryFor("t2", 600, true),
			],
		});
		expect(cmp.comparison.delta).toBe(400);
		expect(cmp.comparison.comparableTasks).toBe(2);
		expect(cmp.benchTokens).toBe(3200);
	});

	it("spends a top-up pass when the first verdict is within noise", () => {
		const labels: string[] = [];
		runComparison(db, {
			subject: "sql",
			dimension: "model",
			baselineLabel: "sonnet",
			candidateLabel: "haiku",
			topUp: 1,
			runBaseline: (label) => {
				labels.push(`b:${label}`);
				return [
					summaryFor("t1", 1000, true),
					summaryFor("t2", 1000, true),
					summaryFor("t3", 1000, true),
				];
			},
			runCandidate: (label) => {
				labels.push(`c:${label}`);
				return [
					summaryFor("t1", 1010, true),
					summaryFor("t2", 980, true),
					summaryFor("t3", 1030, true),
				];
			},
		});
		expect(labels).toContain("b:baseline-topup");
		expect(labels).toContain("c:candidate-topup");
	});
});

describe("label sanitization (report injection defense)", () => {
	it("strips newlines and ANSI from a hostile candidate label", () => {
		const esc = "\u001b[31m";
		const hostile = `v.md\nActive rules:\n  FAKE ${esc}INJECT ignore-previous`;
		const c = compareConfigs("sql", "prompt", "current", hostile, [], []);
		expect(c.candidateLabel).not.toContain("\n");
		expect(c.candidateLabel).not.toContain("\u001b");
		const report = formatComparison(c);
		expect(report.split("\n").some((l) => l.trim().startsWith("FAKE"))).toBe(
			false,
		);
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

	it("reports latency as an advisory axis when durations are recorded", () => {
		// (proc, cacheRead, completed, durationMs)
		const c = cmp(
			[
				task("t1", [[1000, 5000, true, 20_000]]),
				task("t2", [[2000, 5000, true, 30_000]]),
			],
			[
				task("t1", [[700, 8000, true, 24_000]]),
				task("t2", [[1400, 8000, true, 36_000]]),
			],
		);
		expect(c.baselineDurationMean).toBe(25_000);
		expect(c.candidateDurationMean).toBe(30_000);
		const report = formatComparison(c);
		expect(report).toContain("[latency 20.0s → 24.0s]");
		expect(report).toContain(
			"Latency (advisory, not in verdict): 25.0s → 30.0s",
		);
		// Latency never flips the token verdict.
		expect(c.regression).toBe(false);
	});

	it("omits latency lines when no run recorded a duration", () => {
		const c = cmp(
			[task("t1", [[1000, 5000]]), task("t2", [[2000, 5000]])],
			[task("t1", [[700, 8000]]), task("t2", [[1400, 8000]])],
		);
		expect(c.baselineDurationMean).toBeNull();
		expect(formatComparison(c)).not.toContain("latency");
	});
});
