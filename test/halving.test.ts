import { describe, expect, it } from "vitest";
import {
	eliminate,
	halvingRounds,
	halvingSchedule,
	uniformRunsPerArm,
	winnerRuns,
} from "../src/halving.js";

const spend = (schedule: { arms: number; runsPerArm: number }[]) =>
	schedule.reduce((t, r) => t + r.arms * r.runsPerArm, 0);

describe("halvingRounds", () => {
	it("is ceil(log2 n) at eta=2", () => {
		expect(halvingRounds(1)).toBe(1);
		expect(halvingRounds(2)).toBe(1);
		expect(halvingRounds(3)).toBe(2);
		expect(halvingRounds(4)).toBe(2);
		expect(halvingRounds(8)).toBe(3);
		expect(halvingRounds(16)).toBe(4);
	});

	it("respects a different reduction factor", () => {
		expect(halvingRounds(9, 3)).toBe(2);
		expect(halvingRounds(27, 3)).toBe(3);
	});

	it("still measures a single arm", () => {
		expect(halvingRounds(1)).toBe(1);
		expect(halvingRounds(0)).toBe(1);
	});
});

describe("halvingSchedule", () => {
	it("never exceeds the budget", () => {
		for (const n of [1, 2, 3, 4, 5, 8, 13, 32]) {
			for (const budget of [1, 6, 12, 30, 100, 257]) {
				expect(spend(halvingSchedule(n, budget))).toBeLessThanOrEqual(budget);
			}
		}
	});

	it("is empty when the budget cannot buy one run for every arm", () => {
		// 3 arms, 2 runs: the first round cannot give each arm a run, so there
		// is nothing to rank and no schedule to run.
		expect(halvingSchedule(3, 2)).toEqual([]);
		expect(halvingSchedule(10, 0)).toEqual([]);
		expect(halvingSchedule(0, 10)).toEqual([]);
	});

	it("narrows the field geometrically and deepens what is left", () => {
		const schedule = halvingSchedule(8, 48);
		expect(schedule.map((r) => r.arms)).toEqual([8, 4, 2]);
		// Each round gets 48/3 = 16 runs, split among survivors.
		expect(schedule.map((r) => r.runsPerArm)).toEqual([2, 4, 8]);
		expect(spend(schedule)).toBe(48);
	});

	it("gives each round an equal share of the budget", () => {
		const schedule = halvingSchedule(8, 48);
		for (const round of schedule) {
			expect(round.arms * round.runsPerArm).toBe(16);
		}
	});

	/**
	 * The whole point, as an inequality: for the same budget, the arm that
	 * survives to the end is measured more deeply than uniform allocation could
	 * ever afford. That extra depth is where the confidence comes from.
	 */
	it("buys the winner strictly more runs than uniform allocation", () => {
		for (const [n, budget] of [
			[4, 24],
			[8, 48],
			[8, 96],
			[16, 160],
		] as const) {
			const sh = winnerRuns(halvingSchedule(n, budget));
			const uniform = uniformRunsPerArm(n, budget);
			expect(sh).toBeGreaterThan(uniform);
		}
	});

	it("degenerates to a single round for one arm", () => {
		const schedule = halvingSchedule(1, 10);
		expect(schedule).toEqual([{ arms: 1, runsPerArm: 10 }]);
	});

	/**
	 * THE REGRESSION THIS MODULE ACTUALLY HAD. A schedule must MEASURE every arm
	 * before it eliminates any. The first version skipped rounds it could not
	 * afford while still narrowing the field, so `halvingSchedule(7, 9)` returned
	 * `[[2, 1]]` -- five arms discarded without a single measurement, which is
	 * the "eliminating at random" the docstring warned against while the code
	 * did it. Every other test in this file passed throughout.
	 */
	it("never starts a schedule with fewer arms than it was given", () => {
		for (let n = 1; n <= 20; n++) {
			for (const budget of [1, 2, 3, 5, 8, 9, 13, 21, 40, 100]) {
				const schedule = halvingSchedule(n, budget);
				if (schedule.length === 0) continue;
				expect(
					schedule[0]?.arms,
					`n=${n} budget=${budget} began with ${schedule[0]?.arms} arms`,
				).toBe(n);
			}
		}
	});

	it("returns nothing when the first round cannot measure every arm", () => {
		// 7 arms and 9 run-units: the opening round can afford floor(3/7) = 0
		// runs each, so there is no valid plan -- not a plan over 2 arms.
		expect(halvingSchedule(7, 9)).toEqual([]);
		expect(halvingSchedule(8, 9)).toEqual([]);
		expect(halvingSchedule(12, 9)).toEqual([]);
	});

	it("drops rounds it cannot afford rather than emitting empty ones", () => {
		// Any emitted round must be able to measure every arm in it; a round
		// with runsPerArm 0 would rank arms on no data and eliminate at random.
		for (const n of [2, 3, 5, 7, 16]) {
			for (const budget of [1, 2, 3, 5, 9, 17, 40]) {
				for (const round of halvingSchedule(n, budget)) {
					expect(round.runsPerArm).toBeGreaterThanOrEqual(1);
					expect(round.arms).toBeGreaterThanOrEqual(1);
				}
			}
		}
	});

	/**
	 * The FINAL ROUND measures the last `eta` contenders; eliminating after it
	 * is what leaves a single winner. So the invariant is `last.arms <= eta`,
	 * not `last.arms === 1` -- a schedule ending in a one-arm round would have
	 * spent a whole round's budget re-measuring an arm with nothing left to
	 * compare it against.
	 */
	it("ends with a round narrow enough that one elimination decides it", () => {
		for (const n of [2, 3, 4, 5, 8, 9, 16, 31]) {
			const schedule = halvingSchedule(n, 1000);
			const last = schedule.at(-1);
			expect(last?.arms).toBeLessThanOrEqual(2);
			expect(Math.ceil((last?.arms ?? 1) / 2)).toBe(1);
		}
	});

	/** The realistic case for this repo: three candidates from one distiller
	 * invocation, against the default depth of 3 runs a side. */
	it("handles the three-candidate case the distiller actually produces", () => {
		const schedule = halvingSchedule(3, 18);
		expect(spend(schedule)).toBeLessThanOrEqual(18);
		expect(winnerRuns(schedule)).toBeGreaterThan(uniformRunsPerArm(3, 18));
	});
});

describe("eliminate", () => {
	const score = (x: { id: string; v: number }) => x.v;

	it("keeps the better half, highest score first", () => {
		const arms = [
			{ id: "a", v: 1 },
			{ id: "b", v: 9 },
			{ id: "c", v: 5 },
			{ id: "d", v: 3 },
		];
		expect(eliminate(arms, score).map((a) => a.id)).toEqual(["b", "c"]);
	});

	it("rounds the survivor count up, so it never eliminates everything", () => {
		const arms = [
			{ id: "a", v: 1 },
			{ id: "b", v: 2 },
			{ id: "c", v: 3 },
		];
		expect(eliminate(arms, score)).toHaveLength(2);
		expect(eliminate([{ id: "a", v: 1 }], score)).toHaveLength(1);
		expect(eliminate([], score)).toEqual([]);
	});

	it("respects a different reduction factor", () => {
		const arms = Array.from({ length: 9 }, (_, i) => ({
			id: `a${i}`,
			v: i,
		}));
		expect(eliminate(arms, score, 3)).toHaveLength(3);
	});

	/**
	 * Ties break by original position, not by sort implementation. Without
	 * this, re-running an identical measurement could eliminate a different
	 * arm, and a benchmark whose outcome depends on sort internals is not a
	 * measurement.
	 */
	it("breaks ties deterministically by input order", () => {
		const arms = [
			{ id: "a", v: 5 },
			{ id: "b", v: 5 },
			{ id: "c", v: 5 },
			{ id: "d", v: 5 },
		];
		expect(eliminate(arms, score).map((a) => a.id)).toEqual(["a", "b"]);
		// Same scores, different order in -> correspondingly different order out,
		// but still a function of the input alone.
		const shuffled = [arms[3], arms[1], arms[0], arms[2]] as typeof arms;
		expect(eliminate(shuffled, score).map((a) => a.id)).toEqual(["d", "b"]);
	});

	it("does not mutate the caller's array", () => {
		const arms = [
			{ id: "a", v: 1 },
			{ id: "b", v: 9 },
		];
		eliminate(arms, score);
		expect(arms.map((a) => a.id)).toEqual(["a", "b"]);
	});
});

/**
 * End-to-end: drive a full halving run against arms with known true means and
 * check the budget discipline and the directional guarantee from the module
 * docstring.
 */
describe("driving a full halving run", () => {
	function lcg(seed: number): () => number {
		let s = seed >>> 0;
		return () => {
			s = (1664525 * s + 1013904223) >>> 0;
			return s / 4294967296;
		};
	}

	/** Run the schedule over arms whose observations are true mean + noise. */
	function race(
		trueMeans: number[],
		budget: number,
		noise: number,
		seed: number,
	): { winner: number; spent: number } {
		const rand = lcg(seed);
		const schedule = halvingSchedule(trueMeans.length, budget);
		let field = trueMeans.map((mean, index) => ({ mean, index }));
		let spent = 0;
		for (const round of schedule) {
			const observed = new Map<number, number>();
			for (const arm of field) {
				let total = 0;
				for (let r = 0; r < round.runsPerArm; r++) {
					total += arm.mean + (rand() - 0.5) * noise;
				}
				observed.set(arm.index, total / round.runsPerArm);
				spent += round.runsPerArm;
			}
			if (field.length === 1) break;
			field = eliminate(field, (a) => observed.get(a.index) ?? 0);
		}
		return { winner: (field[0] as { index: number }).index, spent };
	}

	it("stays within budget while driving real rounds", () => {
		const { spent } = race([10, 8, 6, 4, 2, 1, 0, -5], 240, 2, 1);
		expect(spent).toBeLessThanOrEqual(240);
	});

	it("finds the best arm when the gap is clear relative to noise", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const { winner } = race([100, 10, 8, 6, 4, 2, 1, 0], 240, 5, seed);
			expect(winner).toBe(0);
		}
	});

	/**
	 * The honest limitation, pinned rather than hidden: with noise large
	 * relative to the gaps, halving can cut the true best arm early. This is
	 * the false-negative risk the module docstring describes, and the reason
	 * an eliminated candidate maps onto the `underpowered` eviction class
	 * (eligible for a second, deeper look) rather than onto a falsified one.
	 */
	it("can eliminate the true best arm under heavy noise", () => {
		const losses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((seed) => {
			const { winner } = race([10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5], 48, 40, seed);
			return winner !== 0;
		});
		expect(losses.length).toBeGreaterThan(0);
	});
});
