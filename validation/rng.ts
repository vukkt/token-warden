/**
 * The deterministic randomness every sweep and harness in this repo draws on:
 * two seeded generators, and the shuffle and bootstrap resampler that consume
 * them.
 *
 * Every published calibration figure here is a Monte-Carlo estimate, so the
 * generator is part of the evidence: a number nobody can redraw is not a
 * measurement. One definition per stream, imported everywhere, so a figure
 * quoted from one file can be reproduced by another.
 *
 * They live here rather than in `src/` because nothing that ships depends on
 * them, and not inside a harness because validation/calibration.ts runs its
 * whole report on import (`process.exit(main())` at module scope) and so can
 * never be imported from. `test/` imports from this file directly.
 *
 * Three copies of `mulberry32` existed before, and one of them had drifted:
 * validation/variance-decomposition.ts lacked the `a |= 0` line the other two
 * carried. They were merged only after being shown bit-identical — 14 seeds
 * (including 0, 2^31, 2^32-1 and every seed constant the harnesses use) x
 * 100,000 draws, zero mismatches. The line is a no-op: `a` is re-normalized by
 * the `| 0` on the very next statement, whatever `seed >>> 0` left in it.
 * "They looked alike" is not the standard these files are held to.
 *
 * Two more copies were found later, under the name `lcg`, and they were NOT
 * alike — same name, different constants, and one of the two arithmetics was
 * broken. See `lcg32` below for what that cost.
 */

/** Deterministic PRNG (mulberry32). Same seed, same sequence, forever. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Deterministic 32-bit LCG (Numerical Recipes constants), full 2^32 period.
 *
 * A SECOND generator exists, rather than one, because `validation/
 * stream-calibration.ts` published the break-even figures in FINDINGS.md from
 * this exact stream. Re-pointing it at `mulberry32` would change every one of
 * those numbers, which is a re-measurement and a document rewrite, not a
 * cleanup. The generator is a parameter of a published number like any other.
 * New sweeps should use `mulberry32`.
 *
 * `>>> 0` is what makes this sound and is not optional. Two files had grown a
 * private `lcg` with glibc's constants and NO mask —
 * `s = (s * 1103515245 + 12345) % 2147483648` — where the product exceeds 2^53
 * for large `s`, so the low bits the modulus keeps are double-rounding
 * artifacts rather than the LCG's. Measured against this function over 100,000
 * draws: it cycled after 10,466 values from every seed tried, yielded 15,824
 * distinct values where a sound generator yields ~100,000, and failed a 10-bin
 * chi-square at 76-90 on 9 df (critical value 27.9 at p=0.001). It drove
 * property sweeps in test/power.test.ts and test/variance.test.ts that claimed
 * hundreds of independent draws and were getting a short, lumpy cycle. Both
 * now call `mulberry32`; every assertion still passes, so nothing was being
 * held up by the degenerate stream — the sweeps were simply searching far less
 * of the space than they said they were.
 */
export function lcg32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (1664525 * s + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/**
 * Fisher-Yates, unbiased, drawing from `rng` once per position.
 *
 * Here for the same reason the generators are: three copies existed, two of
 * them byte-identical in files that both publish figures, and a shuffle is the
 * other place a permutation test can be silently wrong. The bias lives in one
 * character — `rng() * i` instead of `rng() * (i + 1)` never moves an element
 * to its own position, which is not a uniform permutation and is invisible in
 * any assertion that only checks the multiset. All three copies had it right;
 * one definition is how it stays that way.
 */
export function shuffled<T>(rng: () => number, xs: readonly T[]): T[] {
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = out[i] as T;
		out[i] = out[j] as T;
		out[j] = tmp;
	}
	return out;
}

/**
 * Draw `n` values from `pool` with replacement — the bootstrap resampler both
 * calibration harnesses build their confidence intervals from.
 *
 * It was the third byte-identical copy sitting beside `shuffled` in the same
 * two files, under a comment noting that the harness next to it was exported
 * "for stream-calibration.ts, which needs to build samples the same way". The
 * need was already recognised; two of the three helpers just never moved.
 */
export function resample<T>(
	rng: () => number,
	pool: readonly T[],
	n: number,
): T[] {
	const out: T[] = [];
	for (let i = 0; i < n; i++) {
		out.push(pool[Math.floor(rng() * pool.length)] as T);
	}
	return out;
}
