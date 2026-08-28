import { describe, expect, it } from "vitest";
import {
	coverageValue,
	type PackCandidate,
	packRules,
	type Similarity,
} from "../src/knapsack.js";
import { lcg32 } from "../validation/rng.js";

const rule = (
	id: string,
	contextCost: number,
	saving: number,
	forced = false,
): PackCandidate => ({ id, contextCost, saving, forced });

/** Rules sharing a group prefix overlap heavily; across groups, not at all. */
const byGroup: Similarity = (i, m) => {
	if (i.id === m.id) return 1;
	return i.id[0] === m.id[0] ? 0.9 : 0;
};

describe("coverageValue", () => {
	const universe = [rule("a", 10, 100), rule("b", 10, 80), rule("c", 10, 60)];

	it("is zero for the empty set", () => {
		expect(coverageValue([], universe)).toBe(0);
	});

	it("credits each mode to its best covering rule, counted once", () => {
		// Under independence a rule covers only its own mode.
		expect(coverageValue([universe[0] as PackCandidate], universe)).toBe(100);
		expect(
			coverageValue(
				[universe[0] as PackCandidate, universe[1] as PackCandidate],
				universe,
			),
		).toBe(180);
	});

	/**
	 * MONOTONICITY: f(A) <= f(B) whenever A is a subset of B. Required for the
	 * Khuller-Moss-Naor bound; a non-monotone objective would break the proof
	 * the module's docstring cites.
	 */
	it("is monotone under set inclusion", () => {
		const rand = lcg32(7);
		for (let trial = 0; trial < 200; trial++) {
			const pool = Array.from({ length: 6 }, (_, i) =>
				rule(`${"xy"[i % 2]}${i}`, 1 + rand() * 20, rand() * 100),
			);
			const subset = pool.filter(() => rand() < 0.5);
			const extra = pool.find((p) => !subset.includes(p));
			if (!extra) continue;
			const smaller = coverageValue(subset, pool, byGroup);
			const larger = coverageValue([...subset, extra], pool, byGroup);
			expect(larger).toBeGreaterThanOrEqual(smaller - 1e-9);
		}
	});

	/**
	 * SUBMODULARITY, checked directly: for A subset of B, the marginal gain of
	 * adding x to A is at least its gain when added to B. Diminishing returns.
	 * This is the property the whole module claims and the one that would
	 * quietly fail if the objective were replaced by a plausible-looking
	 * discount rule instead of a facility-location function.
	 */
	it("has diminishing returns -- the submodularity inequality holds", () => {
		const rand = lcg32(99);
		for (let trial = 0; trial < 500; trial++) {
			const pool = Array.from({ length: 7 }, (_, i) =>
				rule(`${"xyz"[i % 3]}${i}`, 1 + rand() * 20, rand() * 100),
			);
			const a: PackCandidate[] = [];
			const b: PackCandidate[] = [];
			for (const p of pool) {
				// Build A as a subset of B.
				if (rand() < 0.4) {
					a.push(p);
					b.push(p);
				} else if (rand() < 0.5) {
					b.push(p);
				}
			}
			const x = pool.find((p) => !b.includes(p));
			if (!x) continue;
			const gainOnA =
				coverageValue([...a, x], pool, byGroup) -
				coverageValue(a, pool, byGroup);
			const gainOnB =
				coverageValue([...b, x], pool, byGroup) -
				coverageValue(b, pool, byGroup);
			expect(gainOnA).toBeGreaterThanOrEqual(gainOnB - 1e-9);
		}
	});

	/**
	 * The non-negativity precondition, checked on the properties it protects
	 * rather than on the clamp itself. A rule on probation is active with a
	 * NEGATIVE `measured_delta`, and an unclamped negative mode weight makes
	 * `s_m * max` supermodular -- monotonicity and diminishing returns both
	 * invert on that mode. The savings here are drawn to straddle zero, so most
	 * trials carry at least one.
	 */
	it("stays monotone and submodular when a mode was measured negative", () => {
		const rand = lcg32(31);
		for (let trial = 0; trial < 500; trial++) {
			const pool = Array.from({ length: 6 }, (_, i) =>
				rule(`${"xy"[i % 2]}${i}`, 1 + rand() * 20, rand() * 150 - 50),
			);
			const a: PackCandidate[] = [];
			const b: PackCandidate[] = [];
			for (const p of pool) {
				if (rand() < 0.4) {
					a.push(p);
					b.push(p);
				} else if (rand() < 0.5) {
					b.push(p);
				}
			}
			const x = pool.find((p) => !b.includes(p));
			if (!x) continue;
			const onA = coverageValue(a, pool, byGroup);
			const onB = coverageValue(b, pool, byGroup);
			expect(coverageValue([...a, x], pool, byGroup)).toBeGreaterThanOrEqual(
				onA - 1e-9,
			);
			expect(
				coverageValue([...a, x], pool, byGroup) - onA,
			).toBeGreaterThanOrEqual(
				coverageValue([...b, x], pool, byGroup) - onB - 1e-9,
			);
		}
	});

	it("never returns less than zero for a wholly negative universe", () => {
		const pool = [rule("a", 10, -500), rule("b", 10, -20)];
		expect(coverageValue(pool, pool, byGroup)).toBe(0);
	});
});

describe("packRules", () => {
	it("returns nothing for an empty candidate set", () => {
		expect(packRules([], 100)).toEqual({ chosen: [], value: 0, cost: 0 });
	});

	it("never exceeds the budget", () => {
		const rand = lcg32(31);
		for (let trial = 0; trial < 300; trial++) {
			const pool = Array.from({ length: 8 }, (_, i) =>
				rule(`r${i}`, 1 + Math.floor(rand() * 30), rand() * 200),
			);
			const budget = Math.floor(rand() * 100);
			expect(packRules(pool, budget).cost).toBeLessThanOrEqual(budget);
		}
	});

	it("takes nothing when nothing is affordable", () => {
		const out = packRules([rule("a", 100, 500)], 10);
		expect(out.chosen).toEqual([]);
		expect(out.value).toBe(0);
	});

	/**
	 * The graceful-degradation contract. With no similarity data the objective
	 * is modular and this is an ordinary knapsack -- which is what the repo is
	 * entitled to assume, because pairwise rule overlap has never been measured.
	 */
	it("reduces to an ordinary knapsack under the independent default", () => {
		const pool = [rule("a", 10, 100), rule("b", 20, 150), rule("c", 30, 90)];
		const out = packRules(pool, 30);
		// a (density 10) then b would cost 30 total -- exactly the budget.
		expect(out.chosen.sort()).toEqual(["a", "b"]);
		expect(out.value).toBe(250);
		expect(out.cost).toBe(30);
	});

	/**
	 * The behaviour the module exists for: two rules addressing the same waste
	 * mode should not both be carried when the budget could buy genuine breadth
	 * instead.
	 */
	it("drops a redundant rule in favour of one covering a new mode", () => {
		const pool = [
			rule("x1", 10, 100),
			rule("x2", 10, 95), // nearly the same mode as x1
			rule("y1", 10, 90), // a different mode
		];
		const out = packRules(pool, 20, byGroup);
		expect(out.chosen).toContain("x1");
		expect(out.chosen).toContain("y1");
		expect(out.chosen).not.toContain("x2");
	});

	it("carries both when they address genuinely different modes", () => {
		const pool = [rule("x1", 10, 100), rule("y1", 10, 95)];
		const out = packRules(pool, 20, byGroup);
		expect(out.chosen.sort()).toEqual(["x1", "y1"]);
	});

	it("forces protected rules in and spends the rest of the budget around them", () => {
		const pool = [
			rule("protected", 40, 1, true),
			rule("rich", 10, 500),
			rule("poor", 10, 5),
		];
		const out = packRules(pool, 60);
		expect(out.chosen).toContain("protected");
		expect(out.chosen).toContain("rich");
	});

	it("keeps a protected rule even when it alone overruns the budget", () => {
		const out = packRules([rule("protected", 500, 1, true)], 10);
		expect(out.chosen).toEqual(["protected"]);
		expect(out.cost).toBe(500);
	});

	/**
	 * Why the best-single-item guard exists. Density-greedy prefers many cheap
	 * high-density crumbs; without the comparison it would take all of them and
	 * miss the single item that beats the lot. This instance is built so plain
	 * greedy loses.
	 */
	it("prefers one large item over a pile of denser crumbs when it wins", () => {
		const pool = [
			rule("crumb1", 1, 12),
			rule("crumb2", 1, 12),
			rule("crumb3", 1, 12),
			rule("whale", 10, 100),
		];
		const out = packRules(pool, 10);
		expect(out.chosen).toEqual(["whale"]);
		expect(out.value).toBe(100);
	});

	/**
	 * REGRESSION. A rule on probation stays active carrying the negative delta
	 * that put it there. Unclamped, covering its mode is a penalty, and the
	 * penalty falls on whichever rule reads most like it -- so `keeper`, worth
	 * 1,000 tokens a run and comfortably affordable, was dropped from compiled
	 * memory on a measurement that was not its own. Verified against the real
	 * module before the clamp: `chosen` came back empty.
	 */
	it("does not drop a good rule for resembling one measured negative", () => {
		const keeper = rule("keeper", 25, 1000);
		const onProbation = rule("probation", 25, -4000);
		const budget = 25; // Room for exactly one of them.
		// Worded alike: each covers most of the other's mode.
		const alike: Similarity = (i, m) => (i.id === m.id ? 1 : 0.9);
		expect(packRules([keeper, onProbation], budget, alike).chosen).toEqual([
			"keeper",
		]);
	});

	/**
	 * Zero saving does not rank a rule last, it makes it unselectable: greedy
	 * takes a candidate only on density strictly above zero, and so does the
	 * best-single-item guard. `memory.ts` states this in a comment, which is the
	 * kind of claim this module has already been caught making without a check.
	 */
	it("does not carry a rule with no measured saving, even when affordable", () => {
		const out = packRules([rule("unmeasured", 10, 0)], 1000);
		expect(out.chosen).toEqual([]);
		expect(out.cost).toBe(0);
	});

	it("still carries an unmeasured rule when it is protected", () => {
		const out = packRules([rule("unmeasured", 10, 0, true)], 1000);
		expect(out.chosen).toEqual(["unmeasured"]);
	});

	it("is deterministic for the same input", () => {
		const pool = [rule("a", 7, 50), rule("b", 7, 50), rule("c", 9, 61)];
		const first = packRules(pool, 16, byGroup);
		const second = packRules(pool, 16, byGroup);
		expect(first).toEqual(second);
	});
});

/**
 * THE GUARANTEE ITSELF, checked against brute force.
 *
 * Khuller-Moss-Naor promise that density-greedy plus the best-single-item guard
 * returns at least `(1 - 1/e)/2 ~ 0.316` of the optimum for a monotone
 * submodular objective under a knapsack constraint. Small instances let the
 * optimum be computed exactly by enumerating every feasible subset, so the
 * bound can be verified rather than cited.
 *
 * This is the test that would catch a broken density calculation, a greedy that
 * forgot to recompute marginals against the CURRENT chosen set, or a missing
 * best-single guard -- none of which the hand-built cases above would notice.
 */
describe("the Khuller-Moss-Naor bound holds against brute force", () => {
	function brute(
		pool: PackCandidate[],
		budget: number,
		similarity: Similarity,
	): number {
		let best = 0;
		for (let mask = 0; mask < 1 << pool.length; mask++) {
			const subset = pool.filter((_, i) => (mask >> i) & 1);
			const cost = subset.reduce((s, c) => s + c.contextCost, 0);
			if (cost > budget) continue;
			const value = coverageValue(subset, pool, similarity);
			if (value > best) best = value;
		}
		return best;
	}

	const BOUND = (1 - 1 / Math.E) / 2;

	function sweep(similarity: Similarity, seed: number, label: string): void {
		const rand = lcg32(seed);
		let worstRatio = Number.POSITIVE_INFINITY;
		for (let trial = 0; trial < 400; trial++) {
			const n = 4 + Math.floor(rand() * 7);
			const pool = Array.from({ length: n }, (_, i) =>
				rule(
					`${"xyz"[i % 3]}${i}`,
					1 + Math.floor(rand() * 25),
					Math.floor(rand() * 300),
				),
			);
			const budget = 5 + Math.floor(rand() * 60);
			const optimum = brute(pool, budget, similarity);
			if (optimum <= 0) continue;
			const got = packRules(pool, budget, similarity).value;
			worstRatio = Math.min(worstRatio, got / optimum);
		}
		expect(
			worstRatio,
			`${label}: worst greedy/optimum ratio ${worstRatio.toFixed(4)} fell below the (1-1/e)/2 bound`,
		).toBeGreaterThanOrEqual(BOUND);
	}

	it("holds under the independent default (pure knapsack)", () => {
		sweep(() => 0, 2024, "independent");
	});

	it("holds under a real overlap structure", () => {
		sweep(byGroup, 1337, "grouped overlap");
	});

	/** In practice greedy does far better than its worst-case bound; if this
	 * ever regresses to near 0.316 the implementation has degraded even though
	 * the guarantee still technically holds. */
	it("comfortably beats the worst-case bound in practice", () => {
		const rand = lcg32(555);
		let total = 0;
		let count = 0;
		for (let trial = 0; trial < 300; trial++) {
			const n = 4 + Math.floor(rand() * 6);
			const pool = Array.from({ length: n }, (_, i) =>
				rule(
					`${"xy"[i % 2]}${i}`,
					1 + Math.floor(rand() * 20),
					Math.floor(rand() * 200),
				),
			);
			const budget = 5 + Math.floor(rand() * 50);
			const optimum = brute(pool, budget, byGroup);
			if (optimum <= 0) continue;
			total += packRules(pool, budget, byGroup).value / optimum;
			count++;
		}
		expect(total / count).toBeGreaterThan(0.95);
	});
});
