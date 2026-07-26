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
	decideRule,
	type GoldenReplicateRun,
	insertRule,
	openDb,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import {
	defaultRent,
	main,
	minDetectableSaving,
	normalCdf,
	parsePowerArgs,
	powerAt,
	renderPower,
	requiredRunsPerSide,
	seAt,
	type TaskNoise,
	taskNoiseFromReplicates,
	Z_POWER_80,
	Z_POWER_90,
} from "../src/power.js";
import { confidenceZ, effectiveRent } from "../src/stats.js";

/** Two-task suite with known variances: SE(n) = sqrt(250/n). */
const NOISES: TaskNoise[] = [
	{ taskId: "a", n: 3, variance: 100 },
	{ taskId: "b", n: 3, variance: 400 },
];
const RENT = 25;

function replicate(
	taskHash: string,
	rulesetVersion: number,
	model: string,
	total: number,
): GoldenReplicateRun {
	return { taskHash, rulesetVersion, model, total };
}

describe("normalCdf", () => {
	it("matches known quantiles", () => {
		expect(Math.abs(normalCdf(0) - 0.5)).toBeLessThan(1e-7);
		expect(Math.abs(normalCdf(1.959964) - 0.975)).toBeLessThan(1e-4);
	});

	it("is symmetric: normalCdf(-x) = 1 - normalCdf(x)", () => {
		for (const x of [0.3, 1, 1.96, 3.5]) {
			expect(Math.abs(normalCdf(-x) - (1 - normalCdf(x)))).toBeLessThan(1e-9);
		}
	});

	it("is total at the infinities and stays a probability everywhere", () => {
		expect(normalCdf(Number.POSITIVE_INFINITY)).toBe(1);
		expect(normalCdf(Number.NEGATIVE_INFINITY)).toBe(0);
		const rand = lcg(31);
		for (let trial = 0; trial < 2000; trial++) {
			const p = normalCdf((rand() - 0.5) * 80);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThanOrEqual(1);
		}
	});

	it("is monotone non-decreasing", () => {
		let prev = normalCdf(-12);
		for (let x = -12; x <= 12; x += 0.05) {
			const p = normalCdf(x);
			expect(p).toBeGreaterThanOrEqual(prev);
			prev = p;
		}
	});
});

/** Deterministic LCG so the property sweeps below are reproducible — a
 * flaky statistical test is worse than no test. */
function lcg(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2147483648;
		return s / 2147483648;
	};
}

describe("taskNoiseFromReplicates", () => {
	it("keeps the largest identical-configuration group per task", () => {
		const rows = [
			replicate("a", 0, "sonnet", 100),
			replicate("a", 0, "sonnet", 110),
			replicate("a", 0, "sonnet", 120),
			// Smaller group at another ruleset version: split off, then loses.
			replicate("a", 1, "sonnet", 200),
			replicate("a", 1, "sonnet", 210),
			replicate("c", 0, "sonnet", 300),
			replicate("c", 0, "sonnet", 320),
		];
		const noises = taskNoiseFromReplicates(rows);
		expect(noises).toEqual([
			{ taskId: "a", n: 3, variance: 100 },
			{ taskId: "c", n: 2, variance: 200 },
		]);
	});

	it("drops groups with fewer than 2 runs", () => {
		const rows = [
			replicate("solo", 0, "sonnet", 500),
			// Same task but different model: not the same configuration, so the
			// two singletons never merge into a fake 2-run group.
			replicate("solo", 0, "haiku", 900),
		];
		expect(taskNoiseFromReplicates(rows)).toEqual([]);
	});

	it("breaks an equal-size tie on the LARGER variance (conservative)", () => {
		// Two same-size groups for one task, differing only by model. The plan
		// must never understate the SE, so the noisier group wins.
		const rows = [
			replicate("t", 0, "sonnet", 100),
			replicate("t", 0, "sonnet", 110),
			replicate("t", 0, "haiku", 1000),
			replicate("t", 0, "haiku", 2000),
		];
		expect(taskNoiseFromReplicates(rows)).toEqual([
			{ taskId: "t", n: 2, variance: 500_000 },
		]);
	});

	it("is PERMUTATION-INVARIANT — row order cannot change the plan", () => {
		// goldenReplicateRuns orders by (task_hash, ruleset_version, ts) but NOT
		// by model, so two equal-size groups differing only by model arrive in
		// whichever order the runs happened to execute. Without a deterministic
		// tie-break that swung this example's variance between 50 and 500,000
		// (a 100x SE swing) on identical data.
		const rows = [
			replicate("t", 0, "sonnet", 100),
			replicate("t", 0, "sonnet", 110),
			replicate("t", 0, "haiku", 1000),
			replicate("t", 0, "haiku", 2000),
			replicate("u", 1, "sonnet", 50),
			replicate("u", 1, "sonnet", 70),
		];
		const canonical = taskNoiseFromReplicates(rows);
		const rand = lcg(4242);
		for (let trial = 0; trial < 200; trial++) {
			const shuffled = [...rows];
			for (let i = shuffled.length - 1; i > 0; i--) {
				const j = Math.floor(rand() * (i + 1));
				[shuffled[i], shuffled[j]] = [
					shuffled[j] as GoldenReplicateRun,
					shuffled[i] as GoldenReplicateRun,
				];
			}
			expect(taskNoiseFromReplicates(shuffled)).toEqual(canonical);
		}
	});

	it("never reports a negative variance (sum of squared deviations)", () => {
		const rand = lcg(99);
		for (let trial = 0; trial < 300; trial++) {
			// Large offsets with a small spread: the regime where a naive
			// one-pass sum-of-squares variance loses all precision and can even
			// go negative. The two-pass estimator must stay >= 0 and finite.
			const offset = 10 ** Math.floor(rand() * 13);
			const rows = Array.from({ length: 4 }, () =>
				replicate("t", 0, "sonnet", offset + Math.round(rand() * 10)),
			);
			const [noise] = taskNoiseFromReplicates(rows);
			expect(noise?.variance).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(noise?.variance ?? Number.NaN)).toBe(true);
		}
	});
});

describe("seAt", () => {
	it("shrinks as 1/sqrt(n)", () => {
		expect(Math.abs(seAt(2, NOISES) / seAt(8, NOISES) - 2)).toBeLessThan(1e-9);
	});

	it("rejects empty noises and non-positive run counts", () => {
		expect(() => seAt(2, [])).toThrow(/at least one task/);
		expect(() => seAt(0, NOISES)).toThrow(/runsPerSide/);
	});

	it("rejects NaN/Infinity run counts instead of returning a NaN SE", () => {
		// `runsPerSide < 1` alone lets NaN through (all NaN comparisons are
		// false), which silently produced a NaN plan.
		expect(() => seAt(Number.NaN, NOISES)).toThrow(/runsPerSide/);
		expect(() => seAt(Number.POSITIVE_INFINITY, NOISES)).toThrow(/runsPerSide/);
	});

	it("rejects a negative or non-finite variance instead of sqrt-ing to NaN", () => {
		expect(() => seAt(2, [{ taskId: "bad", n: 2, variance: -1 }])).toThrow(
			/negative variance/,
		);
		expect(() =>
			seAt(2, [{ taskId: "bad", n: 2, variance: Number.NaN }]),
		).toThrow(/negative variance/);
	});

	it("matches the closed form sqrt(2*sum(var)/(n*K^2)) exactly", () => {
		const rand = lcg(7);
		for (let trial = 0; trial < 500; trial++) {
			const noises: TaskNoise[] = Array.from(
				{ length: 1 + Math.floor(rand() * 6) },
				(_, i) => ({
					taskId: `t${i}`,
					n: 3,
					variance: rand() ** 3 * 1e9,
				}),
			);
			const n = 1 + Math.floor(rand() * 200);
			const k = noises.length;
			const expected = Math.sqrt(
				(2 * noises.reduce((a, t) => a + t.variance, 0)) / (n * k * k),
			);
			expect(seAt(n, noises)).toBeCloseTo(expected, 9);
		}
	});

	it("shrinks exactly as 1/sqrt(n) for every run-count pair", () => {
		const rand = lcg(11);
		const noises: TaskNoise[] = Array.from({ length: 4 }, (_, i) => ({
			taskId: `t${i}`,
			n: 3,
			variance: 1 + rand() * 1e6,
		}));
		for (let a = 1; a < 40; a++) {
			for (let b = a; b < 40; b++) {
				const ratio = seAt(a, noises) / seAt(b, noises);
				expect(ratio).toBeCloseTo(Math.sqrt(b / a), 9);
			}
		}
	});

	it("is non-negative and finite for every valid input (never NaN)", () => {
		const rand = lcg(13);
		for (let trial = 0; trial < 500; trial++) {
			const noises: TaskNoise[] = Array.from(
				{ length: 1 + Math.floor(rand() * 5) },
				(_, i) => ({ taskId: `t${i}`, n: 2, variance: rand() ** 4 * 1e12 }),
			);
			const se = seAt(1 + Math.floor(rand() * 500), noises);
			expect(se).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(se)).toBe(true);
		}
	});
});

describe("minDetectableSaving / requiredRunsPerSide / powerAt", () => {
	const bar = 2 * effectiveRent(RENT);

	it("MDS decreases monotonically with more runs", () => {
		const runs = [2, 3, 5, 8, 12];
		const mds = runs.map((n) =>
			minDetectableSaving(n, NOISES, RENT, Z_POWER_80),
		);
		for (let i = 1; i < mds.length; i++) {
			const prev = mds[i - 1] as number;
			expect(mds[i]).toBeLessThan(prev);
		}
	});

	it("requiredRunsPerSide inverts minDetectableSaving", () => {
		for (const n of [3, 5, 8]) {
			const d = minDetectableSaving(n, NOISES, RENT, Z_POWER_80);
			const needed = requiredRunsPerSide(d, NOISES, RENT, Z_POWER_80);
			expect(needed).not.toBeNull();
			expect(needed as number).toBeLessThanOrEqual(n);
		}
	});

	it("returns null below the bar and 2 for a huge target", () => {
		expect(requiredRunsPerSide(bar - 1, NOISES, RENT, Z_POWER_80)).toBeNull();
		expect(requiredRunsPerSide(1e9, NOISES, RENT, Z_POWER_90)).toBe(2);
	});

	it("returns null when even 500 runs cannot reach the target", () => {
		const noisy: TaskNoise[] = [{ taskId: "x", n: 2, variance: 1e12 }];
		expect(requiredRunsPerSide(bar + 1, noisy, RENT, Z_POWER_80)).toBeNull();
	});

	it("powerAt the MDS@80 is ~80%", () => {
		const d = minDetectableSaving(4, NOISES, RENT, Z_POWER_80);
		expect(Math.abs(powerAt(4, d, NOISES, RENT) - 0.8)).toBeLessThan(0.01);
	});

	it("MDS is monotone decreasing in n across randomized suites", () => {
		const rand = lcg(17);
		for (let trial = 0; trial < 200; trial++) {
			const noises: TaskNoise[] = Array.from(
				{ length: 1 + Math.floor(rand() * 5) },
				(_, i) => ({ taskId: `t${i}`, n: 3, variance: 1 + rand() ** 3 * 1e7 }),
			);
			const rent = 1 + Math.floor(rand() * 100);
			for (let n = 2; n < 30; n++) {
				expect(
					minDetectableSaving(n + 1, noises, rent, Z_POWER_80),
				).toBeLessThan(minDetectableSaving(n, noises, rent, Z_POWER_80));
			}
		}
	});

	it("MDS is always >= the bar, and MDS@90 >= MDS@80 (more power costs more)", () => {
		const rand = lcg(19);
		for (let trial = 0; trial < 300; trial++) {
			const noises: TaskNoise[] = Array.from(
				{ length: 1 + Math.floor(rand() * 4) },
				(_, i) => ({ taskId: `t${i}`, n: 3, variance: rand() ** 3 * 1e7 }),
			);
			const rent = 1 + Math.floor(rand() * 100);
			const n = 2 + Math.floor(rand() * 20);
			const barAt = 2 * effectiveRent(rent);
			const m80 = minDetectableSaving(n, noises, rent, Z_POWER_80);
			const m90 = minDetectableSaving(n, noises, rent, Z_POWER_90);
			expect(m80).toBeGreaterThanOrEqual(barAt);
			expect(m90).toBeGreaterThanOrEqual(m80);
		}
	});

	it("requiredRunsPerSide returns the MINIMAL sufficient n (sound + tight)", () => {
		const rand = lcg(23);
		for (let trial = 0; trial < 300; trial++) {
			const noises: TaskNoise[] = Array.from(
				{ length: 1 + Math.floor(rand() * 4) },
				(_, i) => ({ taskId: `t${i}`, n: 3, variance: 1 + rand() ** 3 * 1e7 }),
			);
			const rent = 1 + Math.floor(rand() * 100);
			const target = 2 * effectiveRent(rent) + rand() * 50_000;
			const need = requiredRunsPerSide(target, noises, rent, Z_POWER_90);
			if (need === null) continue;
			// Sound: the returned n really does detect the target.
			expect(
				minDetectableSaving(need, noises, rent, Z_POWER_90),
			).toBeLessThanOrEqual(target + 1e-9);
			// Tight: one fewer run would not have.
			if (need > 2) {
				expect(
					minDetectableSaving(need - 1, noises, rent, Z_POWER_90),
				).toBeGreaterThan(target);
			}
		}
	});

	it("powerAt is a probability, monotone increasing in the true saving", () => {
		const rand = lcg(29);
		for (let trial = 0; trial < 300; trial++) {
			const noises: TaskNoise[] = Array.from(
				{ length: 1 + Math.floor(rand() * 4) },
				(_, i) => ({ taskId: `t${i}`, n: 3, variance: 1 + rand() ** 3 * 1e7 }),
			);
			const rent = 1 + Math.floor(rand() * 100);
			const n = 2 + Math.floor(rand() * 20);
			const d = rand() * 40_000;
			const p = powerAt(n, d, noises, rent);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThanOrEqual(1);
			// A bigger true saving is never harder to detect.
			expect(powerAt(n, d + 500, noises, rent)).toBeGreaterThanOrEqual(p);
		}
	});

	it("more runs raise power ABOVE the bar and cut false promotion BELOW it", () => {
		// power(d,n) = Phi((d-bar)/SE(n) - z), and SE decreases in n. The sign of
		// (d - bar) therefore sets the direction: above the bar extra runs buy
		// detection, below it they buy PROTECTION — the probability of promoting
		// a rule that does not really clear 2x rent falls as the measurement
		// sharpens. Monotone-increasing-in-n holds only on the upper branch.
		const rand = lcg(37);
		for (let trial = 0; trial < 200; trial++) {
			const noises: TaskNoise[] = Array.from(
				{ length: 1 + Math.floor(rand() * 4) },
				(_, i) => ({ taskId: `t${i}`, n: 3, variance: 1 + rand() ** 3 * 1e7 }),
			);
			const rent = 1 + Math.floor(rand() * 100);
			const n = 2 + Math.floor(rand() * 20);
			const barAt = 2 * effectiveRent(rent);
			const above = barAt + 1 + rand() * 20_000;
			const below = barAt - (1 + rand() * (barAt - 1));
			expect(powerAt(n + 1, above, noises, rent)).toBeGreaterThanOrEqual(
				powerAt(n, above, noises, rent),
			);
			expect(powerAt(n + 1, below, noises, rent)).toBeLessThanOrEqual(
				powerAt(n, below, noises, rent),
			);
		}
	});

	it("is TOTAL at zero measured noise — a step function, never NaN", () => {
		// Every replicate of every task identical => SE = 0. The normal-CDF form
		// evaluates 0/0 at exactly trueSaving == bar, which used to surface as
		// "achieved power at target N: NaN%". With an exact estimate the gate is
		// simply `delta >= bar`, so power is 1 at and above the bar, 0 below.
		const flat: TaskNoise[] = [
			{ taskId: "a", n: 3, variance: 0 },
			{ taskId: "b", n: 3, variance: 0 },
		];
		// rent 8 makes the bar exactly 17 (2 * 8 * 1.0625), so the boundary is
		// reachable by an integer --target-saving.
		const zeroRent = 8;
		const zeroBar = 2 * effectiveRent(zeroRent);
		expect(zeroBar).toBe(17);
		expect(seAt(3, flat)).toBe(0);
		expect(powerAt(3, zeroBar - 1, flat, zeroRent)).toBe(0);
		expect(powerAt(3, zeroBar, flat, zeroRent)).toBe(1);
		expect(powerAt(3, zeroBar + 1, flat, zeroRent)).toBe(1);
	});

	it("renders a finite achieved-power figure at zero noise (no NaN%)", () => {
		const flat: TaskNoise[] = [
			{ taskId: "a", n: 3, variance: 0 },
			{ taskId: "b", n: 3, variance: 0 },
		];
		const out = renderPower("sql", flat, 8, { targetSaving: 17, runs: 3 });
		expect(out).not.toContain("NaN");
	});
});

describe("defaultRent", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-power-rent-"));
		db = openDb(join(dir, "warden.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function activeRule(contextCost: number): void {
		const id = insertRule(db, {
			agent: "sql",
			body: `Rule at cost ${contextCost}.`,
			contextCost,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, id, "active", 1000, "earned", "t");
	}

	it("falls back to 25 with no active rules", () => {
		expect(defaultRent(db, "sql")).toBe(25);
	});

	it("takes the median context cost of active rules (odd and even counts)", () => {
		activeRule(10);
		activeRule(100);
		activeRule(20);
		// A still-candidate rule is not deployed and must not shift the median.
		insertRule(db, {
			agent: "sql",
			body: "Undecided.",
			contextCost: 9999,
			sourceRun: null,
			createdAt: "t",
		});
		expect(defaultRent(db, "sql")).toBe(20);
		activeRule(40);
		expect(defaultRent(db, "sql")).toBe(30);
	});
});

describe("parsePowerArgs", () => {
	it("parses the full flag set", () => {
		expect(
			parsePowerArgs([
				"--agent",
				"sql",
				"--target-saving",
				"5000",
				"--rent",
				"30",
				"--runs",
				"6",
				"--json",
			]),
		).toEqual({
			agent: "sql",
			targetSaving: 5000,
			rent: 30,
			runs: 6,
			json: true,
		});
	});

	it("defaults to all agents and no options", () => {
		expect(parsePowerArgs([])).toEqual({
			agent: null,
			targetSaving: null,
			rent: null,
			runs: null,
			json: false,
		});
	});

	it("rejects bad input", () => {
		expect(() => parsePowerArgs(["--agent", "nope"])).toThrow(/--agent/);
		expect(() => parsePowerArgs(["--agent"])).toThrow(/--agent/);
		expect(() => parsePowerArgs(["--target-saving", "0"])).toThrow(
			/--target-saving/,
		);
		expect(() => parsePowerArgs(["--target-saving", "1.5"])).toThrow(
			/--target-saving/,
		);
		expect(() => parsePowerArgs(["--rent", "-3"])).toThrow(/--rent/);
		expect(() => parsePowerArgs(["--runs", "1"])).toThrow(/--runs/);
		expect(() => parsePowerArgs(["--bogus"])).toThrow(/unknown flag/);
	});
});

describe("renderPower", () => {
	it("marks a clearing-but-unreachable target as needing > 500 runs/side", () => {
		const noisy: TaskNoise[] = [
			{ taskId: "x", n: 2, variance: 1e12 },
			{ taskId: "y", n: 2, variance: 1e12 },
		];
		const bar = 2 * effectiveRent(RENT);
		const out = renderPower("sql", noisy, RENT, {
			targetSaving: Math.ceil(bar) + 1,
			runs: null,
		});
		expect(out).toContain("needs > 500 runs/side at 80% power");
	});

	it("reports insufficient history below 2 tasks", () => {
		const out = renderPower("backend", [], 25, {
			targetSaving: null,
			runs: null,
		});
		expect(out).toContain("insufficient replicate history for backend");
		expect(out).toContain("/warden-bench --agent backend");
		expect(out).not.toContain("runs/side");
	});
});

describe("main (in-process CLI)", () => {
	let dir: string;
	let logSpy: MockInstance;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-power-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	function output(): string {
		return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
	}

	/** Two golden tasks x three completed active-set replicates for sql, all
	 * at one ruleset version and model — the minimum plannable history. The
	 * other three agents stay empty to exercise the insufficient-history path. */
	function seeded(): void {
		const db = openDb();
		try {
			const tasks: Array<[string, number[]]> = [
				["sql-01", [1000, 1010, 1020]],
				["sql-02", [2000, 2030, 2060]],
			];
			for (const [taskHash, totals] of tasks) {
				totals.forEach((inputTokens, i) => {
					upsertRun(db, {
						agent: "sql",
						sessionId: `${taskHash}-run-${i}`,
						taskHash,
						inputTokens,
						outputTokens: 0,
						cacheCreation: 0,
						cacheRead: 0,
						toolCalls: 1,
						fileRereads: 0,
						completed: true,
						rulesetVersion: 3,
						ts: `2026-06-0${i + 1}T00:00:00.000Z`,
						config: "active",
						model: "sonnet",
					});
				});
			}
		} finally {
			db.close();
		}
	}

	it("renders the table for seeded sql and the insufficient line elsewhere", () => {
		seeded();
		expect(main([])).toBe(0);
		const out = output();
		expect(out).toContain("power plan — sql");
		expect(out).toContain("runs/side");
		expect(out).toContain("MDS@80%");
		expect(out).toContain("insufficient replicate history for frontend");
		expect(out).toContain("Neyman top-up only tightens the SE");
	});

	it("honors --rent as the planning rent", () => {
		seeded();
		expect(main(["--agent", "sql", "--rent", "100"])).toBe(0);
		expect(output()).toContain("rent: 100");
	});

	it("reports required runs for a clearing target and rejects a sub-bar one", () => {
		seeded();
		expect(main(["--agent", "sql", "--target-saving", "999999"])).toBe(0);
		expect(output()).toContain("needs 2 runs/side at 80% power");
		logSpy.mockClear();
		// Default rent 25 puts the bar above 50; a 10-token target never clears.
		expect(main(["--agent", "sql", "--target-saving", "10"])).toBe(0);
		expect(output()).toContain(
			"does not clear the 2x-rent bar — no run count can detect it",
		);
	});

	it("reports MDS and achieved power at --runs", () => {
		seeded();
		expect(
			main(["--agent", "sql", "--runs", "6", "--target-saving", "5000"]),
		).toBe(0);
		const out = output();
		expect(out).toContain("at n=6 runs/side: MDS@80%");
		expect(out).toContain("achieved power at target 5,000");
		logSpy.mockClear();
		expect(main(["--agent", "sql", "--runs", "4"])).toBe(0);
		const solo = output();
		expect(solo).toContain("at n=4 runs/side: MDS@80%");
		expect(solo).not.toContain("achieved power");
	});

	it("emits parseable --json with rows, target fields, and empty-history agents", () => {
		seeded();
		expect(main(["--json", "--target-saving", "999999", "--runs", "3"])).toBe(
			0,
		);
		const parsed = JSON.parse(output()) as Array<{
			agent: string;
			tasks: number;
			bar: number;
			rows: unknown[];
			requiredRuns80?: number | null;
			powerAtRuns?: number;
		}>;
		expect(parsed).toHaveLength(4);
		const sql = parsed.find((p) => p.agent === "sql");
		expect(sql?.tasks).toBe(2);
		expect(sql?.rows).toHaveLength(5);
		expect(sql?.requiredRuns80).toBe(2);
		expect(sql?.powerAtRuns).toBeGreaterThan(0.99);
		const frontend = parsed.find((p) => p.agent === "frontend");
		expect(frontend?.rows).toHaveLength(0);
		expect(frontend?.requiredRuns80).toBeUndefined();
	});

	it("omits powerAtRuns in --json when --runs is not given", () => {
		seeded();
		expect(
			main(["--json", "--agent", "sql", "--target-saving", "999999"]),
		).toBe(0);
		const parsed = JSON.parse(output()) as Array<{
			requiredRuns80?: number | null;
			powerAtRuns?: number;
		}>;
		expect(parsed[0]?.requiredRuns80).toBe(2);
		expect(parsed[0]?.powerAtRuns).toBeUndefined();
	});

	it("uses z = confidenceZ() in the header", () => {
		seeded();
		expect(main(["--agent", "sql"])).toBe(0);
		expect(output()).toContain(`z: ${confidenceZ()}`);
	});
});
