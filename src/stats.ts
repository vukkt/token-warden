/**
 * The estimators and the gate's tunable constants.
 *
 * Extracted from `select.ts` so the A/B comparison engine (`compare.ts`) and
 * the power planner (`power.ts`) can share them without importing the whole
 * rule selector — `compare.ts` previously pulled in the verdict machinery to
 * reach `assessDelta`, and `power.ts` pulled it in for three pure functions.
 *
 * Everything here is pure apart from the two environment readers, which are
 * deliberately read PER CALL rather than frozen at module load: the calibration
 * harness and the test suite set these at runtime, and a module-level const
 * would silently ignore them.
 *
 * These values decide what gets promoted, and the false-positive rate quoted in
 * FINDINGS.md was measured under exactly these definitions. Changing any of
 * them changes the meaning of every recorded verdict, so treat edits here as
 * re-calibration work, not refactoring.
 */

// ---------------------------------------------------------------------------
// Descriptive statistics
// ---------------------------------------------------------------------------

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export const mean = (xs: number[]): number => sum(xs) / xs.length;

/** Weighted mean `Σ wᵢ xᵢ / Σ wᵢ`. With every wᵢ = 1 it is the plain mean, so
 * the unweighted path stays bit-identical. `weights` is aligned with `xs`. */
export function weightedMean(xs: number[], weights: number[]): number {
	const weighted = xs.reduce(
		(acc, x, i) => acc + (weights[i] as number) * x,
		0,
	);
	return weighted / sum(weights);
}

/** Unbiased sample variance; null when fewer than two observations. */
export function sampleVariance(xs: number[]): number | null {
	if (xs.length < 2) return null;
	const m = mean(xs);
	return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
}

/** Degrees-of-freedom-weighted pooled variance across many run vectors —
 * borrowed when an individual task has too few runs to estimate its own
 * run-to-run noise (default runs=3 gives each task its own estimate; this is
 * the backstop at the n=2 edge). Null when no vector has ≥2 observations. */
export function pooledVariance(vectors: number[][]): number | null {
	let sumSq = 0;
	let dof = 0;
	for (const xs of vectors) {
		if (xs.length < 2) continue;
		const m = mean(xs);
		sumSq += xs.reduce((acc, x) => acc + (x - m) ** 2, 0);
		dof += xs.length - 1;
	}
	return dof > 0 ? sumSq / dof : null;
}

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 0
		? ((s[mid - 1] as number) + (s[mid] as number)) / 2
		: (s[mid] as number);
}

// ---------------------------------------------------------------------------
// Gate parameters
// ---------------------------------------------------------------------------

/** Cache-write price relative to a base input token (Anthropic ~1.25×). A rule
 * re-enters the prompt at this price on the session after the ruleset changes
 * (a cache miss on the memory block), then at cache-read price thereafter. */
const CACHE_CREATE_MULTIPLIER = 1.25;

/**
 * Sessions per week, the horizon the one-time cache re-prefill is amortized
 * over. Shared by the gate (`effectiveRent`) and the dollar projection
 * (`cost.ts`) — these were two identical copies in two modules, and they must
 * agree by construction or the economics disagree with the bar.
 */
export function sessionsPerWeek(): number {
	// A zero/negative/NaN override would invert or trivialize the inequality;
	// fall back to the default instead.
	const raw = Number(process.env.WARDEN_SESSIONS_PER_WEEK ?? 20);
	return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

/**
 * Confidence multiple on the standard error for the "uncertain" band. Default 2
 * (~95% one-sided): a candidate must clear the 2×-rent bar by ≥ 2 standard
 * errors to be promoted. The calibration harness (validation/calibration.ts)
 * showed the old 1-SE band gave a ~16% false-positive rate (keeping a zero-effect
 * rule); 2 SE drops that to ~2-3% in that synthetic model — the empirical A/A
 * harness later measured 8.8% on real recorded runs (FINDINGS.md), so treat the
 * synthetic figure as a floor. Lower it (toward 1) to trade precision for power
 * once you trust your benchmark's variance.
 *
 * A value below 1, non-numeric, or blank is REJECTED and falls back to the
 * default 2 — it is not clamped up to 1, so `0.5` yields the stricter 2 rather
 * than the looser 1. See DECISIONS.md (v0.40.0) for why that is left as-is.
 */
export function confidenceZ(): number {
	const raw = Number(process.env.WARDEN_CONFIDENCE_Z ?? 2);
	return Number.isFinite(raw) && raw >= 1 ? raw : 2;
}

/**
 * Effective per-session rent of carrying a rule, in tokens. Beyond the raw
 * context cost paid every session, a rule incurs a one-time cache re-prefill
 * each time the ruleset changes — the memory block misses the cache and is
 * re-created at ~1.25× input price. Amortized over a week of sessions
 * (assuming ≈one ruleset change per week) that adds `contextCost·1.25/sessions`
 * per session. This is deliberately conservative: it makes the 2× bar slightly
 * *harder*, never easier, and answers the "you bust the cache on every change"
 * critique by pricing the bust in rather than ignoring it.
 */
export function effectiveRent(contextCost: number): number {
	return (
		contextCost + (contextCost * CACHE_CREATE_MULTIPLIER) / sessionsPerWeek()
	);
}
