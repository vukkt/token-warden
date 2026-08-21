/**
 * Empirical-Bayes variance moderation: borrowing strength across golden tasks
 * so a variance estimated from three runs stops being a coin flip.
 *
 * WHY THIS AND NOT JAMES-STEIN. docs/four-theorems.md originally specified
 * James-Stein shrinkage of the per-task SAVINGS toward their pooled mean. That
 * is a no-op for this gate, and the algebra says so in one line: the estimator
 * is `theta_JS = xbar + c*(x - xbar)`, so `mean(theta_JS) = xbar` exactly --
 * shrinkage toward the grand mean PRESERVES the grand mean. The verdict reads
 * the suite mean, and `withinTaskSE` reads per-task VARIANCES; shrinking the
 * per-task means changes neither number. Implemented as specified, it would
 * have been decoration with a famous name on it.
 *
 * THE REAL DEFECT. At the default runs=3, each task's variance is a sample
 * variance on 2 degrees of freedom. Such an estimate is wildly unstable -- its
 * own relative standard deviation is on the order of 100%. That instability
 * flows straight into `z * SE`: a task that happens to look quiet makes the
 * band too narrow (a rule is promoted on noise) and one that happens to look
 * loud makes it too wide (a real rule is missed). It is a plausible mechanism
 * for the gap between the ~2-3% synthetic false-positive rate and the 8.8%
 * measured on recorded runs.
 *
 * THE THEOREM (Smyth, Stat. Appl. Genet. Mol. Biol. 2004 -- the moderated
 * t-statistic behind limma). Model the per-task variances as
 *
 *     s_i^2 | sigma_i^2  ~  sigma_i^2 * chisq(d_i) / d_i
 *     1 / sigma_i^2      ~  chisq(d_0) / (d_0 * s_0^2)
 *
 * The posterior mean of `sigma_i^2` is then a closed-form blend of the task's
 * own variance and a prior fitted to the whole suite:
 *
 *     s~_i^2 = (d_0 * s_0^2 + d_i * s_i^2) / (d_0 + d_i)
 *
 * carrying `d_i + d_0` degrees of freedom instead of `d_i`. The hyperparameters
 * `d_0` and `s_0^2` are estimated FROM THE DATA by matching the first two
 * moments of `log s_i^2`, so nothing is hand-tuned.
 *
 * This generalises what `select.ts` already does. It borrows the pooled
 * variance when a side cannot estimate its own (`sampleVariance(...) ?? pooled`)
 * -- an all-or-nothing switch between "trust this task completely" and "ignore
 * it completely". Moderation is the principled continuum between those two,
 * with the blend weight estimated rather than assumed.
 *
 * WHAT IT DOES NOT FIX, STATED PLAINLY. The binding constraint from
 * DECISIONS.md v0.36.0 -- a ~54-token bar against a ~5,500-token SE -- is a
 * property of the benchmark, not of the estimator. Nothing in this file makes
 * the TRUE standard error smaller; only more runs or quieter golden tasks do
 * that. What moderation buys is a correctly calibrated decision at the SAME run
 * count: a stabler variance estimate, hence a band that is the width it claims
 * to be. Expect it to show up as a lower false-positive rate, not as more
 * promotions.
 *
 * Whether it delivers that is a question for `validation/empirical-calibration.ts`,
 * and it does not enter the verdict path until that answers yes -- the same
 * discipline that vetoed robust-SE in v0.30.0.
 *
 * Pure and zero-token.
 */

/**
 * Where the asymptotic series below is truncated. The first omitted term is
 * O(z^-8) for digamma and O(z^-9) for trigamma, so the residual error is
 * roughly `1/(240*z^8)`: about 2e-9 at z=6 and about 1e-12 at z=14. The tests
 * pin ten decimal places against closed-form values, which 6 does not reach and
 * 14 does. The recurrences below are exact, so raising this costs a handful of
 * additions and buys three orders of magnitude.
 */
const ASYMPTOTIC_FROM = 14;

/**
 * Digamma via the standard asymptotic series, with upward recurrence to reach
 * the regime where that series is accurate. Absolute error ~1e-12 for x > 0.
 */
export function digamma(x: number): number {
	let value = 0;
	let z = x;
	// psi(z) = psi(z+1) - 1/z, applied until the asymptotic form is good.
	while (z < ASYMPTOTIC_FROM) {
		value -= 1 / z;
		z += 1;
	}
	const inv = 1 / z;
	const inv2 = inv * inv;
	return (
		value +
		Math.log(z) -
		0.5 * inv -
		inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 / 252))
	);
}

/** Trigamma (the derivative of digamma), same technique. Strictly decreasing
 * and positive on x > 0, which is what makes the inversion below well posed. */
export function trigamma(x: number): number {
	let value = 0;
	let z = x;
	// psi'(z) = psi'(z+1) + 1/z^2
	while (z < ASYMPTOTIC_FROM) {
		value += 1 / (z * z);
		z += 1;
	}
	const inv = 1 / z;
	const inv2 = inv * inv;
	return (
		value + inv * (1 + 0.5 * inv + inv2 * (1 / 6 - inv2 * (1 / 30 - inv2 / 42)))
	);
}

/**
 * Solve `trigamma(x) = y` for x > 0, by bisection.
 *
 * Bisection rather than Newton deliberately: Newton needs the tetragamma, which
 * is a third special function to implement and verify, and this is called once
 * per verdict over a suite of roughly ten tasks. Robustness is worth more than
 * speed here. Trigamma is strictly decreasing, so bracketing is trivial and
 * convergence is guaranteed.
 *
 * Returns `Infinity` for `y <= 0`, the boundary meaning "no excess variability
 * beyond sampling noise" -- an infinite prior degrees of freedom, i.e. every
 * task's variance replaced entirely by the pooled estimate.
 */
export function trigammaInverse(y: number): number {
	if (!Number.isFinite(y) || y <= 0) return Number.POSITIVE_INFINITY;
	// trigamma(x) ~ 1/x for large x, so x ~ 1/y is a good starting bracket.
	let low = 1e-8;
	let high = Math.max(1, 1 / y);
	while (trigamma(high) > y) high *= 2;
	while (trigamma(low) < y) low /= 2;
	for (let i = 0; i < 200; i++) {
		const mid = (low + high) / 2;
		if (trigamma(mid) > y) low = mid;
		else high = mid;
	}
	return (low + high) / 2;
}

export interface ModeratedVariances {
	/** Posterior-mean variance per input, aligned with `variances`. */
	moderated: number[];
	/** Fitted prior degrees of freedom. Infinity means the suite showed no
	 * excess variability, so every task takes the pooled estimate. */
	priorDf: number;
	/** Fitted prior variance -- the suite-level scale tasks shrink toward. */
	priorVariance: number;
	/** Degrees of freedom the moderated variances carry: `d_i + d_0`. */
	moderatedDf: number[];
}

/**
 * Fit the prior and return posterior-mean variances.
 *
 * `variances[i]` is task i's sample variance and `dfs[i]` its degrees of
 * freedom (runs - 1). Inputs with zero or non-finite variance are excluded from
 * the FIT -- `log(0)` is undefined and one degenerate task would otherwise
 * destroy the hyperparameter estimate -- but they still receive a moderated
 * value, which is precisely the case moderation exists to rescue.
 *
 * With fewer than two usable tasks there is nothing to borrow from, and the
 * inputs are returned unchanged rather than shrunk toward a prior fitted on a
 * single observation.
 */
export function moderateVariances(
	variances: readonly number[],
	dfs: readonly number[],
): ModeratedVariances {
	const usable: number[] = [];
	for (let i = 0; i < variances.length; i++) {
		const v = variances[i] as number;
		const d = dfs[i] as number;
		if (Number.isFinite(v) && v > 0 && Number.isFinite(d) && d > 0)
			usable.push(i);
	}

	if (usable.length < 2) {
		return {
			moderated: [...variances],
			priorDf: 0,
			priorVariance: Number.NaN,
			moderatedDf: [...dfs],
		};
	}

	// Smyth 2004 section 6: match the first two moments of z = log(s^2).
	// E[z_i] = log(s_0^2) + digamma(d_i/2) - log(d_i/2)
	// Var[z_i] = trigamma(d_i/2) + trigamma(d_0/2)
	const e: number[] = [];
	for (const i of usable) {
		const v = variances[i] as number;
		const d = dfs[i] as number;
		e.push(Math.log(v) - digamma(d / 2) + Math.log(d / 2));
	}
	const n = e.length;
	const eBar = e.reduce((a, b) => a + b, 0) / n;
	const eVar = e.reduce((acc, value) => acc + (value - eBar) ** 2, 0) / (n - 1);

	let meanTrigamma = 0;
	for (const i of usable) meanTrigamma += trigamma((dfs[i] as number) / 2);
	meanTrigamma /= n;

	// The excess of observed spread over what sampling noise alone explains.
	// Non-positive means the tasks look homogeneous: no excess variability, so
	// the prior is infinitely strong and every task takes the pooled scale.
	const excess = eVar - meanTrigamma;
	const priorDf =
		excess <= 0 ? Number.POSITIVE_INFINITY : 2 * trigammaInverse(excess);

	const priorVariance = Number.isFinite(priorDf)
		? Math.exp(eBar + digamma(priorDf / 2) - Math.log(priorDf / 2))
		: Math.exp(eBar);

	const moderated: number[] = [];
	const moderatedDf: number[] = [];
	for (let i = 0; i < variances.length; i++) {
		const v = variances[i] as number;
		const d = dfs[i] as number;
		if (!Number.isFinite(priorDf)) {
			// Infinite prior weight: the task's own variance carries no weight.
			moderated.push(priorVariance);
			moderatedDf.push(Number.POSITIVE_INFINITY);
			continue;
		}
		if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(d) || d <= 0) {
			// A task that could not estimate its own variance takes the prior
			// outright -- the same rescue `select.ts` currently spells as
			// `sampleVariance(...) ?? pooled`, now with a fitted scale.
			moderated.push(priorVariance);
			moderatedDf.push(priorDf);
			continue;
		}
		moderated.push((priorDf * priorVariance + d * v) / (priorDf + d));
		moderatedDf.push(d + priorDf);
	}

	return { moderated, priorDf, priorVariance, moderatedDf };
}
