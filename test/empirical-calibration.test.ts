import { beforeEach, describe, expect, it } from "vitest";
import { summarizeTask, type TaskSummary } from "../src/bench.js";
import type { GoldenReplicateRun } from "../src/db.js";
import {
	bootstrapTrial,
	candidateKept,
	groupReplicates,
	parseEmpiricalArgs,
	permutationTrial,
	type ReplicateGroup,
	wilson,
} from "../validation/empirical-calibration.js";

/** Local mulberry32 so trial-level tests are deterministic (same generator as
 * the harness, duplicated for the same executes-on-import reason). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function row(
	taskHash: string,
	rulesetVersion: number,
	model: string,
	total: number,
): GoldenReplicateRun {
	return { taskHash, rulesetVersion, model, total };
}

function summary(
	taskId: string,
	tokens: number[],
	completed = true,
): TaskSummary {
	return summarizeTask(
		taskId,
		tokens.map((t, i) => ({
			sessionId: `${taskId}-${i}`,
			tokens: t,
			completed,
		})),
	);
}

beforeEach(() => {
	// The uncertainty band width depends on WARDEN_CONFIDENCE_Z; these
	// false-positive assertions are calibrated for the default z=2.
	delete process.env.WARDEN_CONFIDENCE_Z;
});

describe("groupReplicates", () => {
	it("keeps only the single largest group per task", () => {
		const rows = [
			row("a", 1, "m", 100),
			row("a", 1, "m", 110),
			row("a", 2, "m", 200),
			row("a", 2, "m", 210),
			row("a", 2, "m", 220),
			row("a", 2, "m", 230),
			row("a", 2, "m", 240),
		];
		const groups = groupReplicates(rows, 2);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.taskId).toBe("a");
		expect(groups[0]?.totals).toEqual([200, 210, 220, 230, 240]);
	});

	it("a task split across ruleset versions yields one group, not a merge", () => {
		const rows = [
			row("a", 1, "m", 100),
			row("a", 1, "m", 110),
			row("a", 1, "m", 120),
			row("a", 2, "m", 900),
			row("a", 2, "m", 910),
		];
		const groups = groupReplicates(rows, 2);
		expect(groups).toHaveLength(1);
		// Largest group (v1, three runs) wins; v2 runs are NOT pooled in.
		expect(groups[0]?.totals).toEqual([100, 110, 120]);
	});

	it("drops groups below minRuns and sorts by taskId", () => {
		const rows = [
			row("z", 1, "m", 500),
			row("z", 1, "m", 510),
			row("b", 1, "m", 300),
			row("b", 1, "m", 310),
			row("lonely", 1, "m", 999),
		];
		const groups = groupReplicates(rows, 2);
		expect(groups.map((g) => g.taskId)).toEqual(["b", "z"]);
	});

	it("splits on model too: same task+version under two models never pools", () => {
		const rows = [
			row("a", 1, "haiku", 100),
			row("a", 1, "haiku", 110),
			row("a", 1, "sonnet", 200),
			row("a", 1, "sonnet", 210),
			row("a", 1, "sonnet", 220),
		];
		const groups = groupReplicates(rows, 2);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.totals).toEqual([200, 210, 220]);
	});
});

/** A wide-spread pool (hardcoded once, ~60k mean with heavy scatter and a
 * couple of derailment-looking blow-ups) — the A/A null under ugly real-ish
 * noise. Three tasks, 12 replicates each. */
const NOISY_GROUPS: ReplicateGroup[] = [
	{
		taskId: "t0",
		totals: [
			42000, 71000, 55000, 96000, 48000, 62000, 39000, 58000, 83000, 51000,
			67000, 45000,
		],
	},
	{
		taskId: "t1",
		totals: [
			30000, 44000, 61000, 38000, 52000, 90000, 41000, 35000, 57000, 47000,
			33000, 66000,
		],
	},
	{
		taskId: "t2",
		totals: [
			75000, 50000, 63000, 46000, 88000, 54000, 70000, 43000, 59000, 49000,
			65000, 40000,
		],
	},
];

describe("permutationTrial (A/A false-positive rate)", () => {
	it("keeps a zero-effect split rarely on a homogeneous noisy pool", () => {
		const rng = mulberry32(1234);
		const trials = 300;
		let kept = 0;
		for (let i = 0; i < trials; i++) {
			if (permutationTrial(rng, NOISY_GROUPS, 2, 25)) kept++;
		}
		// True delta is 0 by construction; at z=2 the keep rate estimates the
		// false-positive rate and should sit near a few percent.
		expect(kept / trials).toBeLessThan(0.15);
	});
});

describe("bootstrapTrial", () => {
	it("A/A (injected saving 0) keeps rarely on the same noisy pool", () => {
		const rng = mulberry32(5678);
		const trials = 300;
		let kept = 0;
		for (let i = 0; i < trials; i++) {
			if (bootstrapTrial(rng, NOISY_GROUPS, 2, 25, 0)) kept++;
		}
		expect(kept / trials).toBeLessThan(0.15);
	});

	it("keeps a huge injected saving reliably on a tight pool (power)", () => {
		// Low run-to-run spread so a 30%-of-mean saving dwarfs the noise.
		const tight: ReplicateGroup[] = [
			{
				taskId: "t0",
				totals: [
					50000, 50200, 49800, 50100, 49900, 50300, 49700, 50050, 49950, 50150,
					49850, 50000,
				],
			},
			{
				taskId: "t1",
				totals: [
					40000, 40160, 39840, 40080, 39920, 40240, 39760, 40040, 39960, 40120,
					39880, 40000,
				],
			},
		];
		const rng = mulberry32(4242);
		const trials = 300;
		let kept = 0;
		for (let i = 0; i < trials; i++) {
			if (bootstrapTrial(rng, tight, 3, 25, 13500)) kept++;
		}
		expect(kept / trials).toBeGreaterThan(0.8);
	});
});

describe("candidateKept", () => {
	it("returns false on a regression (a task with zero completed with-side runs)", () => {
		const without = [summary("t0", [1000, 1100]), summary("t1", [2000, 2100])];
		const withRule = [
			summary("t0", [400, 450]),
			summary("t1", [500, 550], false),
		];
		expect(candidateKept(without, withRule, 25, null)).toBe(false);
	});

	it("returns false when the delta is null (no comparable completed runs)", () => {
		const without = [summary("t0", [1000, 1100], false)];
		const withRule = [summary("t0", [400, 450])];
		expect(candidateKept(without, withRule, 25, null)).toBe(false);
	});

	it("keeps a decisive saving without needing a top-up", () => {
		const without = [
			summary("t0", [10000, 10050, 9950]),
			summary("t1", [8000, 8040, 7960]),
		];
		const withRule = [
			summary("t0", [5000, 5050, 4950]),
			summary("t1", [4000, 4040, 3960]),
		];
		expect(candidateKept(without, withRule, 25, null)).toBe(true);
	});
});

describe("wilson", () => {
	it("hugs zero for 0/100 keeps", () => {
		const w = wilson(0, 100);
		expect(w.lo).toBeCloseTo(0, 6);
		expect(w.hi).toBeLessThan(0.05);
	});

	it("straddles the point estimate at 50/100", () => {
		const w = wilson(50, 100);
		expect(w.lo).toBeLessThan(0.5);
		expect(w.hi).toBeGreaterThan(0.5);
	});

	it("degenerates gracefully at n=0", () => {
		expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
	});
});

describe("parseEmpiricalArgs", () => {
	it("defaults: both modes, 2000 trials, perm 2 / boot 3 runs, rent 25, seed 42", () => {
		const args = parseEmpiricalArgs([]);
		expect(args.mode).toBe("both");
		expect(args.trials).toBe(2000);
		expect(args.permRuns).toBe(2);
		expect(args.bootRuns).toBe(3);
		expect(args.rent).toBe(25);
		expect(args.seed).toBe(42);
		expect(args.agent).toBeNull();
	});

	it("--runs overrides both sides at once", () => {
		const args = parseEmpiricalArgs(["--runs", "4"]);
		expect(args.permRuns).toBe(4);
		expect(args.bootRuns).toBe(4);
	});

	it("throws on an unknown flag", () => {
		expect(() => parseEmpiricalArgs(["--bogus"])).toThrow(/unknown flag/);
	});

	it("throws on a bad --trials", () => {
		expect(() => parseEmpiricalArgs(["--trials", "zero"])).toThrow(/--trials/);
		expect(() => parseEmpiricalArgs(["--trials", "0"])).toThrow(/--trials/);
	});

	it("throws on a bad --agent and a bad --mode", () => {
		expect(() => parseEmpiricalArgs(["--agent", "nope"])).toThrow(/--agent/);
		expect(() => parseEmpiricalArgs(["--mode", "sideways"])).toThrow(/--mode/);
	});
});
