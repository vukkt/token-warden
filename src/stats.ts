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

/**
 * Characters per token, the estimator this project prices everything with.
 *
 * Named here because it was written out twice as a bare `4` -- in
 * `rules.ts#contextCost`, which is the denominator of the entire product, and
 * in the status dashboard's tool-footprint estimate. If the tokenizer's real
 * ratio ever moves, the rent a rule pays and the cost the dashboard reports
 * have to move together or the two stop describing the same thing.
 *
 * The ROUNDING deliberately differs at the two call sites and is not
 * centralised with the constant. Rent uses `ceil`: a rule is charged for the
 * token it partially occupies, so the gate is never flattered by a rounding
 * error. The dashboard uses `round`, because it is reporting an estimate to a
 * human rather than charging anyone.
 */
export const CHARS_PER_TOKEN = 4;

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
 * Read a numeric environment override, or null when there is none to read.
 *
 * Null means absent, BLANK, non-numeric, or outside the range the caller
 * accepts. Blank is the case this exists for. `Number("")` and `Number(" ")`
 * are both 0, so the natural idiom `Number(process.env.X ?? fallback)` reads
 * `export WARDEN_X=` as a deliberate zero rather than as an unset variable --
 * and this project has already shipped that hole once, in `pricing.ts`, where
 * a blank override priced an entire workload at zero (v0.40.0).
 *
 * Two of the five readers below used that idiom and survived only because 0
 * happens to fall outside their legal range. `recoveryMarginFraction` said so
 * in as many words: "confidenceZ is accidentally safe from this because 0 is
 * out of ITS range". Safety by coincidence stops being safety the moment
 * someone widens a range, so the coincidence is replaced by construction.
 *
 * Rejecting rather than clamping is deliberate and shared by every caller: a
 * typo yields the calibrated default instead of a policy nobody measured.
 */
function numericEnv(
	name: string,
	accepts: (value: number) => boolean,
): number | null {
	const set = process.env[name]?.trim();
	if (!set) return null;
	const raw = Number(set);
	return Number.isFinite(raw) && accepts(raw) ? raw : null;
}

/**
 * Sessions per week, the horizon the one-time cache re-prefill is amortized
 * over. Shared by the gate (`effectiveRent`) and the dollar projection
 * (`cost.ts`) — these were two identical copies in two modules, and they must
 * agree by construction or the economics disagree with the bar.
 */
export function sessionsPerWeek(): number {
	// Zero or negative would invert or trivialize the inequality.
	return numericEnv("WARDEN_SESSIONS_PER_WEEK", (n) => n > 0) ?? 20;
}

/**
 * Confidence multiple on the standard error for the "uncertain" band: a
 * candidate must clear the 2x-rent bar by at least this many standard errors.
 *
 * DEFAULT 1.5 since v1.0.0, down from 2. This reverses the v0.29.0 tightening,
 * and it is the only gate change of that rework that survived calibration.
 *
 * v0.29.0 raised z from 1 to 2 because the SYNTHETIC harness showed a 1-SE band
 * keeping zero-effect rules ~16% of the time. That optimised the false-positive
 * rate, which is not the objective. Measured on the recorded `sql` pool
 * (validation/empirical-calibration.ts, 3,000 trials, runs=2):
 *
 *     z      false positive        power at a 10% saving
 *     1.0    19.4% [18.0, 20.8]    63.0%
 *     1.5     9.8% [ 8.8, 11.0]    46.1%
 *     2.0     8.9% [ 7.9, 10.0]    34.9%
 *
 * Moving 2 -> 1.5 buys 11.2 points of power for 0.9 points of false positives,
 * a 12:1 trade whose FP intervals overlap. Moving further to 1.0 doubles the
 * false-positive rate for another 17 points, which is a real trade rather than
 * a free one — hence 1.5 rather than the token-optimal 1.0.
 *
 * WHY POWER IS WORTH SO MUCH MORE THAN PRECISION HERE. A worthless rule costs
 * only its rent, ~25 tokens per run. A missed real rule forfeits its entire
 * saving, ~4,769 tokens per run on that pool. False positives are ~191x cheaper
 * than false negatives, so a rule is worth keeping once P(real) exceeds roughly
 * 0.5% — while z=2 demands 97.7%. `validation/stream-calibration.ts` measures
 * the consequence directly: on net tokens saved, the looser arm wins in every
 * cell of a true-rate x effect-size sweep. See FINDINGS.md, "Online FDR".
 *
 * This is NOT a licence to drop z to 0. That accounting prices a junk rule at
 * rent alone, which holds only while context is free; once the window binds,
 * junk rules crowd out real ones. 1.5 is the point where the FP cost is still
 * inside the noise of the status quo.
 *
 * A value below 1, non-numeric, or blank is REJECTED and falls back to the
 * default — it is not clamped up to 1, so `0.5` yields 1.5 rather than 1. See
 * DECISIONS.md (v0.40.0) for why that is left as-is.
 */
export function confidenceZ(): number {
	return numericEnv("WARDEN_CONFIDENCE_Z", (n) => n >= 1) ?? 1.5;
}

/**
 * How much of the gate's own confidence margin an evicted candidate's point
 * estimate must have reached before the eviction is classed UNDERPOWERED
 * rather than measured-negative. Promotion needs
 * `delta - bar >= z·SE`; this classification needs `delta - bar >= f·z·SE`,
 * so f = 1 would be the gate itself and f = 0 would be "anything on the
 * positive side of the bar".
 *
 * Default 0.5 — the measurement got at least HALF the way to the evidence the
 * gate demands, on the right side of the bar. It is a tuned number, not a
 * taste: on the recorded `sql` pool (3,000 trials/cell, FINDINGS.md) f = 0 or
 * 0.25 admits so much of the null distribution that the second look adds
 * 0.93-2.63 points of false positives, while f = 0.5 adds 0.10 and still
 * recovers +2.9 points of power at a 10% true saving and +9.1 at 20%.
 *
 * Read per call, not frozen at module load: the calibration harness sweeps it.
 */
export function recoveryMarginFraction(): number {
	// Outside [0, 1) it is not a fraction of the margin. 0 IS inside this
	// parameter's legal range, which is why `numericEnv` must treat a blank
	// override as absent rather than as zero: `WARDEN_RECOVERY_MARGIN=` would
	// otherwise select the loosest possible policy, reclassifying every
	// eviction on the positive side of the bar as recoverable.
	return numericEnv("WARDEN_RECOVERY_MARGIN", (n) => n >= 0 && n < 1) ?? 0.5;
}

/**
 * The multiple of the ordinary promotion margin a RECOVERED candidate must
 * clear. A rule that gets a second look has had two chances at the gate, and
 * two looks at level α admit more null rules than one — total false-positive
 * rate is `p + P(recovery zone | H0)·p2`, which no choice of second-look
 * threshold can drive back to `p`. The remedy is to make the second look
 * strictly harder: at 1.5 the recovered candidate must clear the bar by
 * 1.5·z·SE (3 SE at the default z), which on the recorded `sql` pool holds the
 * added false positives to +0.10 points on a 12.0% base while the recovery
 * still buys +2.9 points of power at a 10% true saving (3,000 trials).
 *
 * 1 (no extra strictness) was measured and REJECTED: five times the false
 * positives for two-and-a-half times the power. See FINDINGS.md.
 */
export function recoveryStrictness(): number {
	// Below 1 would make a re-tried rule EASIER to bank than a first-time one,
	// which inverts the whole point.
	return numericEnv("WARDEN_RECOVERY_STRICTNESS", (n) => n >= 1) ?? 1.5;
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
/**
 * Token budget the compiled MEMORY.md may occupy, or null for unbounded.
 *
 * NULL BY DEFAULT: only the operator knows how much of an agent's context
 * window is reasonable to spend on memory, and guessing on their behalf would
 * silently drop rules they measured and paid for. Set
 * `WARDEN_CONTEXT_BUDGET=<tokens>` to enable the knapsack packer in
 * `memory.ts`.
 *
 * Rejects zero, negative and non-numeric values rather than clamping — a budget
 * of 0 would compile an empty memory file, which is a far worse failure than
 * ignoring a typo. Blank must mean ABSENT rather than zero, the same trap
 * `recoveryMarginFraction` documents.
 */
export function memoryContextBudget(): number | null {
	// No fallback: unset means unbounded, which is the shipped default.
	return numericEnv("WARDEN_CONTEXT_BUDGET", (n) => n > 0);
}

export function effectiveRent(contextCost: number): number {
	return (
		contextCost + (contextCost * CACHE_CREATE_MULTIPLIER) / sessionsPerWeek()
	);
}

/**
 * The bar a rule's measured saving must clear to be kept: TWICE its effective
 * rent, in tokens.
 *
 * The 2x is the project's founding margin — a rule that merely breaks even is
 * not worth the context slot or the reader's attention, and doubling leaves
 * room for the rent estimate itself to be wrong. `effectiveRent` already prices
 * the cache re-prefill, so this is conservative twice over.
 *
 * It lives here because it was written out ten times across `select.ts` and
 * `power.ts` as a bare `2 * effectiveRent(...)`. Nothing was wrong with any
 * single copy; the hazard is that the planner (`power.ts`, which tells you how
 * many runs you need) and the gate (`select.ts`, which decides) have to agree
 * on the bar EXACTLY. If they ever disagreed, the planner would size a burn
 * against a threshold the gate does not use, and the failure would be a
 * plausible-looking run count rather than an error.
 */
export function keepBar(contextCost: number): number {
	return 2 * effectiveRent(contextCost);
}
