/**
 * Successive Halving: where to spend a fixed measurement budget across
 * competing candidates.
 *
 * THE PROBLEM. A benchmark run is the expensive thing this project does -- the
 * README prices discovery at $19.13 against $5.34/developer/year of savings, so
 * the instrument currently costs more than what it measures is worth. The
 * distiller emits up to three candidates per invocation and the suite is run
 * for all of them at the same depth, which means the same tokens are spent
 * confirming an obvious loser as resolving a genuine close call.
 *
 * THE THEOREM (Karnin, Koren & Somekh, ICML 2013; see also Jamieson &
 * Talwalkar, AISTATS 2016). Split a budget `B` into `ceil(log_eta n)` rounds.
 * In each round, divide that round's share evenly among the surviving arms,
 * measure, then keep only the best `1/eta` of them. Identifying the best arm
 * this way costs `O(H_2 log n)` where `H_2 = max_i i * Delta_i^-2`, against
 * `O(n * H_1)` for spending the budget uniformly. The budget concentrates
 * geometrically on the arms that are still in contention.
 *
 * WHAT THIS DOES AND DOES NOT CHANGE. It is worth being exact, because an
 * earlier draft of docs/four-theorems.md overstated it as "cannot change a
 * verdict, only how many tokens were spent reaching it". That is wrong. A
 * candidate eliminated in round 1 is measured at shallower depth than uniform
 * allocation would have given it, so its verdict genuinely can differ.
 *
 * The accurate statement is directional:
 *
 *   - Successive Halving can never PROMOTE something uniform allocation would
 *     not have. Survivors finish with MORE runs than uniform would buy them,
 *     so the winner's evidence is strictly better, and the promotion gate is
 *     unchanged.
 *   - It can produce a FALSE NEGATIVE: a genuinely good rule that measured
 *     badly in round 1 gets cut before it can prove itself.
 *
 * That asymmetry is the right one for this repo -- it never loosens the gate --
 * and the false-negative case already has machinery waiting for it. An
 * early-eliminated candidate is exactly the `underpowered` eviction class
 * (migration #16): the point estimate never got the evidence to clear the bar,
 * as opposed to being measured and falsified. Those rules keep their `recovers`
 * lineage and are eligible for a second, deeper look.
 *
 * This module is PURE: it computes a schedule and applies an elimination rule.
 * Driving the benchmark is the caller's job, because the benchmark is async,
 * spawns subprocesses, and must stay testable without either.
 */

/** One round of the schedule: how many arms survive into it, and how many runs
 * each of them gets. */
export interface HalvingRound {
	/** Arms measured in this round. */
	arms: number;
	/** Runs each surviving arm receives this round. */
	runsPerArm: number;
}

/**
 * The number of elimination rounds for `n` arms at reduction factor `eta` --
 * `ceil(log_eta n)` in the textbook statement.
 *
 * Computed by counting actual divisions rather than by evaluating
 * `ceil(log(n)/log(eta))`, for two reasons. The float form is WRONG at exact
 * powers: `Math.log(9)/Math.log(3)` is 2.0000000000000004, so `ceil` returns 3
 * rounds for a field that needs 2. And counting divisions is the same
 * arithmetic `halvingSchedule` uses to narrow the field (`ceil(arms/eta)`), so
 * the two can never disagree about how many rounds a field takes -- which they
 * would, silently, at every exact power of eta.
 */
export function halvingRounds(n: number, eta = 2): number {
	if (n <= 1) return 1;
	let rounds = 0;
	let arms = n;
	while (arms > 1) {
		arms = Math.ceil(arms / eta);
		rounds++;
	}
	return Math.max(1, rounds);
}

/**
 * Plan how to spend `budget` total runs across `n` arms.
 *
 * Each round receives an equal share of the budget and splits it evenly among
 * that round's survivors, so runs-per-arm grows geometrically as the field
 * narrows. Rounds that cannot afford even one run per surviving arm are
 * DROPPED rather than emitted with `runsPerArm: 0` -- a round that measures
 * nothing cannot rank anything, so eliminating on its output would be
 * discarding arms at random.
 *
 * The returned schedule never exceeds `budget` in total.
 */
export function halvingSchedule(
	n: number,
	budget: number,
	eta = 2,
): HalvingRound[] {
	if (n <= 0 || budget <= 0) return [];
	const rounds = halvingRounds(n, eta);
	const perRound = budget / rounds;

	const schedule: HalvingRound[] = [];
	let arms = n;
	let spent = 0;
	for (let r = 0; r < rounds && arms >= 1; r++) {
		const runsPerArm = Math.floor(perRound / arms);
		if (runsPerArm >= 1) {
			// Never let accumulated flooring push the plan over the budget.
			const affordable = Math.floor((budget - spent) / arms);
			const take = Math.min(runsPerArm, affordable);
			if (take >= 1) {
				schedule.push({ arms, runsPerArm: take });
				spent += take * arms;
			}
		}
		if (arms === 1) break;
		arms = Math.max(1, Math.ceil(arms / eta));
	}
	return schedule;
}

/**
 * Keep the best `ceil(|arms| / eta)` by score, highest first.
 *
 * `score` is "higher is better" -- for this project, the interim estimate of
 * tokens saved. Ties are broken by the caller's original ordering, which keeps
 * the result deterministic; an unstable tie-break would make a re-run of the
 * same measurement eliminate a different arm.
 */
export function eliminate<T>(
	arms: readonly T[],
	score: (arm: T) => number,
	eta = 2,
): T[] {
	if (arms.length <= 1) return [...arms];
	const keep = Math.max(1, Math.ceil(arms.length / eta));
	return arms
		.map((arm, index) => ({ arm, index, value: score(arm) }))
		.sort((a, b) => b.value - a.value || a.index - b.index)
		.slice(0, keep)
		.map((e) => e.arm);
}

/**
 * Total runs a uniform allocation would give each of `n` arms for the same
 * budget -- the baseline Successive Halving is measured against.
 *
 * Exported because the comparison is the entire justification for the module,
 * and a caller reporting "we spent X instead of Y" should not re-derive it.
 */
export function uniformRunsPerArm(n: number, budget: number): number {
	if (n <= 0) return 0;
	return Math.floor(budget / n);
}

/**
 * Total runs the eventual winner accumulates under a schedule -- the sum of
 * `runsPerArm` across every round, since the winner survives all of them.
 */
export function winnerRuns(schedule: readonly HalvingRound[]): number {
	return schedule.reduce((total, round) => total + round.runsPerArm, 0);
}
