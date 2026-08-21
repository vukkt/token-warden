/**
 * Choosing the kept SET of rules, under the context window as a budget.
 *
 * THE PROBLEM. The gate asks each rule, independently, whether it clears twice
 * its own rent. That is a per-item test, and it is wrong in one specific way:
 * two rules that say nearly the same thing each pass it, and together save far
 * less than the sum of their measured savings. "Grep before reading a file" and
 * "search before opening files" both clear the bar alone; the second adds
 * almost nothing once the first is in memory. Nothing in the current design can
 * express that, so nothing detects it.
 *
 * THE OBJECTIVE, AND WHY IT IS GENUINELY SUBMODULAR. It would be easy to write
 * a plausible-looking discount rule here and call the result submodular without
 * it being so. Instead the objective is a FACILITY-LOCATION function, which is
 * monotone submodular by construction:
 *
 *     f(S) = sum over modes m of  s_m * max_{i in S} sigma(i, m)
 *
 * Read `m` as a waste mode -- a way the agent burns tokens -- with `s_m` the
 * saving available from addressing it, and `sigma(i, m)` in [0, 1] as how well
 * rule `i` addresses it. Each mode is credited to its BEST covering rule and
 * counted once. A second rule covering the same mode adds only the difference
 * it improves, which is the diminishing return we want.
 *
 * `max` over a growing set is non-decreasing, so f is monotone; and because
 * each mode's contribution is a max, the marginal gain of adding a rule can
 * only shrink as S grows, which is exactly submodularity. Both properties are
 * checked directly in the tests rather than asserted here.
 *
 * The mode universe is the candidate set itself: every rule is taken as the
 * proxy for the waste mode it was distilled to address, with `sigma(i, i) = 1`.
 *
 * DEGRADING TO THE CURRENT BEHAVIOUR. With the default similarity -- 1 on the
 * diagonal, 0 elsewhere -- f collapses to `sum of s_i over S`, a modular
 * function, and the problem becomes an ordinary 0/1 knapsack. That matters: the
 * repo has NOT measured pairwise rule overlap, so the honest default is to
 * assume none, and this module must not invent savings structure it has no data
 * for. Supply a real `similarity` only once there is a measurement behind it.
 *
 * THE GUARANTEE (Khuller, Moss & Naor, IPL 1999). Greedy by density -- always
 * take the feasible item with the best marginal-gain-per-token -- and then
 * return the better of that set and the single best feasible item. For monotone
 * submodular f under a knapsack constraint this achieves `(1 - 1/e)/2 ~ 0.316`
 * of the optimum. The best-single-item comparison is not a flourish: without it
 * density-greedy has NO constant factor, because it can fill the budget with
 * many cheap crumbs and miss one large item that alone beats them.
 *
 * Sviridenko (2004) reaches the full `(1 - 1/e)` by running the same density
 * greedy from every feasible seed set of size 3 and keeping the best. That is
 * an O(n^5)-ish enumeration for a constant-factor improvement on a set of rules
 * that numbers in the tens, and it is deliberately not implemented -- the
 * bound below is the one this code earns.
 *
 * Pure and zero-token.
 */

export interface PackCandidate {
	id: string;
	/** Tokens of context this rule occupies every session. */
	contextCost: number;
	/** Measured tokens saved per session by this rule ALONE. */
	saving: number;
	/** Forced into the solution regardless of density -- the knapsack home for
	 * `rules.protected`. Forced items consume budget before anything else. */
	forced?: boolean;
}

export interface PackResult {
	/** Chosen rule ids, in the order greedy selected them. */
	chosen: string[];
	/** Objective value of the chosen set. */
	value: number;
	/** Total context cost of the chosen set. */
	cost: number;
}

/** How well rule `i` covers the waste mode that rule `m` stands for, in [0, 1].
 * The default assumes rules are independent: each covers only its own mode. */
export type Similarity = (i: PackCandidate, m: PackCandidate) => number;

const INDEPENDENT: Similarity = (i, m) => (i.id === m.id ? 1 : 0);

/**
 * The facility-location objective over a chosen subset.
 *
 * `universe` is the full candidate set -- the modes available to be covered --
 * and does not change as `chosen` grows.
 */
export function coverageValue(
	chosen: readonly PackCandidate[],
	universe: readonly PackCandidate[],
	similarity: Similarity = INDEPENDENT,
): number {
	let total = 0;
	for (const mode of universe) {
		let best = 0;
		for (const rule of chosen) {
			const covered = similarity(rule, mode);
			if (covered > best) best = covered;
		}
		total += mode.saving * best;
	}
	return total;
}

const totalCost = (items: readonly PackCandidate[]): number =>
	items.reduce((sum, item) => sum + item.contextCost, 0);

/**
 * Density-greedy with the best-single-item guard.
 *
 * Forced candidates are seeded first and are NOT subject to the budget -- a
 * protected rule is by definition one the operator has decided to carry. If the
 * forced set alone overruns the budget, the result reports that honestly via
 * `cost` rather than silently dropping one.
 */
export function packRules(
	candidates: readonly PackCandidate[],
	budget: number,
	similarity: Similarity = INDEPENDENT,
): PackResult {
	const universe = candidates;
	const forced = candidates.filter((c) => c.forced);
	const optional = candidates.filter((c) => !c.forced);

	const chosen: PackCandidate[] = [...forced];
	let spent = totalCost(forced);
	const remaining = new Set(optional);

	// Greedy: repeatedly take the affordable item with the best marginal gain
	// per token of rent.
	for (;;) {
		let best: PackCandidate | null = null;
		let bestDensity = 0;
		const current = coverageValue(chosen, universe, similarity);
		for (const candidate of remaining) {
			if (spent + candidate.contextCost > budget) continue;
			if (candidate.contextCost <= 0) continue;
			const gain =
				coverageValue([...chosen, candidate], universe, similarity) - current;
			const density = gain / candidate.contextCost;
			if (density > bestDensity) {
				bestDensity = density;
				best = candidate;
			}
		}
		if (best === null) break;
		chosen.push(best);
		remaining.delete(best);
		spent += best.contextCost;
	}

	const greedyValue = coverageValue(chosen, universe, similarity);

	// The guard. Density-greedy alone has no constant-factor guarantee: it can
	// spend the whole budget on cheap crumbs and miss a single large item that
	// beats all of them together.
	let bestSingle: PackCandidate | null = null;
	let bestSingleValue = 0;
	for (const candidate of optional) {
		if (totalCost(forced) + candidate.contextCost > budget) continue;
		const value = coverageValue([...forced, candidate], universe, similarity);
		if (value > bestSingleValue) {
			bestSingleValue = value;
			bestSingle = candidate;
		}
	}

	if (bestSingle !== null && bestSingleValue > greedyValue) {
		const set = [...forced, bestSingle];
		return {
			chosen: set.map((c) => c.id),
			value: bestSingleValue,
			cost: totalCost(set),
		};
	}

	return {
		chosen: chosen.map((c) => c.id),
		value: greedyValue,
		cost: spent,
	};
}
