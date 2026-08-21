/**
 * False-discovery-rate control over a pool of rule candidates.
 *
 * THE PROBLEM THIS FIXES. The gate decides one candidate at a time: promote if
 * `delta - bar >= z * SE`. Each such decision has its own false-positive rate
 * (measured at 8.8% on recorded runs, FINDINGS.md). Nothing has ever accounted
 * for the fact that they accumulate. Test 100 worthless rules at a 9%
 * per-decision rate and roughly 9 of them enter MEMORY.md; test 1,000 and
 * roughly 90 do. The expected number of junk rules in memory grows LINEARLY in
 * the number of candidates ever measured, which means the current gate gets
 * worse the more you use it. For a plugin whose entire claim is that it gets
 * better the more you use it, that is the wrong sign on the most important
 * derivative.
 *
 * WHY NOT BONFERRONI. docs/audit-2026-07.md already flagged this and named
 * Bonferroni as "the first knob". Bonferroni controls the FAMILY-WISE error
 * rate: the probability that EVEN ONE kept rule is junk. That is far stricter
 * than this project needs. A memory file where 9 rules in 10 genuinely pay
 * their rent is an excellent outcome; insisting on a 95% chance that not one
 * rule is junk would reject nearly everything at these signal-to-noise ratios.
 * Worse, Bonferroni's threshold is `q/m` — it gets HARSHER as the pool grows,
 * so it would swap a gate that degrades with use for one that seizes up.
 *
 * THE THEOREM (Benjamini & Hochberg, JRSS-B 1995). Order the p-values
 * `p_(1) <= ... <= p_(m)`, find
 *
 *     k = max { i : p_(i) <= (i/m) * q }
 *
 * and reject `H_(1) .. H_(k)`. Then `FDR <= (m_0/m) * q <= q`, where `m_0` is
 * the number of true nulls. Under independence this is exact; Benjamini &
 * Yekutieli (2001) extend it to positive-regression-dependent test statistics
 * (PRDS), and to ARBITRARY dependence at the cost of a `1/sum(1/i)` factor.
 *
 * The threshold `(i/m)*q` RISES with rank, which is the property that matters
 * here: as the candidate pool grows, a rule ranked mid-pack faces a more
 * generous cutoff, not a stricter one. The procedure gains power with scale
 * while holding the error rate the project actually cares about — "what
 * fraction of my memory is noise?" — fixed at q.
 *
 * WHICH DEPENDENCE ASSUMPTION APPLIES HERE. Candidates measured in one
 * invocation share a golden suite, a fixture and an agent, so their statistics
 * are positively correlated rather than independent — a derailment-heavy suite
 * run inflates every candidate's estimate together. That is the PRDS case, and
 * plain BH is valid under PRDS. The conservative Benjamini-Yekutieli variant is
 * available via `dependence: "arbitrary"` for callers who do not want to lean
 * on that; it is not the default because PRDS is the honest description of this
 * design, and BY costs roughly a factor of `ln(m)` in power for an assumption
 * this suite does not violate.
 *
 * Pure and zero-token.
 */
import { normalCdf } from "./stats.js";

/**
 * One-sided p-value for the gate's own hypothesis: "this candidate's saving is
 * no better than the bar." Large positive `delta - bar` relative to `SE` gives
 * a small p.
 *
 * Returns 1 (maximally unconvincing) when the standard error is null or
 * non-positive. A null SE means the suite could not estimate run-to-run noise
 * at all, and a candidate whose uncertainty is unknown must never be promoted
 * by a procedure that only reads p-values -- returning a small p there would
 * launder "unmeasurable" into "significant".
 */
export function gatePValue(
	delta: number,
	bar: number,
	standardError: number | null,
): number {
	if (standardError === null || !(standardError > 0)) return 1;
	return 1 - normalCdf((delta - bar) / standardError);
}

export interface FdrCandidate<T> {
	item: T;
	/** One-sided p-value under the null "does not clear the bar". */
	pValue: number;
}

export interface FdrResult<T> {
	/** Candidates BH rejects the null for -- the ones to promote. */
	rejected: T[];
	/** Candidates that failed to clear the adaptive threshold. */
	retained: T[];
	/**
	 * The largest p-value admitted, or null when nothing was. Every candidate
	 * with `pValue <= cutoff` is rejected, including any that individually
	 * looked worse than a fixed alpha would allow -- that is the step-up
	 * procedure doing its job, not a bug.
	 */
	cutoff: number | null;
}

export type Dependence = "prds" | "arbitrary";

/**
 * Benjamini-Hochberg step-up, with the Benjamini-Yekutieli correction available
 * for arbitrary dependence.
 *
 * `q` is the tolerated false-discovery proportion among promoted rules.
 *
 * Ties are handled by the step-up scan itself rather than by special-casing:
 * because `k` is the LARGEST index satisfying the inequality and everything at
 * or below it is rejected, tied p-values are always accepted or rejected
 * together. A per-index scan that stopped at the first failure would split
 * them, which is the classic implementation bug in this procedure.
 */
export function benjaminiHochberg<T>(
	candidates: readonly FdrCandidate<T>[],
	q: number,
	dependence: Dependence = "prds",
): FdrResult<T> {
	const m = candidates.length;
	if (m === 0) return { rejected: [], retained: [], cutoff: null };

	// BY divides q by the harmonic number H_m; BH leaves it alone.
	let harmonic = 1;
	if (dependence === "arbitrary") {
		harmonic = 0;
		for (let i = 1; i <= m; i++) harmonic += 1 / i;
	}
	const effectiveQ = q / harmonic;

	const ordered = [...candidates].sort((a, b) => a.pValue - b.pValue);

	// Largest i with p_(i) <= (i/m)*q. Scanning downward finds it directly;
	// scanning upward and stopping early would find the first FAILURE, which is
	// not the same index whenever a later p-value dips back under its threshold.
	let k = 0;
	for (let i = m; i >= 1; i--) {
		const p = (ordered[i - 1] as FdrCandidate<T>).pValue;
		if (p <= (i / m) * effectiveQ) {
			k = i;
			break;
		}
	}

	return {
		rejected: ordered.slice(0, k).map((c) => c.item),
		retained: ordered.slice(k).map((c) => c.item),
		cutoff:
			k === 0 ? null : ((ordered[k - 1] as FdrCandidate<T>).pValue ?? null),
	};
}
