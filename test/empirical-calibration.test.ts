import { beforeEach, describe, expect, it } from "vitest";
import { summarizeTask, type TaskSummary } from "../src/bench.js";
import type { GoldenReplicateRun } from "../src/db.js";
import {
	bootstrapTrial,
	candidateKept,
	type EvictionTrialSpec,
	falseEvictionTrial,
	groupReplicates,
	parseEmpiricalArgs,
	permutationTrial,
	type RecoveryTrialSpec,
	type ReplicateGroup,
	recoveryTrial,
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
		// The failed runs burned real tokens (above the environment-failure
		// floor): a genuine regression.
		const without = [summary("t0", [1000, 1100]), summary("t1", [2000, 2100])];
		const withRule = [
			summary("t0", [400, 450]),
			summary("t1", [5000, 5500], false),
		];
		expect(candidateKept(without, withRule, 25, null)).toBe(false);
	});

	it("returns false on an environment-failed measurement (zero-token failures)", () => {
		// A quota-dead with-side maps to the selector's ABORT — never a keep.
		const without = [summary("t0", [1000, 1100]), summary("t1", [2000, 2100])];
		const withRule = [summary("t0", [400, 450]), summary("t1", [0, 0], false)];
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

describe("falseEvictionTrial", () => {
	const groups: ReplicateGroup[] = [
		{ taskId: "t1", totals: [40000, 42000, 41000, 43000] },
		{ taskId: "t2", totals: [50000, 52000, 51000, 53000] },
		{ taskId: "t3", totals: [46000, 48000, 47000, 45000] },
	];

	const spec = (
		trueSaving: number,
		maxRetentionRounds = 0,
	): EvictionTrialSpec => ({
		groups,
		runsPerSide: 2,
		rent: 25,
		trueSaving,
		cycles: 12,
		maxRetentionRounds,
	});

	it("returns null when a large true saving survives every re-audit", () => {
		// A saving of 20k tokens/run against ~46k totals is far outside the
		// resampling noise, so no cycle should produce two consecutive
		// sub-threshold re-audits.
		const rng = mulberry32(1);
		expect(falseEvictionTrial(rng, spec(20000)).evictedAt).toBeNull();
	});

	it("evicts a rule whose true saving is zero", () => {
		// Zero true saving means every re-audit is measuring noise, so the
		// two-strike policy should bin it — and report the cycle it happened on.
		const rng = mulberry32(2);
		const { evictedAt } = falseEvictionTrial(rng, spec(0));
		expect(evictedAt).not.toBeNull();
		expect(evictedAt).toBeGreaterThanOrEqual(2);
		expect(evictedAt).toBeLessThanOrEqual(12);
	});

	it("never evicts before cycle 2 — one strike is probation, not eviction", () => {
		// The whole point of two-strike retention: a single unlucky re-audit
		// must not be able to bin a rule. If this ever returns 1 the harness
		// has drifted from the real policy in src/select.ts.
		for (let seed = 1; seed <= 200; seed++) {
			const { evictedAt } = falseEvictionTrial(mulberry32(seed), spec(0));
			if (evictedAt !== null) expect(evictedAt).toBeGreaterThanOrEqual(2);
		}
	});

	it("is deterministic for a given seed", () => {
		const a = falseEvictionTrial(mulberry32(7), spec(500));
		const b = falseEvictionTrial(mulberry32(7), spec(500));
		expect(a).toEqual(b);
	});

	it("evicts a small true saving more often than a large one", () => {
		// Power is monotone in effect size. This is the property the reported
		// table rests on, so it is asserted rather than eyeballed.
		const rate = (saving: number): number => {
			let evicted = 0;
			for (let seed = 1; seed <= 150; seed++) {
				if (
					falseEvictionTrial(mulberry32(seed), spec(saving)).evictedAt !== null
				) {
					evicted++;
				}
			}
			return evicted / 150;
		};
		expect(rate(1000)).toBeGreaterThan(rate(15000));
	});

	it("models the re-audit top-up the selector actually spends", () => {
		// The first cut of this harness decided every re-audit on its first look,
		// which the selector has never done. A rule this noisy lands uncertain, so
		// at least one round must be bought even in the control arm.
		const { topUpRounds, reAudits } = falseEvictionTrial(
			mulberry32(3),
			spec(1000),
		);
		expect(reAudits).toBeGreaterThan(0);
		expect(topUpRounds).toBeGreaterThan(0);
	});

	it("the retention budget buys rounds, and buying them costs passes", () => {
		const cost = (maxRounds: number): { evicted: number; rounds: number } => {
			let evicted = 0;
			let rounds = 0;
			let audits = 0;
			for (let seed = 1; seed <= 150; seed++) {
				const r = falseEvictionTrial(mulberry32(seed), spec(1000, maxRounds));
				if (r.evictedAt !== null) evicted++;
				rounds += r.topUpRounds;
				audits += r.reAudits;
			}
			return { evicted, rounds: rounds / audits };
		};
		const control = cost(0);
		const policy = cost(2);
		// More evidence per re-audit, and it is not free.
		expect(policy.rounds).toBeGreaterThan(control.rounds);
		// The whole point: a genuinely earning rule survives more often.
		expect(policy.evicted).toBeLessThanOrEqual(control.evicted);
	});
});

describe("recoveryTrial (the recovery policy's calibration arm)", () => {
	const spec = (overrides: Partial<RecoveryTrialSpec> = {}) => ({
		groups: NOISY_GROUPS,
		runsPerSide: 2,
		recoveryRuns: 4,
		rent: 25,
		injectedSaving: 0,
		...overrides,
	});

	it("never counts one trial twice: a first-look keep takes no second look", () => {
		const rng = mulberry32(31_337);
		for (let i = 0; i < 500; i++) {
			const r = recoveryTrial(rng, spec());
			expect(r.keptFirst && r.keptOnRecovery).toBe(false);
			expect(r.keptFirst && r.inZone).toBe(false);
			// A conversion is only possible from inside the zone.
			if (r.keptOnRecovery) expect(r.inZone).toBe(true);
		}
	});

	it("adds almost nothing to the A/A false-positive rate (published pin)", () => {
		// The number this feature lives or dies by. On the recorded sql pool it
		// is +0.08pt on a 10.7% base at 20,000 trials (FINDINGS.md); this is the
		// same measurement on the committed noisy fixture, pinned EXACTLY so the
		// published claim cannot drift without a test failing.
		const rng = mulberry32(20_260_814);
		const trials = 4000;
		let keptFirst = 0;
		let zone = 0;
		let recovered = 0;
		for (let i = 0; i < trials; i++) {
			const r = recoveryTrial(rng, spec());
			if (r.keptFirst) keptFirst++;
			if (r.inZone) zone++;
			if (r.keptOnRecovery) recovered++;
		}
		expect(keptFirst).toBe(320);
		expect(zone).toBe(608);
		// 2 extra false keeps in 4,000 trials, against the 320 the gate already
		// makes: a 0.6% relative increase in the false-positive rate.
		expect(recovered).toBe(2);
	});

	it("recovers a genuinely large saving that the first look could not resolve", () => {
		const rng = mulberry32(20_260_814);
		const trials = 4000;
		let keptFirst = 0;
		let recovered = 0;
		for (let i = 0; i < trials; i++) {
			const r = recoveryTrial(rng, spec({ injectedSaving: 12_000 }));
			if (r.keptFirst) keptFirst++;
			if (r.keptOnRecovery) recovered++;
		}
		// Same trial count, same pool, same policy: a real effect converts far
		// more often than the null does. That ratio IS the argument for the
		// feature, and it is the thing a threshold change would break.
		expect(keptFirst).toBe(1934);
		// 213 real rules rescued for the 2 null rules admitted above, on the
		// same pool, seed and trial count: a 106:1 marginal ratio, against the
		// gate's own 1934/320 = 6:1.
		expect(recovered).toBe(213);
	});

	it("a stricter second look converts strictly less than a lenient one", () => {
		const count = (): number => {
			const rng = mulberry32(555);
			let recovered = 0;
			for (let i = 0; i < 1500; i++) {
				if (
					recoveryTrial(rng, spec({ injectedSaving: 12_000 })).keptOnRecovery
				) {
					recovered++;
				}
			}
			return recovered;
		};
		const shipped = count();
		process.env.WARDEN_RECOVERY_STRICTNESS = "3";
		try {
			expect(count()).toBeLessThan(shipped);
		} finally {
			delete process.env.WARDEN_RECOVERY_STRICTNESS;
		}
	});
});
