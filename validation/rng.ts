/**
 * The validation harnesses' deterministic PRNG.
 *
 * Every published calibration figure in this repo is a Monte-Carlo estimate, so
 * the generator is part of the evidence: a number nobody can redraw is not a
 * measurement. One definition, imported by every harness, so a figure quoted
 * from one can be reproduced by another.
 *
 * It lives here rather than in `src/` because nothing that ships depends on it,
 * and it is not exported FROM a harness because validation/calibration.ts runs
 * its whole report on import (`process.exit(main())` at module scope) and so can
 * never be imported from.
 *
 * Three copies of this function existed before, and one of them had drifted:
 * validation/variance-decomposition.ts lacked the `a |= 0` line the other two
 * carried. They were merged only after being shown bit-identical — 14 seeds
 * (including 0, 2^31, 2^32-1 and every seed constant the harnesses use) x
 * 100,000 draws, zero mismatches. The line is a no-op: `a` is re-normalized by
 * the `| 0` on the very next statement, whatever `seed >>> 0` left in it.
 * "They looked alike" is not the standard these files are held to.
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
