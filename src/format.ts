/**
 * Shared output formatting.
 *
 * This module exists because `fmt` was defined seven times across six modules
 * under ONE name with TWO different contracts: `attribute.ts`, `compare.ts`,
 * `receipt.ts` and `status.ts` grouped the number as given, while `cohort.ts`,
 * `confirm.ts` and `power.ts` rounded it first. A reader who learned `fmt` in
 * one report was wrong in the next, and the difference is visible in published
 * output (a mean of 1000.4 renders as "1,000.4" or "1,000" depending on which
 * file you happen to be in).
 *
 * Four of those six modules — `attribute`, `compare`, `cohort`, `confirm` —
 * were deleted in v1.0.0. The history is kept because it is the reason both
 * contracts still exist side by side; the surviving importers are `cost.ts`,
 * `receipt.ts`, `power.ts` and `status.ts`.
 *
 * The two contracts are deliberately NOT unified — that would silently change
 * rendered numbers in half the reports. They are given separate, honest names
 * so a call site declares which one it means, and the ambiguity is resolved at
 * the import line rather than hidden in a local helper.
 */

/** Group a number for display exactly as given — no rounding. Use for values
 * that are already integers, or where the fractional part is meaningful. */
export function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

/** Round to the nearest integer, then group. Use for derived quantities
 * (means, projections, minimum detectable savings) where a fractional token is
 * noise rather than information. */
export function formatRounded(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

/**
 * A signed percentage change, or "n/a" when the baseline is zero.
 *
 * A percentage of a zero baseline is undefined, and reporting 0 for it would
 * read as "no relative change" — a different and false claim. It lives here
 * rather than in `status.ts` because `compare.ts` needed it too, and importing
 * the whole status report to reach one formatter was the coupling this
 * extraction removed.
 *
 * `compare.ts` is gone and `status.ts` is now the ONLY caller, so that reason
 * has expired: this could move back with nothing lost but the churn. Recorded
 * rather than acted on, because a formatter in a formatting module is not
 * wrong — it is just no longer justified by the argument written above it.
 */
export function pctChange(current: number, baseline: number): string {
	if (baseline === 0) return "n/a";
	const change = ((current - baseline) / baseline) * 100;
	const sign = change > 0 ? "+" : "";
	return `${sign}${change.toFixed(1)}%`;
}

/**
 * A dollar amount. Two decimals down to a cent, five below that — the per-run
 * savings this project reports are routinely fractions of a cent, and rounding
 * them to "$0.00" would erase the very quantity being measured.
 */
export function usd(n: number): string {
	return n >= 0.01 || n <= -0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(5)}`;
}
