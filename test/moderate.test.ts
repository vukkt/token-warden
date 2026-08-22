import { describe, expect, it } from "vitest";
import {
	digamma,
	moderateVariances,
	trigamma,
	trigammaInverse,
} from "../src/moderate.js";

function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (1664525 * s + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** One chi-square(df) draw, as a sum of squared standard normals. Exact for
 * the integer degrees of freedom this suite ever uses. */
function chiSquare(df: number, rand: () => number): number {
	let total = 0;
	for (let i = 0; i < df; i++) {
		const u = Math.max(rand(), Number.EPSILON);
		const v = rand();
		const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
		total += z * z;
	}
	return total;
}

describe("digamma", () => {
	// Reference values: psi(1) = -gamma, psi(1/2) = -gamma - 2ln2.
	const EULER_MASCHERONI = 0.5772156649015329;

	it("matches known values", () => {
		expect(digamma(1)).toBeCloseTo(-EULER_MASCHERONI, 10);
		expect(digamma(0.5)).toBeCloseTo(-EULER_MASCHERONI - 2 * Math.LN2, 10);
		expect(digamma(2)).toBeCloseTo(1 - EULER_MASCHERONI, 10);
		expect(digamma(10)).toBeCloseTo(2.251752589066721, 10);
	});

	it("satisfies the recurrence psi(x+1) = psi(x) + 1/x", () => {
		for (const x of [0.25, 0.9, 1.5, 3.3, 7.7, 20.1]) {
			expect(digamma(x + 1)).toBeCloseTo(digamma(x) + 1 / x, 10);
		}
	});
});

describe("trigamma", () => {
	it("matches known values", () => {
		// psi'(1) = pi^2/6, psi'(1/2) = pi^2/2.
		expect(trigamma(1)).toBeCloseTo(Math.PI ** 2 / 6, 10);
		expect(trigamma(0.5)).toBeCloseTo(Math.PI ** 2 / 2, 10);
		expect(trigamma(2)).toBeCloseTo(Math.PI ** 2 / 6 - 1, 10);
	});

	it("satisfies the recurrence psi'(x+1) = psi'(x) - 1/x^2", () => {
		for (const x of [0.3, 1.1, 2.7, 6.5, 15.2]) {
			expect(trigamma(x + 1)).toBeCloseTo(trigamma(x) - 1 / (x * x), 10);
		}
	});

	it("is positive and strictly decreasing", () => {
		let previous = Number.POSITIVE_INFINITY;
		for (let x = 0.1; x < 30; x += 0.1) {
			const value = trigamma(x);
			expect(value).toBeGreaterThan(0);
			expect(value).toBeLessThan(previous);
			previous = value;
		}
	});
});

describe("trigammaInverse", () => {
	it("inverts trigamma", () => {
		for (const x of [0.05, 0.5, 1, 2.5, 10, 100]) {
			expect(trigammaInverse(trigamma(x))).toBeCloseTo(x, 6);
		}
	});

	it("returns infinity at or below zero -- no excess variability", () => {
		expect(trigammaInverse(0)).toBe(Number.POSITIVE_INFINITY);
		expect(trigammaInverse(-1)).toBe(Number.POSITIVE_INFINITY);
		expect(trigammaInverse(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("moderateVariances", () => {
	it("returns inputs unchanged when there is nothing to borrow from", () => {
		expect(moderateVariances([5], [2]).moderated).toEqual([5]);
		expect(moderateVariances([], []).moderated).toEqual([]);
	});

	it("keeps every moderated variance between the task's own and the prior", () => {
		const variances = [1, 4, 9, 16, 25, 36, 49, 64];
		const dfs = variances.map(() => 2);
		const out = moderateVariances(variances, dfs);
		for (let i = 0; i < variances.length; i++) {
			const own = variances[i] as number;
			const got = out.moderated[i] as number;
			const low = Math.min(own, out.priorVariance);
			const high = Math.max(own, out.priorVariance);
			expect(got).toBeGreaterThanOrEqual(low - 1e-9);
			expect(got).toBeLessThanOrEqual(high + 1e-9);
		}
	});

	it("pulls extreme variances toward the middle", () => {
		const variances = [1, 10, 10, 10, 10, 10, 10, 100];
		const out = moderateVariances(
			variances,
			variances.map(() => 2),
		);
		const first = out.moderated[0] as number;
		const last = out.moderated[7] as number;
		// The quiet task is pulled up and the loud one pulled down.
		expect(first).toBeGreaterThan(1);
		expect(last).toBeLessThan(100);
	});

	it("adds the prior degrees of freedom to every task", () => {
		const variances = [2, 5, 11, 3, 7, 19];
		const dfs = variances.map(() => 2);
		const out = moderateVariances(variances, dfs);
		if (Number.isFinite(out.priorDf)) {
			for (let i = 0; i < dfs.length; i++) {
				expect(out.moderatedDf[i]).toBeCloseTo(2 + out.priorDf, 9);
			}
		}
	});

	it("rescues a task that could not estimate its own variance", () => {
		// A zero variance is what a task with identical runs reports; without
		// moderation it would claim perfect certainty.
		const out = moderateVariances([0, 4, 9, 16, 25], [2, 2, 2, 2, 2]);
		expect(out.moderated[0]).toBeGreaterThan(0);
		expect(out.moderated[0]).toBeCloseTo(out.priorVariance, 9);
	});

	/**
	 * Identical variances leave no excess spread to explain, so the fitted prior
	 * is infinitely strong and every task takes the same scale -- the degenerate
	 * end of the continuum.
	 *
	 * That common scale is NOT the observed 7. An earlier version of this test
	 * asserted it was, which is the natural intuition and the wrong one: the fit
	 * is on log s^2, and `exp(E[log X]) != E[X]` for a chi-square. At 2 degrees
	 * of freedom the gap is a factor of `e^gamma ~ 1.78`, so six observations of
	 * 7 are most consistent with a true variance near 12.5. The invariant worth
	 * pinning is homogeneity -- one scale, shared by everyone -- not a
	 * particular number that the model has no reason to produce.
	 */
	it("hands every task the same scale when the suite looks homogeneous", () => {
		const out = moderateVariances([7, 7, 7, 7, 7, 7], [2, 2, 2, 2, 2, 2]);
		expect(out.priorDf).toBe(Number.POSITIVE_INFINITY);
		for (const v of out.moderated) expect(v).toBeCloseTo(out.priorVariance, 9);
		expect(new Set(out.moderated).size).toBe(1);
		// The log-scale correction, stated explicitly so the factor is not a
		// mystery if this ever moves.
		expect(out.priorVariance).toBeCloseTo(7 * Math.exp(0.5772156649015329), 6);
	});

	/**
	 * The degenerate-variance rescue on the FINITE-prior path.
	 *
	 * The zero-variance test above does not reach it: variances [0,4,9,16,25]
	 * are homogeneous enough on the log scale that the fitted prior comes back
	 * INFINITE, and the infinite-prior branch handles the task first. Reaching
	 * the finite branch needs a genuinely heterogeneous suite (excess log-spread
	 * above trigamma(d/2)) that ALSO contains a task with no usable variance.
	 */
	it("gives a degenerate task the fitted prior when the prior is finite", () => {
		const out = moderateVariances(
			[0, 1, 100, 10_000, 1_000_000],
			[2, 2, 2, 2, 2],
		);
		expect(Number.isFinite(out.priorDf)).toBe(true);
		expect(out.moderated[0]).toBeCloseTo(out.priorVariance, 9);
		expect(out.moderatedDf[0]).toBeCloseTo(out.priorDf, 9);
		// The tasks that CAN estimate their own variance still blend rather than
		// being replaced outright.
		expect(out.moderated[4]).not.toBeCloseTo(out.priorVariance, 6);
	});

	it("leaves a suite of wildly different scales largely alone", () => {
		// Genuinely heterogeneous tasks carry real signal about their own
		// noise, so the fitted prior should be weak and shrinkage mild.
		const variances = [1, 100, 10_000, 1_000_000];
		const out = moderateVariances(
			variances,
			variances.map(() => 2),
		);
		expect(out.priorDf).toBeLessThan(4);
	});

	/**
	 * THE CLAIM THE MODULE EXISTS FOR, measured rather than asserted.
	 *
	 * Draw true per-task variances from a spread, draw sample variances from
	 * chi-square(2) around them -- exactly what runs=3 gives -- and compare the
	 * error of the raw sample variance against the moderated one. Moderation
	 * must win on total squared error in log space, which is the scale the
	 * model is fitted on and the scale that matters for a multiplicative
	 * quantity like a variance.
	 */
	it("beats the raw sample variance on estimation error", () => {
		const rand = lcg(20260822);
		const TRIALS = 400;
		const TASKS = 10;
		const DF = 2; // runs = 3

		let rawError = 0;
		let moderatedError = 0;
		for (let trial = 0; trial < TRIALS; trial++) {
			const truth: number[] = [];
			const sample: number[] = [];
			for (let t = 0; t < TASKS; t++) {
				// True variances spread over an order of magnitude.
				const sigma2 = Math.exp(Math.log(1000) + (rand() - 0.5) * 2);
				truth.push(sigma2);
				sample.push((sigma2 * chiSquare(DF, rand)) / DF);
			}
			const out = moderateVariances(
				sample,
				sample.map(() => DF),
			);
			for (let t = 0; t < TASKS; t++) {
				const trueValue = truth[t] as number;
				rawError += Math.log((sample[t] as number) / trueValue) ** 2;
				moderatedError +=
					Math.log((out.moderated[t] as number) / trueValue) ** 2;
			}
		}
		expect(moderatedError).toBeLessThan(rawError);
	});

	/**
	 * The stability claim, which is the mechanism by which a moderated gate
	 * would be better calibrated: moderated variances vary far less from
	 * replicate to replicate than raw ones do.
	 */
	it("produces a markedly more stable estimate across replicates", () => {
		const rand = lcg(4242);
		const TASKS = 10;
		const DF = 2;
		const truth = Array.from({ length: TASKS }, () => 1000);

		const rawSpread: number[][] = Array.from({ length: TASKS }, () => []);
		const modSpread: number[][] = Array.from({ length: TASKS }, () => []);
		for (let trial = 0; trial < 300; trial++) {
			const sample = truth.map((s) => (s * chiSquare(DF, rand)) / DF);
			const out = moderateVariances(
				sample,
				sample.map(() => DF),
			);
			for (let t = 0; t < TASKS; t++) {
				(rawSpread[t] as number[]).push(Math.log(sample[t] as number));
				(modSpread[t] as number[]).push(Math.log(out.moderated[t] as number));
			}
		}
		const spread = (xs: number[]) => {
			const m = xs.reduce((a, b) => a + b, 0) / xs.length;
			return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
		};
		const rawTotal = rawSpread.reduce((a, xs) => a + spread(xs), 0);
		const modTotal = modSpread.reduce((a, xs) => a + spread(xs), 0);
		expect(modTotal).toBeLessThan(rawTotal / 2);
	});

	it("never returns a non-positive or non-finite variance for usable input", () => {
		const rand = lcg(11);
		for (let trial = 0; trial < 200; trial++) {
			const n = 2 + Math.floor(rand() * 10);
			const variances = Array.from({ length: n }, () => rand() * 1e6);
			const dfs = Array.from({ length: n }, () => 1 + Math.floor(rand() * 5));
			for (const v of moderateVariances(variances, dfs).moderated) {
				expect(Number.isFinite(v)).toBe(true);
				expect(v).toBeGreaterThan(0);
			}
		}
	});
});
