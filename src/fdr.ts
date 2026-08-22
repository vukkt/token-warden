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
import { normalCdf, normalQuantile } from "./stats.js";

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

// ---------------------------------------------------------------------------
// Online FDR over the decision stream
// ---------------------------------------------------------------------------

/**
 * WHY BENJAMINI-HOCHBERG IS NOT ENOUGH HERE, which corrects the commit that
 * introduced it.
 *
 * BH controls FDR over a FIXED pool, decided all at once. That commit claimed it
 * fixes junk rules accumulating as more candidates are measured. It does not.
 * `MAX_CANDIDATES_PER_INVOCATION` is 3, so BH over one invocation is barely
 * distinguishable from a per-candidate threshold, and the accumulation the claim
 * describes happens ACROSS invocations -- one distiller run at a time, week
 * after week, with no end. That is a stream, and a fixed-pool procedure has
 * nothing to say about it.
 *
 * Applying BH afresh to each invocation's three candidates controls FDR within
 * each invocation and NOT across them: run it 100 times at q = 0.1 and the
 * expected count of false rules still grows linearly, exactly the failure mode
 * BH was brought in to fix.
 *
 * THE THEOREM (Javanmard & Montanari 2018; Ramdas, Zrnic, Wainwright & Jordan
 * 2017 -- the LORD++ formulation). Hypotheses arrive one at a time, and each
 * must be decided before the next is seen. Maintain an "alpha-wealth". Test
 * `t` is rejected when `p_t <= alpha_t`, where
 *
 *     alpha_t = gamma_t * W_0
 *             + (alpha - W_0) * gamma_{t - tau_1}
 *             + alpha * sum_{j >= 2} gamma_{t - tau_j}
 *
 * with `tau_1 < tau_2 < ...` the indices of past rejections, `gamma` a
 * non-negative sequence summing to 1, and `W_0 < alpha` the initial wealth.
 * This controls `FDR <= alpha` over the WHOLE stream, for any length, under
 * independent p-values.
 *
 * The mechanism is an honest economy rather than a trick: each test spends
 * wealth, and each REJECTION earns wealth back. A run of discoveries buys the
 * budget for more; a run of nulls tightens the threshold until the evidence
 * improves. That is the "gets better the more you use it" property with a proof
 * under it instead of a slogan, and it is the exact shape of this project's
 * usage -- candidates distilled from real work, indefinitely.
 *
 * NO NEW STATE IS NEEDED. `rule_receipts` already records one row per decision
 * with its status, which IS the stream history. The caller passes that history
 * in; this function stays pure.
 */

/** Decay exponent of the gamma sequence, `gamma_j proportional to j^-1.6`. The
 * standard default in the online-FDR literature and the `onlineFDR` package:
 * light enough that late arrivals keep a usable threshold, heavy enough to sum. */
const GAMMA_EXPONENT = 1.6;

/** `zeta(1.6)`, the normaliser making `sum_j gamma_j = 1`. Computed once and
 * memoised; a test re-derives it by summation so the constant cannot drift. */
let gammaNormaliser: number | null = null;

function normaliser(): number {
	if (gammaNormaliser !== null) return gammaNormaliser;
	const N = 200_000;
	let sum = 0;
	for (let j = 1; j <= N; j++) sum += j ** -GAMMA_EXPONENT;
	// Euler-Maclaurin tail so a finite sum still lands on the true zeta:
	// the integral from N to infinity, less half the final term.
	sum +=
		N ** (1 - GAMMA_EXPONENT) / (GAMMA_EXPONENT - 1) -
		0.5 * N ** -GAMMA_EXPONENT;
	gammaNormaliser = sum;
	return sum;
}

/** `gamma_j` for j >= 1; zero for j <= 0 so the shifted terms in the LORD sum
 * can be written without index guards at every call site. */
function gamma(j: number): number {
	if (j <= 0) return 0;
	return j ** -GAMMA_EXPONENT / normaliser();
}

/**
 * The significance threshold LORD++ allows for the NEXT decision in the stream.
 *
 * `history[i]` is whether decision `i` (oldest first) was a rejection -- for
 * this project, whether that candidate was promoted. The next test is index
 * `history.length + 1`.
 *
 * `alpha` is the FDR level to hold over the whole stream. Initial wealth is
 * `alpha / 2`, the conventional choice: it leaves half the budget in reserve so
 * an unlucky opening run of nulls cannot bankrupt the procedure.
 */
export function lordAlpha(history: readonly boolean[], alpha: number): number {
	const t = history.length + 1;
	const w0 = alpha / 2;

	let value = gamma(t) * w0;
	let rejectionsSeen = 0;
	for (let i = 0; i < history.length; i++) {
		if (!history[i]) continue;
		rejectionsSeen += 1;
		// History is 0-indexed; rejection times in the theorem are 1-indexed.
		const tau = i + 1;
		// The FIRST rejection repays only `alpha - W_0`; every later one repays
		// the full `alpha`. Collapsing these into one case is the usual way this
		// procedure is implemented slightly wrong, and it inflates the threshold.
		value += (rejectionsSeen === 1 ? alpha - w0 : alpha) * gamma(t - tau);
	}
	return value;
}

/**
 * Run LORD++ across a stream of p-values, returning the decision for each.
 *
 * Provided because the procedure is only meaningful as a sequence -- a caller
 * that re-derived it per decision would be re-implementing the wealth
 * bookkeeping, which is where the errors live.
 */
export function lordDecisions(
	pValues: readonly number[],
	alpha: number,
): boolean[] {
	const history: boolean[] = [];
	for (const p of pValues) {
		history.push(p <= lordAlpha(history, alpha));
	}
	return history;
}

/**
 * LORD's threshold expressed as a CONFIDENCE MULTIPLE rather than a p-value.
 *
 * This is how online FDR reaches the gate without rebuilding it. `select.ts`
 * already routes every promotion through one number -- the `z` in
 * `delta - bar >= z * SE` -- and carries an uncertain band, a Neyman top-up
 * pass, a recovery path and a two-strike retention policy hanging off it.
 * Replacing that machinery with a raw p-value comparison would mean rewriting
 * all of it. Converting `alpha_t` to `z_t = Phi^-1(1 - alpha_t)` instead leaves
 * every one of those mechanisms exactly as calibrated and makes only the
 * threshold stream-aware.
 *
 * The default `alpha` is 0.10 for a reason worth stating: it makes the FIRST
 * decision of a stream land on `z = 2.016`, which is the gate's existing
 * hard-coded `z = 2` to within a rounding error. A fresh install therefore
 * behaves as it does today and only diverges as history accumulates -- so any
 * measured difference is attributable to the adaptation rather than to a
 * changed starting point.
 */
export function lordZ(history: readonly boolean[], alpha: number): number {
	return normalQuantile(1 - lordAlpha(history, alpha));
}
