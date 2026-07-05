import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSummary } from "../src/bench.js";
import { getRuleById, insertRule, openDb, type WardenDb } from "../src/db.js";
import { buildNudge } from "../src/notify.js";
import {
	allocateTopUpRuns,
	assessDelta,
	mergeSummaries,
	type RunAllocation,
	type SuiteRunner,
	selectForAgent,
} from "../src/select.js";

function summary(
	taskId: string,
	tokens: number[],
	completed = true,
): TaskSummary {
	const results = tokens.map((t, i) => ({
		sessionId: `${taskId}-s${i}`,
		tokens: t,
		completed,
	}));
	const completedTokens = completed ? tokens : [];
	const mean =
		completedTokens.length > 0
			? Math.round(
					completedTokens.reduce((a, b) => a + b, 0) / completedTokens.length,
				)
			: 0;
	return { taskId, results, meanCompletedTokens: mean, highVariance: false };
}

describe("assessDelta", () => {
	const baseline = [
		summary("t1", [1000]),
		summary("t2", [1000]),
		summary("t3", [1000]),
	];

	it("flags a verdict within one standard error as uncertain", () => {
		// Per-task savings {60, -100, 200}: mean ≈ 53, SE ≈ 87; threshold 50.
		const withRule = [
			summary("t1", [940]),
			summary("t2", [1100]),
			summary("t3", [800]),
		];
		const assessment = assessDelta(baseline, withRule, 25);
		expect(assessment.delta).toBe(53);
		expect(assessment.uncertain).toBe(true);
		expect(assessment.standardError).toBeGreaterThan(0);
	});

	it("does not flag a clear verdict", () => {
		// Savings {500, 510, 490}: mean 500, SE ≈ 5.8; threshold 50.
		const withRule = [
			summary("t1", [500]),
			summary("t2", [490]),
			summary("t3", [510]),
		];
		expect(assessDelta(baseline, withRule, 25).uncertain).toBe(false);
	});

	it("never marks regressions or unmeasurable deltas uncertain", () => {
		const regressed = [
			summary("t1", [900]),
			summary("t2", [0], false),
			summary("t3", [900]),
		];
		const assessment = assessDelta(baseline, regressed, 25);
		expect(assessment.regression).toBe(true);
		expect(assessment.uncertain).toBe(false);
	});

	it("gives a point estimate with null SE for a single comparable task (no /0 NaN)", () => {
		// Only t1 completes in the baseline, so it is the lone comparable task;
		// t2/t3 are skipped (not regressions). standardError divides by
		// (n-1) = 0 if computed, so the >=2 guard must keep it null.
		const without = [
			summary("t1", [1000]),
			summary("t2", [0], false),
			summary("t3", [0], false),
		];
		const withRule = [
			summary("t1", [800]),
			summary("t2", [0], false),
			summary("t3", [0], false),
		];
		const a = assessDelta(without, withRule, 25);
		expect(a.delta).toBe(200);
		expect(a.standardError).toBeNull();
		expect(a.uncertain).toBe(false);
		expect(a.regression).toBe(false);
		expect(Number.isFinite(a.delta)).toBe(true);
	});

	it("returns a null delta (not NaN) when nothing is comparable", () => {
		const without = [summary("t1", [0], false), summary("t2", [0], false)];
		const withRule = [summary("t1", [500]), summary("t2", [500])];
		const a = assessDelta(without, withRule, 25);
		expect(a.delta).toBeNull();
		expect(a.standardError).toBeNull();
		expect(a.uncertain).toBe(false);
		expect(a.regression).toBe(false);
	});
});

describe("assessDelta (within-task variance, fixed-suite estimand)", () => {
	it("builds the SE from within-task run noise when ≥2 runs/side exist", () => {
		const without = [summary("t1", [1000, 1040]), summary("t2", [2000, 2080])];
		const withRule = [summary("t1", [900, 940]), summary("t2", [1850, 1930])];
		const a = assessDelta(without, withRule, 25);
		expect(a.standardErrorBasis).toBe("within-task");
		expect(a.standardError).toBeGreaterThan(0);
	});

	it("falls back to between-task spread at one run/side", () => {
		const without = [summary("t1", [1000]), summary("t2", [2000])];
		const withRule = [summary("t1", [900]), summary("t2", [1850])];
		expect(assessDelta(without, withRule, 25).standardErrorBasis).toBe(
			"between-task",
		);
	});

	it("SHRINKS the SE as runs increase — the run-count lever now bites", () => {
		// Same run-to-run spread (±20), same per-task savings; only the number of
		// runs differs. The corrected estimator must report a smaller SE with more
		// runs (the legacy between-task SE could not — it was independent of runs).
		const twoRuns = assessDelta(
			[summary("t1", [980, 1020]), summary("t2", [1980, 2020])],
			[summary("t1", [880, 920]), summary("t2", [1880, 1920])],
			25,
		);
		const fourRuns = assessDelta(
			[
				summary("t1", [980, 1020, 980, 1020]),
				summary("t2", [1980, 2020, 1980, 2020]),
			],
			[
				summary("t1", [880, 920, 880, 920]),
				summary("t2", [1880, 1920, 1880, 1920]),
			],
			25,
		);
		expect(twoRuns.delta).toBe(fourRuns.delta); // identical point estimate
		expect(fourRuns.standardError).toBeLessThan(twoRuns.standardError ?? 0);
	});

	it("does not inflate the SE for tasks that simply save different amounts", () => {
		// Two suites with identical within-task noise (±20) but very different
		// per-task savings. The fixed-suite estimand treats differing savings as
		// fixed offsets, not error — so both must report the same within-task SE.
		const homogeneous = assessDelta(
			[summary("t1", [980, 1020]), summary("t2", [980, 1020])],
			[summary("t1", [880, 920]), summary("t2", [880, 920])],
			25,
		);
		const heterogeneous = assessDelta(
			[summary("t1", [980, 1020]), summary("t2", [980, 1020])],
			[summary("t1", [880, 920]), summary("t2", [480, 520])],
			25,
		);
		expect(heterogeneous.standardError).toBeCloseTo(
			homogeneous.standardError ?? 0,
			6,
		);
	});
});

describe("assessDelta robust aggregation + tail-risk", () => {
	it("is inert on clean data — no trim, robust delta == delta, no tail-risk", () => {
		const without = [summary("t1", [1000, 1040]), summary("t2", [2000, 2080])];
		const withRule = [summary("t1", [900, 940]), summary("t2", [1850, 1930])];
		const a = assessDelta(without, withRule, 25);
		expect(a.tailRisk).toBe(false);
		expect(a.robustDelta).toBe(a.delta);
	});

	it("does NOT promote on the robust SE — the verdict keeps the raw (correctly calibrated) SE", () => {
		// A derailment that cancels (each run still saves 10k). Robust ≈ mean so
		// no tail-risk, but the SE stays RAW (large) — using the tiny robust SE
		// here would over-confidently keep noise (the calibration's negative result).
		const without = [
			summary("t1", [59000, 61000, 110000]),
			summary("t2", [59000, 61000, 60000]),
		];
		const withRule = [
			summary("t1", [49000, 51000, 100000]),
			summary("t2", [49000, 51000, 50000]),
		];
		const a = assessDelta(without, withRule, 25);
		expect(a.tailRisk).toBe(false);
		expect(a.robustDelta).toBeCloseTo(10000, -3); // robust estimate is reported
		expect(a.standardError ?? 0).toBeGreaterThan(5000); // raw SE, not the tiny robust one
	});

	it("flags tail-risk when an outlier materially moves the saving", () => {
		// The derailed run saves far more (108k vs 76k = 32k) than the clean runs
		// (10k): trimming it changes the answer, so the rule is tail-heavy.
		const without = [
			summary("t1", [59000, 61000, 108000]),
			summary("t2", [59000, 61000, 60000]),
		];
		const withRule = [
			summary("t1", [49000, 51000, 76000]),
			summary("t2", [49000, 51000, 50000]),
		];
		const a = assessDelta(without, withRule, 25);
		expect(a.tailRisk).toBe(true);
		// When flagged, the verdict stays on the mean (which keeps the tail).
		expect(a.delta).toBeGreaterThan(a.robustDelta ?? 0);
	});
});

describe("assessDelta confidence band (WARDEN_CONFIDENCE_Z)", () => {
	// Savings {70,50,90} over baseline 1000: mean 70, between-task SE ≈ 11.6,
	// 2×-rent bar ≈ 53 → ~1.5 SE above the bar. Uncertain at z=2, not at z=1.
	const baseline = [
		summary("t1", [1000]),
		summary("t2", [1000]),
		summary("t3", [1000]),
	];
	const withRule = [
		summary("t1", [930]),
		summary("t2", [950]),
		summary("t3", [910]),
	];

	afterEach(() => {
		delete process.env.WARDEN_CONFIDENCE_Z;
	});

	it("defaults to z=2 (a ~1.5-SE margin is uncertain)", () => {
		expect(assessDelta(baseline, withRule, 25).uncertain).toBe(true);
	});

	it("z=1 is looser — the same margin is confident", () => {
		process.env.WARDEN_CONFIDENCE_Z = "1";
		expect(assessDelta(baseline, withRule, 25).uncertain).toBe(false);
	});

	it("ignores a sub-1 / garbage override (clamps to the default)", () => {
		process.env.WARDEN_CONFIDENCE_Z = "0";
		expect(assessDelta(baseline, withRule, 25).uncertain).toBe(true);
	});
});

describe("allocateTopUpRuns (Neyman top-up allocation)", () => {
	const stableRef = [summary("t1", [1000, 1000]), summary("t2", [1000, 1000])];

	it("pours the whole budget into the high-variance task, skips the stable one", () => {
		const measured = [
			summary("t1", [900, 1100]), // variance 20,000
			summary("t2", [1000, 1000]), // variance 0
		];
		const alloc = allocateTopUpRuns(stableRef, measured, 4);
		expect(alloc?.get("t1")).toBe(4);
		expect(alloc?.has("t2")).toBe(false);
	});

	it("splits a budget toward the noisier of two variable tasks", () => {
		const measured = [
			summary("t1", [800, 1200]), // variance 80,000
			summary("t2", [900, 1100]), // variance 20,000
		];
		const alloc = allocateTopUpRuns(stableRef, measured, 6);
		expect(alloc?.get("t1") ?? 0).toBeGreaterThan(alloc?.get("t2") ?? 0);
		const total = [...(alloc?.values() ?? [])].reduce((a, b) => a + b, 0);
		expect(total).toBe(6);
	});

	it("returns null (uniform fallback) when no within-task variance exists", () => {
		const ref = [summary("t1", [1000]), summary("t2", [1000])];
		const measured = [summary("t1", [900]), summary("t2", [1100])];
		expect(allocateTopUpRuns(ref, measured, 4)).toBeNull();
	});

	it("never allocates to a regressed (no completed run) task", () => {
		const measured = [
			summary("t1", [900, 1100]),
			summary("t2", [0, 0], false), // failed both runs
		];
		const alloc = allocateTopUpRuns(stableRef, measured, 4);
		expect(alloc?.has("t2")).toBe(false);
		expect(alloc?.get("t1")).toBe(4);
	});
});

describe("mergeSummaries", () => {
	it("pools results per task and recomputes means", () => {
		const first = [summary("t1", [1000])];
		const second = [summary("t1", [800])];
		const merged = mergeSummaries(first, second);
		expect(merged[0]?.results).toHaveLength(2);
		expect(merged[0]?.meanCompletedTokens).toBe(900);
	});

	it("keeps tasks missing from the second pass unchanged", () => {
		const merged = mergeSummaries([summary("t1", [1000])], []);
		expect(merged[0]?.meanCompletedTokens).toBe(1000);
	});
});

describe("selectForAgent variance top-up", () => {
	let dir: string;
	let db: WardenDb;
	const agent = "sql";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-topup-"));
		db = openDb(join(dir, "warden.db"));
		process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_MEMORY_DIR;
	});

	it("spends one extra pass on an uncertain verdict and decides on pooled data", () => {
		const id = insertRule(db, {
			agent,
			body: "A borderline rule whose first measurement is noisy.",
			contextCost: 25,
			sourceRun: null,
			createdAt: "t",
		});
		const labels: string[] = [];
		const runner: SuiteRunner = (rules, label) => {
			labels.push(label);
			if (rules.length === 0) {
				// Baseline configuration.
				return [
					summary("t1", [1000]),
					summary("t2", [1000]),
					summary("t3", [1000]),
				];
			}
			if (label.endsWith("-topup")) {
				// Clearer second pass: pooled savings become {80, 100, 150}.
				return [
					summary("t1", [900]),
					summary("t2", [700]),
					summary("t3", [900]),
				];
			}
			// Noisy first pass: savings {60, -100, 200} → uncertain at rent 25.
			return [
				summary("t1", [940]),
				summary("t2", [1100]),
				summary("t3", [800]),
			];
		};

		const report = selectForAgent(db, agent, runner, { topUpBudget: 1 });

		// Baseline is lazy (memoized on first reference), so the candidate's
		// measured pass logs before it; the set of passes is what matters.
		expect(labels).toEqual([
			`candidate-${id}`,
			"active-set",
			`candidate-${id}-topup`,
		]);
		const decision = report.decisions[0];
		expect(decision?.toppedUp).toBe(true);
		expect(decision?.uncertain).toBe(false);
		// Pooled savings {80, 100, 150} → mean 110 ≥ 2×25.
		expect(decision?.delta).toBe(110);
		expect(getRuleById(db, id)?.status).toBe("active");
		expect(getRuleById(db, id)?.decided_reason).toContain("variance top-up");
	});

	it("routes the top-up by Neyman allocation — runs land on the noisy task", () => {
		insertRule(db, {
			agent,
			body: "A rule whose worth hides behind one very noisy task.",
			contextCost: 25,
			sourceRun: null,
			createdAt: "t",
		});
		const allocations: (RunAllocation | undefined)[] = [];
		const runner: SuiteRunner = (rules, label, _record, allocation) => {
			if (label.endsWith("-topup")) allocations.push(allocation);
			if (rules.length === 0) {
				// Stable baseline, 2 runs/task.
				return [
					summary("t1", [1000, 1000]),
					summary("t2", [1000, 1000]),
					summary("t3", [1000, 1000]),
				];
			}
			if (label.endsWith("-topup")) {
				// Only the allocated tasks run; t1 resolves clearly cheaper.
				const out: TaskSummary[] = [];
				for (const t of ["t1", "t2", "t3"]) {
					const n = allocation?.get(t);
					if (n) out.push(summary(t, Array(n).fill(900)));
				}
				return out;
			}
			// First candidate pass: t1 is wildly noisy, t2/t3 quiet → uncertain.
			return [
				summary("t1", [850, 1150]),
				summary("t2", [960, 1000]),
				summary("t3", [940, 980]),
			];
		};

		const report = selectForAgent(db, agent, runner, { topUpBudget: 1 });

		expect(report.decisions[0]?.toppedUp).toBe(true);
		// The top-up pass received an allocation, and it concentrated runs on the
		// high-variance task while sparing the quiet ones.
		expect(allocations).toHaveLength(1);
		const alloc = allocations[0];
		expect(alloc).toBeDefined();
		expect((alloc?.get("t1") ?? 0) > 0).toBe(true);
		expect(alloc?.has("t2")).toBe(false);
		expect(alloc?.has("t3")).toBe(false);
	});

	it("does not top up when the budget is zero", () => {
		insertRule(db, {
			agent,
			body: "A borderline rule measured exactly once.",
			contextCost: 25,
			sourceRun: null,
			createdAt: "t",
		});
		const labels: string[] = [];
		const runner: SuiteRunner = (rules, label) => {
			labels.push(label);
			return rules.length === 0
				? [summary("t1", [1000]), summary("t2", [1000]), summary("t3", [1000])]
				: // Savings {70, -90, 210}: mean 63 clears the cache-aware bar (~53)
					// but sits within one SE (~87) — active yet uncertain.
					[summary("t1", [930]), summary("t2", [1090]), summary("t3", [790])];
		};

		const report = selectForAgent(db, agent, runner, { topUpBudget: 0 });
		expect(labels.filter((l) => l.endsWith("-topup"))).toHaveLength(0);
		const decision = report.decisions[0];
		expect(decision?.toppedUp).toBe(false);
		expect(decision?.uncertain).toBe(true);
		// Variance-conservative promotion: an uncertain candidate (no top-up
		// budget to resolve it) is evicted, not activated — we do not pay
		// rent on a rule we cannot show clears the threshold.
		expect(decision?.status).toBe("evicted");
		expect(getRuleById(db, decision?.rule.id ?? -1)?.status).toBe("evicted");
		expect(getRuleById(db, decision?.rule.id ?? -1)?.decided_reason).toContain(
			"standard error",
		);
	});
});

describe("buildNudge", () => {
	it("summarizes pending candidates per agent", () => {
		const nudge = buildNudge([
			{ agent: "sql", pending: 2 },
			{ agent: "backend", pending: 1 },
		]);
		expect(nudge).toContain("3 candidate rule(s)");
		expect(nudge).toContain("sql: 2");
		expect(nudge).toContain("warden-select");
	});

	it("is null when nothing is pending", () => {
		expect(buildNudge([])).toBeNull();
	});

	it("ignores non-domain agents whose rules cannot be measured", () => {
		expect(buildNudge([{ agent: "main", pending: 5 }])).toBeNull();
		expect(
			buildNudge([
				{ agent: "main", pending: 5 },
				{ agent: "sql", pending: 1 },
			]),
		).toContain("1 candidate rule(s) pending measurement (sql: 1)");
	});
});

describe("candidate cap per invocation", () => {
	let dir2: string;
	let db2: WardenDb;

	beforeEach(() => {
		dir2 = mkdtempSync(join(tmpdir(), "warden-cap-"));
		db2 = openDb(join(dir2, "warden.db"));
		process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir2, "agent-memory");
	});

	afterEach(() => {
		db2.close();
		rmSync(dir2, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_MEMORY_DIR;
	});

	it("decides at most 3 candidates, oldest first; the rest stay queued", () => {
		const ids: number[] = [];
		for (let i = 0; i < 4; i++) {
			ids.push(
				insertRule(db2, {
					agent: "sql",
					body: `Candidate rule number ${i} body.`,
					contextCost: 5,
					sourceRun: null,
					createdAt: `2026-06-0${i + 1}`,
				}),
			);
		}
		const runner: SuiteRunner = (rules) =>
			rules.length === 0 ? [summary("t1", [10_000])] : [summary("t1", [5_000])];
		const report = selectForAgent(db2, "sql", runner);
		expect(report.decisions.filter((d) => d.kind === "candidate")).toHaveLength(
			3,
		);
		expect(getRuleById(db2, ids[3] ?? -1)?.status).toBe("candidate");
	});
});
