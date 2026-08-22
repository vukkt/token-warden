import { describe, expect, it } from "vitest";
import {
	benjaminiHochberg,
	gatePValue,
	lordAlpha,
	lordDecisions,
	lordZ,
} from "../src/fdr.js";
import { normalCdf, normalQuantile } from "../src/stats.js";

/** Deterministic LCG (Numerical Recipes constants) so the Monte-Carlo checks
 * below are reproducible: a flaky statistical test is worse than none. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (1664525 * s + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** Box-Muller, one variate per call from a pair. */
function gaussian(rand: () => number): () => number {
	let spare: number | null = null;
	return () => {
		if (spare !== null) {
			const v = spare;
			spare = null;
			return v;
		}
		const u = Math.max(rand(), Number.EPSILON);
		const v = rand();
		const mag = Math.sqrt(-2 * Math.log(u));
		spare = mag * Math.sin(2 * Math.PI * v);
		return mag * Math.cos(2 * Math.PI * v);
	};
}

const p = (pValue: number, item = `p=${pValue}`) => ({ item, pValue });

describe("gatePValue", () => {
	it("is 0.5 when the estimate sits exactly on the bar", () => {
		expect(gatePValue(100, 100, 10)).toBeCloseTo(0.5, 6);
	});

	it("shrinks as the estimate clears the bar by more standard errors", () => {
		const one = gatePValue(110, 100, 10);
		const two = gatePValue(120, 100, 10);
		const three = gatePValue(130, 100, 10);
		expect(one).toBeCloseTo(0.1587, 3);
		expect(two).toBeCloseTo(0.0228, 3);
		expect(three).toBeLessThan(two);
	});

	it("is above a half when the estimate is below the bar", () => {
		expect(gatePValue(80, 100, 10)).toBeGreaterThan(0.5);
	});

	// The gate's own z=2 rule is "delta - bar >= 2*SE". That must correspond to
	// p <= 0.0228 here, or the FDR layer would be scoring a different hypothesis
	// than the one the project has calibrated against.
	it("agrees with the gate's z=2 promotion margin", () => {
		expect(gatePValue(100 + 2 * 37, 100, 37)).toBeCloseTo(0.0228, 3);
	});

	it("refuses to convert an unmeasurable standard error into significance", () => {
		// A null or zero SE means run-to-run noise could not be estimated. The
		// arithmetic would divide by zero and hand back p=0 -- maximal
		// confidence from a measurement that established nothing.
		expect(gatePValue(9_999_999, 100, null)).toBe(1);
		expect(gatePValue(9_999_999, 100, 0)).toBe(1);
		expect(gatePValue(9_999_999, 100, -5)).toBe(1);
	});
});

describe("benjaminiHochberg", () => {
	it("returns nothing for an empty pool", () => {
		expect(benjaminiHochberg([], 0.1)).toEqual({
			rejected: [],
			retained: [],
			cutoff: null,
		});
	});

	it("reduces to a plain alpha test for a single candidate", () => {
		expect(benjaminiHochberg([p(0.04)], 0.05).rejected).toEqual(["p=0.04"]);
		expect(benjaminiHochberg([p(0.06)], 0.05).rejected).toEqual([]);
	});

	it("rejects nothing when every p-value is large", () => {
		const out = benjaminiHochberg([p(0.4), p(0.6), p(0.9)], 0.05);
		expect(out.rejected).toEqual([]);
		expect(out.retained).toHaveLength(3);
		expect(out.cutoff).toBeNull();
	});

	/**
	 * The step-up property, and the reason the scan runs downward. With
	 * m=4, q=0.05 the thresholds are .0125/.025/.0375/.05. The p-values below
	 * fail at rank 1 (0.02 > 0.0125) but succeed at rank 4 (0.05 <= 0.05), and
	 * BH rejects ALL FOUR. An implementation that scanned upward and stopped at
	 * the first failure would reject none of them.
	 */
	it("admits earlier candidates rescued by a later one clearing its threshold", () => {
		const out = benjaminiHochberg([p(0.02), p(0.03), p(0.04), p(0.05)], 0.05);
		expect(out.rejected).toHaveLength(4);
		expect(out.cutoff).toBe(0.05);
	});

	it("keeps tied p-values on the same side of the decision", () => {
		const out = benjaminiHochberg(
			[p(0.01, "a"), p(0.04, "b"), p(0.04, "c"), p(0.9, "d")],
			0.1,
		);
		// b and c are indistinguishable evidence; splitting them would mean the
		// verdict depended on input order rather than on the data.
		expect(out.rejected).toContain("b");
		expect(out.rejected).toContain("c");
	});

	it("does not depend on input order", () => {
		const pool = [p(0.9, "d"), p(0.01, "a"), p(0.04, "b"), p(0.2, "c")];
		const forward = benjaminiHochberg(pool, 0.1).rejected;
		const backward = benjaminiHochberg([...pool].reverse(), 0.1).rejected;
		expect([...forward].sort()).toEqual([...backward].sort());
	});

	it("leaves the caller's array untouched", () => {
		const pool = [p(0.9, "d"), p(0.01, "a")];
		benjaminiHochberg(pool, 0.1);
		expect(pool.map((c) => c.item)).toEqual(["d", "a"]);
	});

	/**
	 * The threshold is CAPPED at q. Worth pinning, because the loose claim
	 * "BH gets more generous as the pool grows" is false in absolute terms and
	 * it would be easy to write an implementation that drifted above q. The
	 * rank-i threshold is (i/m)*q, which reaches q only at i=m, so a candidate
	 * whose p-value exceeds q is unreachable at ANY pool size.
	 */
	it("never admits a p-value above q, however large the pool", () => {
		for (const m of [1, 5, 50, 500]) {
			const pool = [p(0.06, "target")];
			// Fill with maximally convincing peers -- the most favourable
			// possible ranking context for the target.
			for (let i = 1; i < m; i++) pool.push(p(1e-9, `peer${i}`));
			expect(benjaminiHochberg(pool, 0.05).rejected).not.toContain("target");
		}
	});

	/**
	 * The real compounding property, stated against the alternative the repo
	 * already named. docs/audit-2026-07.md proposed Bonferroni; its threshold is
	 * q/m, which SHRINKS as the pool grows, while BH's rank-proportional
	 * threshold does not. So BH's power advantage over Bonferroni widens with m
	 * at a fixed false-discovery tolerance.
	 */
	it("admits strictly more than Bonferroni, and the gap widens with pool size", () => {
		const bonferroniCount = (pool: ReturnType<typeof p>[], q: number) =>
			pool.filter((c) => c.pValue <= q / pool.length).length;

		// A fifth of the pool carries genuine but not overwhelming evidence
		// (p=0.002), the rest is noise. That p is the interesting region: it is
		// fixed, while Bonferroni's q/m threshold slides underneath it as the
		// pool grows, and BH's rank threshold does not.
		const build = (m: number) => {
			const pool: ReturnType<typeof p>[] = [];
			for (let i = 0; i < m / 5; i++) pool.push(p(0.002, `s${i}`));
			while (pool.length < m) pool.push(p(0.8, `n${pool.length}`));
			return pool;
		};

		const gaps: number[] = [];
		for (const m of [20, 100, 500]) {
			const pool = build(m);
			const bh = benjaminiHochberg(pool, 0.05).rejected.length;
			const bonferroni = bonferroniCount(pool, 0.05);
			expect(bh).toBeGreaterThanOrEqual(bonferroni);
			gaps.push(bh - bonferroni);
		}
		// At m=20 Bonferroni's threshold (0.0025) still covers p=0.002 and the
		// two agree; past that it falls away and BH keeps finding the same
		// evidence. Bonferroni's cost is what GROWS with scale.
		expect(gaps).toEqual([0, 20, 100]);
	});

	/**
	 * Where BH's extra power actually comes from: at a FIXED pool size, the
	 * company a candidate keeps decides its fate. p=0.04 against q=0.05 in a
	 * pool of four is below the top rank's threshold (0.0125), so it needs the
	 * step-up to reach it -- and the step-up only gets there if the other three
	 * are strong enough to push k out to rank 4.
	 *
	 * Stated the uncomfortable way: the same candidate, with the same
	 * measurement, is promoted or not depending on how its peers measured. That
	 * is not a defect, it is what controlling a POOL-level error rate means, and
	 * it is worth having pinned in a test so nobody "fixes" it later.
	 */
	it("lets peer strength decide a borderline candidate at fixed pool size", () => {
		const target = p(0.04, "target");
		const weakPeers = [target, p(0.9, "x"), p(0.9, "y"), p(0.9, "z")];
		const strongPeers = [target, p(1e-6, "x"), p(1e-6, "y"), p(1e-6, "z")];
		expect(benjaminiHochberg(weakPeers, 0.05).rejected).not.toContain("target");
		expect(benjaminiHochberg(strongPeers, 0.05).rejected).toContain("target");
	});

	it("is more conservative under arbitrary dependence than under PRDS", () => {
		const pool = [p(0.01, "a"), p(0.02, "b"), p(0.03, "c"), p(0.04, "d")];
		const prds = benjaminiHochberg(pool, 0.05, "prds").rejected;
		const arbitrary = benjaminiHochberg(pool, 0.05, "arbitrary").rejected;
		expect(arbitrary.length).toBeLessThan(prds.length);
		// BY is a strict subset: it never admits something BH rejected.
		for (const item of arbitrary) expect(prds).toContain(item);
	});

	it("partitions the pool -- every candidate is rejected or retained exactly once", () => {
		const pool = [p(0.001, "a"), p(0.3, "b"), p(0.02, "c"), p(0.7, "d")];
		const out = benjaminiHochberg(pool, 0.1);
		expect([...out.rejected, ...out.retained].sort()).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});
});

/**
 * The theorem itself, checked empirically rather than taken on faith.
 *
 * Under the GLOBAL null every candidate is worthless, so any rejection is
 * false and FDR degenerates to the family-wise error rate. BH must hold it at
 * or below q. This is the check that would catch a step-up implemented as a
 * step-DOWN, an off-by-one in the (i/m) threshold, or a q applied per-candidate
 * instead of across the pool -- all of which pass the small hand-built cases
 * above.
 */
describe("BH controls the false discovery rate (Monte Carlo)", () => {
	function falseDiscoveryProportion(
		trials: number,
		poolSize: number,
		trueEffects: number,
		q: number,
		seed: number,
	): number {
		const rand = lcg(seed);
		const normal = gaussian(rand);
		let totalProportion = 0;
		for (let t = 0; t < trials; t++) {
			const pool = [];
			for (let i = 0; i < poolSize; i++) {
				const isReal = i < trueEffects;
				// Nulls sit exactly on the bar; real effects clear it by 3 SE.
				const z = normal() + (isReal ? 3 : 0);
				pool.push({ item: { isReal }, pValue: gatePValue(z, 0, 1) });
			}
			const { rejected } = benjaminiHochberg(pool, q);
			if (rejected.length > 0) {
				const false_ = rejected.filter((r) => !r.isReal).length;
				totalProportion += false_ / rejected.length;
			}
		}
		return totalProportion / trials;
	}

	/**
	 * MONTE-CARLO TOLERANCE. Under the global null the bound is TIGHT: BH's
	 * FDR equals q*(m_0/m) = q exactly, so the estimate straddles q and a bare
	 * `<= q` assertion is a coin flip that fails half the time for correct code.
	 * (It did, on the first run of this file, at 0.107 against q=0.1.)
	 *
	 * The honest assertion is q plus sampling error. With TRIALS draws of a
	 * proportion, SE <= sqrt(0.25/TRIALS); three of those is a ~99.7% band. The
	 * seeds are fixed, so this is deterministic in practice -- the band is there
	 * to make the test correct rather than lucky.
	 */
	const TRIALS = 20_000;
	const tolerance = 3 * Math.sqrt(0.25 / TRIALS);

	it("holds FDR at or below q under the global null", () => {
		const fdr = falseDiscoveryProportion(TRIALS, 20, 0, 0.1, 12345);
		expect(fdr).toBeLessThanOrEqual(0.1 + tolerance);
	});

	/** With real effects present m_0 < m, so the bound q*(m_0/m) is strictly
	 * below q and the estimate should clear it without needing the band. */
	it("holds FDR below q with a mix of real and null effects", () => {
		const fdr = falseDiscoveryProportion(TRIALS, 20, 5, 0.1, 999);
		expect(fdr).toBeLessThanOrEqual(0.1 * (15 / 20) + tolerance);
	});

	it("holds at a stricter q too", () => {
		const fdr = falseDiscoveryProportion(TRIALS, 20, 5, 0.05, 4242);
		expect(fdr).toBeLessThanOrEqual(0.05 * (15 / 20) + tolerance);
	});

	/**
	 * The point of the whole module: a fixed per-candidate alpha does NOT hold
	 * the line as the pool grows. Same data, same nominal rate -- the
	 * uncorrected rule's false-discovery proportion runs well past it while
	 * BH stays under.
	 */
	/**
	 * FDR is `E[V/R]` -- the MEAN OF PER-TRIAL PROPORTIONS, not the pooled ratio
	 * of all false rejections to all rejections. The two differ whenever R
	 * varies across trials, and the pooled version is not what BH bounds. An
	 * earlier draft of this test computed the pooled ratio and reported BH
	 * "failing" at 0.068 against q=0.05, which was the test measuring the wrong
	 * estimand rather than the procedure missing its guarantee.
	 */
	it("beats an uncorrected per-candidate alpha on the same pools", () => {
		const rand = lcg(777);
		const normal = gaussian(rand);
		let bhFdr = 0;
		let rawFdr = 0;
		for (let t = 0; t < TRIALS; t++) {
			const pool = [];
			for (let i = 0; i < 20; i++) {
				const isReal = i < 3;
				const z = normal() + (isReal ? 3 : 0);
				pool.push({ item: { isReal }, pValue: gatePValue(z, 0, 1) });
			}
			const raw = pool.filter((c) => c.pValue <= 0.05).map((c) => c.item);
			if (raw.length > 0) {
				rawFdr += raw.filter((r) => !r.isReal).length / raw.length;
			}
			const bh = benjaminiHochberg(pool, 0.05).rejected;
			if (bh.length > 0) {
				bhFdr += bh.filter((r) => !r.isReal).length / bh.length;
			}
		}
		bhFdr /= TRIALS;
		rawFdr /= TRIALS;
		expect(bhFdr).toBeLessThan(rawFdr);
		expect(bhFdr).toBeLessThanOrEqual(0.05 * (17 / 20) + tolerance);
		// The uncorrected rule blows well past the nominal rate on the same data
		// -- this is the number the whole module exists to fix.
		expect(rawFdr).toBeGreaterThan(0.05);
	});
});

describe("lordAlpha (online FDR over the decision stream)", () => {
	const ALPHA = 0.1;

	it("starts at gamma_1 * W_0", () => {
		// gamma_1 = 1/zeta(1.6) ~ 0.43749, W_0 = alpha/2.
		expect(lordAlpha([], ALPHA)).toBeCloseTo(0.437490165774 * (ALPHA / 2), 9);
	});

	it("re-derives its normaliser -- the memoised zeta constant cannot drift", () => {
		let sum = 0;
		const N = 2_000_000;
		for (let j = 1; j <= N; j++) sum += j ** -1.6;
		sum += N ** -0.6 / 0.6 - 0.5 * N ** -1.6;
		// alpha_1 = gamma_1 * W_0 = (1/zeta) * alpha/2, so zeta = alpha/(2*alpha_1).
		const impliedZeta = ALPHA / (2 * lordAlpha([], ALPHA));
		expect(impliedZeta).toBeCloseTo(sum, 6);
	});

	it("tightens monotonically while nothing is rejected", () => {
		let previous = Number.POSITIVE_INFINITY;
		const history: boolean[] = [];
		for (let i = 0; i < 40; i++) {
			const a = lordAlpha(history, ALPHA);
			expect(a).toBeLessThan(previous);
			previous = a;
			history.push(false);
		}
	});

	it("earns wealth back on a rejection", () => {
		const barren = Array.from({ length: 10 }, () => false);
		const withHit = [...barren.slice(0, 9), true];
		expect(lordAlpha(withHit, ALPHA)).toBeGreaterThan(lordAlpha(barren, ALPHA));
	});

	it("repays the first rejection less than later ones", () => {
		// The first rejection returns alpha - W_0; later ones return alpha. An
		// implementation that collapses the two cases inflates the threshold.
		const first = [true, false, false, false];
		const second = [true, false, false, true];
		const gainFromFirst =
			lordAlpha(first, ALPHA) - lordAlpha([false, false, false, false], ALPHA);
		const gainFromSecond = lordAlpha(second, ALPHA) - lordAlpha(first, ALPHA);
		expect(gainFromSecond).toBeGreaterThan(gainFromFirst);
	});

	it("never returns a negative or non-finite threshold", () => {
		const rand = lcg(5150);
		for (let trial = 0; trial < 200; trial++) {
			const history = Array.from({ length: 50 }, () => rand() < 0.3);
			const a = lordAlpha(history, ALPHA);
			expect(Number.isFinite(a)).toBe(true);
			expect(a).toBeGreaterThanOrEqual(0);
		}
	});

	/**
	 * THE GUARANTEE, and the reason this module exists alongside BH.
	 *
	 * A stream of candidates arrives indefinitely. LORD++ must hold FDR at
	 * alpha over the WHOLE stream. A fixed per-candidate threshold does not --
	 * and neither does re-running BH on each invocation's three candidates,
	 * which is what the gate would do if BH were the only procedure.
	 */
	it("holds FDR over a long stream where fixed-alpha and per-batch BH do not", () => {
		const rand = lcg(31337);
		const normal = gaussian(rand);
		const STREAM = 900; // 300 invocations of 3 candidates
		const TRIALS = 60;
		const TRUE_RATE = 0.15; // 15% of candidates are real rules

		let lordFdr = 0;
		let fixedFdr = 0;
		let batchBhFdr = 0;
		for (let trial = 0; trial < TRIALS; trial++) {
			const isReal: boolean[] = [];
			const pValues: number[] = [];
			for (let i = 0; i < STREAM; i++) {
				const real = rand() < TRUE_RATE;
				isReal.push(real);
				pValues.push(gatePValue(normal() + (real ? 3 : 0), 0, 1));
			}

			const lord = lordDecisions(pValues, 0.1);
			const fixed = pValues.map((p) => p <= 0.1);

			// BH applied per invocation of 3, the way the gate would use it.
			const batch: boolean[] = new Array(STREAM).fill(false);
			for (let start = 0; start < STREAM; start += 3) {
				const slice = pValues
					.slice(start, start + 3)
					.map((p, k) => ({ item: start + k, pValue: p }));
				for (const idx of benjaminiHochberg(slice, 0.1).rejected) {
					batch[idx] = true;
				}
			}

			const fdp = (decisions: boolean[]) => {
				const rejected = decisions.filter(Boolean).length;
				if (rejected === 0) return 0;
				const false_ = decisions.filter((d, i) => d && !isReal[i]).length;
				return false_ / rejected;
			};
			lordFdr += fdp(lord);
			fixedFdr += fdp(fixed);
			batchBhFdr += fdp(batch);
		}
		lordFdr /= TRIALS;
		fixedFdr /= TRIALS;
		batchBhFdr /= TRIALS;

		// LORD holds the line over the whole stream.
		expect(lordFdr).toBeLessThanOrEqual(0.1);
		// Neither alternative does, which is the entire argument.
		expect(fixedFdr).toBeGreaterThan(0.1);
		expect(batchBhFdr).toBeGreaterThan(0.1);
		expect(lordFdr).toBeLessThan(batchBhFdr);
	});

	it("still makes discoveries -- it is not merely conservative", () => {
		const rand = lcg(8080);
		const normal = gaussian(rand);
		const pValues: number[] = [];
		let realCount = 0;
		for (let i = 0; i < 600; i++) {
			const real = rand() < 0.3;
			if (real) realCount++;
			pValues.push(gatePValue(normal() + (real ? 4 : 0), 0, 1));
		}
		const found = lordDecisions(pValues, 0.1).filter(Boolean).length;
		expect(found).toBeGreaterThan(realCount * 0.3);
	});
});

describe("normalQuantile / lordZ", () => {
	it("inverts normalCdf", () => {
		for (const z of [-3, -1, -0.25, 0, 0.5, 1.96, 2, 3.5]) {
			expect(normalQuantile(normalCdf(z))).toBeCloseTo(z, 5);
		}
	});

	it("clamps rather than returning infinities at the boundaries", () => {
		expect(normalQuantile(0)).toBe(-40);
		expect(normalQuantile(1)).toBe(40);
		expect(normalQuantile(Number.NaN)).toBe(-40);
	});

	/**
	 * The backward-compatibility anchor. At alpha=0.10 the first decision of a
	 * stream lands on the gate's existing z=2, so a fresh install behaves as it
	 * does today and only diverges as history accumulates. Any measured
	 * difference is then attributable to the adaptation, not to a moved
	 * starting point.
	 */
	it("starts a fresh stream at the gate's existing z=2", () => {
		expect(lordZ([], 0.1)).toBeCloseTo(2.016, 2);
	});

	it("tightens the multiple as nulls accumulate", () => {
		const barren = (n: number) => Array.from({ length: n }, () => false);
		expect(lordZ(barren(10), 0.1)).toBeGreaterThan(lordZ([], 0.1));
		expect(lordZ(barren(50), 0.1)).toBeGreaterThan(lordZ(barren(10), 0.1));
	});

	it("loosens the multiple after a discovery", () => {
		const barren = Array.from({ length: 10 }, () => false);
		const withHit = [...barren.slice(0, 9), true];
		expect(lordZ(withHit, 0.1)).toBeLessThan(lordZ(barren, 0.1));
	});

	it("stays a usable multiple over a long barren stream", () => {
		// The threshold must tighten without running away: a z that drifted past
		// ~6 would make promotion impossible at any effect size this benchmark
		// can resolve, turning FDR control into a silent shutdown.
		const z = lordZ(
			Array.from({ length: 500 }, () => false),
			0.1,
		);
		expect(z).toBeGreaterThan(2);
		expect(z).toBeLessThan(6);
	});
});
