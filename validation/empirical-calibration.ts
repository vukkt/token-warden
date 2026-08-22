/**
 * EMPIRICAL CALIBRATION — false-positive rate and power under the REAL noise.
 *
 * The synthetic harness (validation/calibration.ts) assumes a noise model
 * (Gaussian, or Gaussian plus derailments). This harness drops that assumption:
 * it resamples RECORDED golden runs — genuine replicates that executed the
 * identical (task, ruleset version, model) configuration — through the real
 * verdict pipeline (`assessDelta` + `verdict` + top-up). Zero tokens: every
 * "run" is a token total already sitting in the runs table.
 *
 * Two resampling schemes, and what each honestly claims:
 *
 * A/A PERMUTATION — per task, shuffle the replicate pool and deal the first
 * `runs` totals to the "without" side and the next `runs` to the "with" side.
 * Both sides come from the same pool, so the true delta is 0 BY CONSTRUCTION
 * and the runs are exchangeable under that null — no distributional assumption
 * at all for the initial split. The keep rate over many trials IS the
 * empirical false-positive rate of candidate promotion on this agent's real
 * run-to-run noise. One hybrid step: when a trial lands uncertain, the real
 * selector spends a top-up pass, so the trial resolves it by drawing extra
 * runs WITH replacement from the replicates NOT used in the initial split
 * (bootstrap, not permutation). Counting uncertain trials as evictions instead
 * would understate the false-positive rate, because the real pipeline gets a
 * second look before deciding.
 *
 * BOOTSTRAP — per task, draw both sides WITH replacement from the pool, then
 * subtract a KNOWN injected saving from every with-side draw. injected=0 is a
 * bootstrap A/A (cross-check of the permutation); injected>0 is semi-synthetic
 * POWER: how often a rule with that true effect survives under the recorded
 * noise distribution. Top-ups are more with-replacement draws, placed by the
 * real `allocateTopUpRuns` when it yields an allocation.
 *
 * The Wilson interval printed next to each keep rate covers Monte-Carlo
 * resampling error only — NOT the sampling variability of the underlying pool
 * (a handful of recorded runs is still a handful of runs).
 *
 * Note: `openDb()` runs pending schema migrations on open (append-only, the
 * same as any warden command); the harness itself only SELECTs.
 *
 *   npx tsx validation/empirical-calibration.ts [--agent <name>] [--db <path>]
 *     [--mode permutation|bootstrap|eviction|recovery|both] [--trials N] [--runs N]
 *     [--rent N] [--seed N] [--cycles N] [--retention-rounds N]
 */
import { pathToFileURL } from "node:url";
import { summarizeTask, type TaskSummary } from "../src/bench.js";
import { numericFlag } from "../src/cli.js";
import {
	type GoldenReplicateRun,
	goldenReplicateRuns,
	openDb,
} from "../src/db.js";
import { assertKnownAgent, knownAgents } from "../src/registry.js";
import {
	allocateTopUpRuns,
	assessDelta,
	type DeltaAssessment,
	evictedUnderpowered,
	MAX_RETENTION_ROUNDS,
	mergeSummaries,
	promotionThreshold,
	retentionRounds,
	twoStrikeRetention,
	verdict,
	verdictWithReason,
} from "../src/select.js";
import {
	confidenceZ,
	keepBar,
	recoveryMarginFraction,
	recoveryStrictness,
} from "../src/stats.js";
import { mulberry32 } from "./rng.js";

const DEFAULT_TRIALS = 2000;
/** Permutation deals 2×runs distinct totals per trial, so pools of ≥4 qualify
 * at the default; bootstrap resamples with replacement and can afford the
 * selector's default of 3 runs per side. */
const DEFAULT_PERM_RUNS = 2;
const DEFAULT_BOOT_RUNS = 3;
const DEFAULT_RENT = 25;
/** Consecutive re-audits simulated per rule in eviction mode. Twelve is a
 * year of monthly re-audits, or a quarter of weekly ones — long enough for two
 * consecutive unlucky draws to be a real risk rather than a curiosity. */
const DEFAULT_CYCLES = 12;
const DEFAULT_SEED = 42;
/** Runs per side of the second look in recovery mode. Deeper than the default
 * first look by one, the least the shipped policy will accept. */
const DEFAULT_RECOVERY_RUNS = 4;
const INJECTED_FRACS = [0, 0.02, 0.05, 0.1, 0.2];

export interface ReplicateGroup {
	taskId: string;
	totals: number[];
}

/**
 * Group recorded runs into replicate pools. Runs sharing
 * `taskHash|rulesetVersion|model` executed the IDENTICAL configuration —
 * genuine repeated measurements of one distribution, hence exchangeable under
 * the null. A task may appear at most once per simulated suite, so per
 * taskHash only the single largest group survives (ties resolve to the first
 * key in sorted order, for determinism); groups with fewer than `minRuns`
 * totals are dropped. Sorted by taskId.
 */
export function groupReplicates(
	rows: GoldenReplicateRun[],
	minRuns: number,
): ReplicateGroup[] {
	const byKey = new Map<string, { taskId: string; totals: number[] }>();
	for (const row of rows) {
		const key = `${row.taskHash}|${row.rulesetVersion}|${row.model}`;
		const group = byKey.get(key);
		if (group) group.totals.push(row.total);
		else byKey.set(key, { taskId: row.taskHash, totals: [row.total] });
	}
	const bestByTask = new Map<string, ReplicateGroup>();
	for (const key of [...byKey.keys()].sort()) {
		const group = byKey.get(key) as { taskId: string; totals: number[] };
		const current = bestByTask.get(group.taskId);
		if (!current || group.totals.length > current.totals.length) {
			bestByTask.set(group.taskId, group);
		}
	}
	return [...bestByTask.values()]
		.filter((g) => g.totals.length >= minRuns)
		.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** In-place Fisher-Yates on a copy. */
function shuffled(rng: () => number, xs: number[]): number[] {
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = out[i] as number;
		out[i] = out[j] as number;
		out[j] = tmp;
	}
	return out;
}

/** n draws WITH replacement. */
function resample(rng: () => number, pool: number[], n: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		out.push(pool[Math.floor(rng() * pool.length)] as number);
	}
	return out;
}

/** Wrap raw token totals as a completed-run task summary; `tag` keeps
 * sessionIds unique across the sides and top-up passes of one trial (merged
 * summaries concatenate result lists).
 *
 * Exported for `stream-calibration.ts`, which needs to build samples the same
 * way this harness does -- a second copy of this wrapper is exactly how two
 * harnesses start disagreeing about what they are measuring. */
export function toSummary(
	taskId: string,
	totals: number[],
	tag: string,
): TaskSummary {
	return summarizeTask(
		taskId,
		totals.map((tokens, i) => ({
			sessionId: `${taskId}-${tag}-${i}`,
			tokens,
			completed: true,
		})),
	);
}

/**
 * The selector's candidate-promotion logic, on the real functions: not a
 * regression, measurable, and — after at most one top-up pass when the first
 * assessment is uncertain — confidently clearing the 2×-rent bar. Mirrors
 * `selectForAgent`'s decide() path for candidates (evict-when-uncertain).
 */
export function candidateLook(
	without: TaskSummary[],
	withRule: TaskSummary[],
	rent: number,
	topUp: ((measured: TaskSummary[]) => TaskSummary[] | null) | null,
): DeltaAssessment {
	const a = assessDelta(without, withRule, rent);
	// An environment-failed measurement makes the selector ABORT (no verdict);
	// for the keep-rate harness that maps to "not kept".
	if (a.regression || a.environmentFailure || a.delta === null) return a;
	if (a.uncertain && topUp !== null) {
		const extra = topUp(withRule);
		if (extra) {
			return assessDelta(without, mergeSummaries(withRule, extra), rent);
		}
	}
	return a;
}

/**
 * The promotion test itself, at `scale` times the gate's confidence margin.
 * scale 1 is the shipped gate (`!uncertain` plus the 2×-rent verdict); a
 * recovery attempt is judged at `recoveryStrictness()`, through the SAME
 * `promotionThreshold` the selector uses, so the harness cannot drift from the
 * policy it is measuring.
 */
export function promotedAt(
	a: DeltaAssessment,
	rent: number,
	scale = 1,
): boolean {
	if (a.delta === null || a.regression || a.environmentFailure) return false;
	if (verdict({ measuredDelta: a.delta, contextCost: rent }) !== "active") {
		return false;
	}
	if (scale === 1) return !a.uncertain;
	const threshold = promotionThreshold(
		rent,
		a.standardError,
		a.confidenceMultiple,
		scale,
	);
	return threshold !== null && a.delta >= threshold;
}

export function candidateKept(
	without: TaskSummary[],
	withRule: TaskSummary[],
	rent: number,
	topUp: ((measured: TaskSummary[]) => TaskSummary[] | null) | null,
): boolean {
	return promotedAt(candidateLook(without, withRule, rent, topUp), rent);
}

/**
 * FALSE EVICTION — the tail the A/A harness does not cover.
 *
 * `candidateKept` above models ADMISSION: a rule arriving for the first time.
 * Eviction is a different path with different logic. A rule already in memory is
 * re-audited, and two-strike retention applies: one sub-threshold draw puts it on
 * probation and it SURVIVES; only a second CONSECUTIVE sub-threshold draw evicts.
 *
 * So the false-eviction rate is not a property of a single trial — it is a
 * property of a SEQUENCE. A genuinely earning rule survives one unlucky draw by
 * design; what matters is how often it draws two in a row before the noise
 * averages out. That is what this simulates: `cycles` consecutive re-audits of a
 * rule whose TRUE saving is `trueSaving`, carrying probation state between them
 * exactly as the ledger does.
 *
 * Uses the real `assessDelta`, `verdictWithReason`, `allocateTopUpRuns`,
 * `retentionRounds` and `twoStrikeRetention`, so the policy under measurement
 * is the shipped policy and cannot drift from it.
 *
 * The re-audit TOP-UP is modelled here too (added 2026-07-31). It was missing
 * from the first cut of this harness, which therefore measured a re-audit that
 * decides on its first look — something the selector has never done, since
 * `measureWithTopUp` spends a pass whenever the verdict is within noise of the
 * bar. The published 79.8%/60.8%/25.0% table was produced by that shorter path
 * and is superseded by the numbers in FINDINGS.md; measuring a policy the code
 * does not implement is the same class of error as burn 1 of the RAG benchmark.
 *
 * `maxRetentionRounds` is the knob under test: 0 reproduces the single-top-up
 * behaviour that shipped before v0.43.0, and is the control arm.
 *
 * The BANKED delta is modelled as the ledger keeps it (added 2026-08-13), not
 * as a constant. The first cut held it at `trueSaving` for every cycle, which
 * hands the budget its full margin on the strike-2 cycle; the selector reads
 * `rules.measured_delta`, which the strike-1 verdict has already overwritten
 * with a sub-threshold draw. That is the SECOND time this harness measured a
 * policy the code does not implement, and the FINDINGS.md figures produced
 * before this correction overstate the budget's effect. The caveat recorded
 * with them — that assuming the ledger banks the rule at its true worth is
 * "optimistic in the direction of spending FEWER rounds" — is backwards: the
 * assumption spends MORE rounds than the ship does, not fewer.
 *
 * Returns the cycle index (1-based) at which the rule was wrongly evicted (null
 * if it survived all of them) alongside what the sequence COST in extra
 * measurement passes — a retention policy that buys survival is only worth
 * having if the price is reported next to it. Every eviction here is a FALSE
 * one by construction: the injected effect is real and positive.
 */
export interface EvictionTrialSpec {
	groups: ReplicateGroup[];
	runsPerSide: number;
	rent: number;
	/** The rule's genuine per-run saving, subtracted from the with-rule side of
	 * every draw. It seeds the rule's BANKED delta at admission and nothing
	 * more: after that the banked value follows the ledger (see
	 * `falseEvictionTrial`), because `decideRule` overwrites `measured_delta`
	 * on every decision. */
	trueSaving: number;
	cycles: number;
	maxRetentionRounds: number;
}

export interface EvictionTrialResult {
	/** 1-based cycle of the false eviction, or null if the rule survived. */
	evictedAt: number | null;
	/** Re-audits actually simulated (fewer than `cycles` when it was evicted). */
	reAudits: number;
	/** Top-up rounds spent across those re-audits — the policy's token cost. */
	topUpRounds: number;
}

export function falseEvictionTrial(
	rng: () => number,
	spec: EvictionTrialSpec,
): EvictionTrialResult {
	const { groups, runsPerSide, rent, trueSaving, cycles } = spec;
	let probation = 0;
	let topUpRounds = 0;
	let reAudits = 0;
	// The rule's BANKED delta — `rules.measured_delta`, which is what
	// `retentionRounds` sizes the budget from. Admission seeds it at the rule's
	// worth; after that it follows the ledger, because `decideRule` OVERWRITES
	// `measured_delta` with the delta of EVERY decision, kept or evicted.
	//
	// Modelling it as a constant `trueSaving` (this harness's first cut)
	// measures a policy the selector does not implement, for the second time in
	// this feature. A sub-threshold re-audit that merely puts the rule on
	// probation still writes its own low draw into the ledger, so the next
	// cycle's margin is `that draw - bar`, which is negative by construction —
	// the budget is ZERO on exactly the cycle that decides the eviction.
	//
	// Verified against the shipped selector on a throwaway ledger, two
	// consecutive noisy re-audits of a rule banked at 2,000 tok/run, bar 54:
	//
	//   CYCLE 1: rounds=3  status=active    probation=1  banked_after=0
	//   CYCLE 2: rounds=1  status=evicted                banked_after=0
	let banked: number | null = trueSaving;
	for (let cycle = 1; cycle <= cycles; cycle++) {
		// A re-audit re-measures the active set with and without the rule. The
		// rule genuinely saves `trueSaving`, so the WITHOUT side costs more.
		let without = groups.map((group) =>
			toSummary(group.taskId, resample(rng, group.totals, runsPerSide), "w"),
		);
		let withRule = groups.map((group) =>
			toSummary(
				group.taskId,
				resample(rng, group.totals, runsPerSide).map((t) =>
					Math.max(0, t - trueSaving),
				),
				"m",
			),
		);
		let a = assessDelta(without, withRule, rent);
		// An environment failure aborts the whole decision and writes nothing —
		// the rule keeps its status AND its probation counter. Not an eviction.
		if (a.environmentFailure) continue;
		reAudits++;
		// The measured (toppable) side of a re-audit is the WITHOUT configuration:
		// the baseline already carries the rule. Same budget shape as the
		// selector — one full duplicate of the first measured pass per round,
		// placed by the real Neyman allocator.
		const perRound = without.reduce((sum, s) => sum + s.results.length, 0);
		const budget =
			1 + Math.min(spec.maxRetentionRounds, retentionRounds(banked, rent, a));
		/** One round's runs for a side. `allocation` null = a uniform full pass,
		 * which is what a retention round spends; the first round is placed by
		 * the real Neyman allocator, as the selector does. */
		const round = (
			tag: string,
			saving: number,
			allocation: ReturnType<typeof allocateTopUpRuns>,
		): TaskSummary[] => {
			const extra: TaskSummary[] = [];
			for (const group of groups) {
				const n = allocation
					? (allocation.get(group.taskId) ?? 0)
					: runsPerSide;
				if (n > 0) {
					extra.push(
						toSummary(
							group.taskId,
							resample(rng, group.totals, n).map((t) =>
								Math.max(0, t - saving),
							),
							tag,
						),
					);
				}
			}
			return extra;
		};
		for (let r = 0; r < budget && a.uncertain; r++) {
			// Mirrors `measureWithTopUp`: the first round is one-sided and Neyman
			// placed; retention rounds re-run both sides uniformly. Both
			// differences were measured before being adopted (see FINDINGS.md).
			const retention = r >= 1;
			const extra = round(
				`t${cycle}-${r}`,
				0,
				retention ? null : allocateTopUpRuns(withRule, without, perRound),
			);
			if (extra.length === 0) break;
			without = mergeSummaries(without, extra);
			if (retention) {
				const extraRef = round(`r${cycle}-${r}`, trueSaving, null);
				if (extraRef.length > 0) withRule = mergeSummaries(withRule, extraRef);
			}
			topUpRounds++;
			a = assessDelta(without, withRule, rent);
		}
		const base = verdictWithReason(a.delta, rent, a.regression);
		const outcome = twoStrikeRetention(true, probation, a.regression, base);
		// `decideRule` writes the measured delta on every decision, before the
		// keep/evict branch — so a retained-on-probation rule banks its low draw
		// and pays for it at the next cycle's budget.
		banked = a.delta;
		if (outcome.status === "evicted") {
			return { evictedAt: cycle, reAudits, topUpRounds };
		}
		// probationWrite: true records a strike, false clears it, null leaves it.
		if (outcome.probationWrite === true) probation = 1;
		else if (outcome.probationWrite === false) probation = 0;
	}
	return { evictedAt: null, reAudits, topUpRounds };
}

/**
 * One A/A permutation trial. Exchangeable split (true delta 0 by
 * construction); uncertain verdicts get the hybrid bootstrap top-up from the
 * held-out replicates (see header). Returns whether the null rule was KEPT —
 * a false positive.
 *
 * KNOWN DIVERGENCE, measured and left in place (2026-08-14). The top-up below
 * spends `runsPerSide` on EVERY task; the selector spends the same budget
 * through `allocateTopUpRuns` (Neyman), as `bootstrapLook` does. Same tokens,
 * different placement, so this arm is not quite the shipped gate. Paired
 * execution puts the cost at +1.77pt on the committed fixture and +0.07pt on
 * the recorded sql pool — always upward, and growing with pool depth, so the
 * published permutation false-positive rate is a FLOOR.
 *
 * NOT corrected here on purpose: it moves a figure FINDINGS.md quotes, and this
 * repo does not move a calibration number without correcting the document in
 * the same commit. The argument, the numbers and the CLI that re-derives them
 * against a real ledger are in validation/topup-placement.ts; the fixture
 * figures are pinned in test/empirical-calibration.test.ts so the gap cannot
 * widen unnoticed while the decision is pending.
 */
export function permutationTrial(
	rng: () => number,
	groups: ReplicateGroup[],
	runsPerSide: number,
	rent: number,
): boolean {
	const without: TaskSummary[] = [];
	const withRule: TaskSummary[] = [];
	const heldOut = new Map<string, number[]>();
	for (const group of groups) {
		const deck = shuffled(rng, group.totals);
		without.push(toSummary(group.taskId, deck.slice(0, runsPerSide), "w"));
		withRule.push(
			toSummary(group.taskId, deck.slice(runsPerSide, 2 * runsPerSide), "m"),
		);
		// Top-up pool: the replicates NOT dealt into the initial split, so the
		// second look brings genuinely new information (as a real top-up does).
		// With fewer than 2 held-out runs there is no pool worth the name — fall
		// back to the whole group.
		const rest = deck.slice(2 * runsPerSide);
		heldOut.set(group.taskId, rest.length >= 2 ? rest : group.totals);
	}
	const topUp = (): TaskSummary[] =>
		groups.map((group) =>
			toSummary(
				group.taskId,
				resample(rng, heldOut.get(group.taskId) ?? group.totals, runsPerSide),
				"t",
			),
		);
	return candidateKept(without, withRule, rent, topUp);
}

/**
 * One bootstrap trial: both sides drawn with replacement from the pool, a
 * known `injectedSaving` subtracted from every with-side draw (floored at 0 —
 * a run cannot cost negative tokens). injectedSaving=0 is the bootstrap A/A;
 * injectedSaving>0 measures POWER under the recorded noise. The top-up is
 * more with-replacement draws, placed by the real Neyman allocator when it
 * returns an allocation (uniform runsPerSide per task otherwise).
 */
export function bootstrapLook(
	rng: () => number,
	groups: ReplicateGroup[],
	runsPerSide: number,
	rent: number,
	injectedSaving: number,
): DeltaAssessment {
	const drawWith = (group: ReplicateGroup, n: number): number[] =>
		resample(rng, group.totals, n).map((t) => Math.max(0, t - injectedSaving));
	const without = groups.map((group) =>
		toSummary(group.taskId, resample(rng, group.totals, runsPerSide), "w"),
	);
	const withRule = groups.map((group) =>
		toSummary(group.taskId, drawWith(group, runsPerSide), "m"),
	);
	const topUp = (measured: TaskSummary[]): TaskSummary[] | null => {
		// Same budget as the real selector's top-up: one full duplicate pass of
		// the measured side, poured into the high-variance tasks by Neyman.
		const budget = measured.reduce((sum, s) => sum + s.results.length, 0);
		const allocation = allocateTopUpRuns(without, measured, budget);
		const extra: TaskSummary[] = [];
		for (const group of groups) {
			const n = allocation ? (allocation.get(group.taskId) ?? 0) : runsPerSide;
			if (n > 0) extra.push(toSummary(group.taskId, drawWith(group, n), "t"));
		}
		return extra.length > 0 ? extra : null;
	};
	return candidateLook(without, withRule, rent, topUp);
}

export function bootstrapTrial(
	rng: () => number,
	groups: ReplicateGroup[],
	runsPerSide: number,
	rent: number,
	injectedSaving: number,
): boolean {
	return promotedAt(
		bootstrapLook(rng, groups, runsPerSide, rent, injectedSaving),
		rent,
	);
}

/**
 * RECOVERY: what a second look at an underpowered eviction costs and buys.
 *
 * One trial is one rule's whole life under each policy, on the SAME draws:
 *
 *   control — the shipped pipeline before this feature: one look, and an
 *             eviction is final because the trigram dedupe will not let the
 *             body be proposed again.
 *   policy  — the same first look; if it was evicted AND the real
 *             `evictedUnderpowered` classes it recoverable, one independent
 *             second look at `recoveryRuns` per side, judged at
 *             `recoveryStrictness()` times the ordinary margin.
 *
 * The arms are paired by construction: the policy arm can only ADD keeps, so
 * the difference between them is the feature and never the RNG. At
 * `injectedSaving = 0` that difference IS the added false-positive rate; at
 * `injectedSaving > 0` it is the recovered power.
 *
 * Exactly one second look is ever taken, which is what the lineage cap in
 * `dedupeOutcome` enforces (a candidate carrying `recovers` can never itself
 * become a recovery root). Bootstrap draws throughout: a second look must be
 * INDEPENDENT of the first and DEEPER than it, and a permutation of a 4-run
 * pool can supply neither.
 */
export interface RecoveryTrialSpec {
	groups: ReplicateGroup[];
	runsPerSide: number;
	/** Runs per side of the second look. The policy refuses a re-measurement
	 * that is not deeper than the one it re-tries. */
	recoveryRuns: number;
	rent: number;
	injectedSaving: number;
}

export interface RecoveryTrialResult {
	/** Kept on the first look: both arms agree, the feature is not involved. */
	keptFirst: boolean;
	/** Evicted, and classed underpowered — the recovery zone. */
	inZone: boolean;
	/** Kept ONLY because of the second look: the policy's marginal effect. */
	keptOnRecovery: boolean;
}

export function recoveryTrial(
	rng: () => number,
	spec: RecoveryTrialSpec,
): RecoveryTrialResult {
	const { groups, runsPerSide, recoveryRuns, rent, injectedSaving } = spec;
	const first = bootstrapLook(rng, groups, runsPerSide, rent, injectedSaving);
	if (promotedAt(first, rent)) {
		return { keptFirst: true, inZone: false, keptOnRecovery: false };
	}
	// The shipped classifier, not a re-statement of it. `rent` stands in for the
	// rule's context cost throughout this harness, exactly as the other modes
	// use it.
	const inZone = evictedUnderpowered({
		status: "evicted",
		kind: "candidate",
		contextCost: rent,
		assessment: first,
	});
	if (!inZone) {
		return { keptFirst: false, inZone: false, keptOnRecovery: false };
	}
	const second = bootstrapLook(rng, groups, recoveryRuns, rent, injectedSaving);
	return {
		keptFirst: false,
		inZone: true,
		keptOnRecovery: promotedAt(second, rent, recoveryStrictness()),
	};
}

/**
 * 95% Wilson score interval for a Monte-Carlo keep rate (z=1.96). Covers the
 * resampling error of the trial count only — it says nothing about how well
 * the small recorded pool represents the agent's true noise distribution.
 */
export function wilson(k: number, n: number): { lo: number; hi: number } {
	if (n <= 0) return { lo: 0, hi: 1 };
	const z = 1.96;
	const p = k / n;
	const z2n = z ** 2 / n;
	const center = (p + z2n / 2) / (1 + z2n);
	const half =
		(z * Math.sqrt((p * (1 - p)) / n + z ** 2 / (4 * n ** 2))) / (1 + z2n);
	return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export type CalibrationMode =
	| "permutation"
	| "bootstrap"
	| "eviction"
	| "recovery"
	| "both";

export interface EmpiricalArgs {
	agent: string | null;
	dbPath: string | null;
	mode: CalibrationMode;
	trials: number;
	permRuns: number;
	bootRuns: number;
	rent: number;
	seed: number;
	/** Consecutive re-audits simulated per rule in eviction mode. */
	cycles: number;
	/** Retention cap for the eviction mode's policy arm; the control arm is
	 * always 0, so one invocation reports both. */
	retentionRounds: number;
	/** Runs per side of the SECOND look in recovery mode. Must exceed the first
	 * look's, which is what the shipped policy requires before it will spend a
	 * pass on a re-measurement. */
	recoveryRuns: number;
}

export function parseEmpiricalArgs(argv: string[]): EmpiricalArgs {
	const args: EmpiricalArgs = {
		agent: null,
		dbPath: null,
		mode: "both",
		trials: DEFAULT_TRIALS,
		permRuns: DEFAULT_PERM_RUNS,
		bootRuns: DEFAULT_BOOT_RUNS,
		rent: DEFAULT_RENT,
		seed: DEFAULT_SEED,
		cycles: DEFAULT_CYCLES,
		retentionRounds: MAX_RETENTION_ROUNDS,
		recoveryRuns: DEFAULT_RECOVERY_RUNS,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") {
			const agent = argv[++i] ?? "";
			assertKnownAgent(agent);
			args.agent = agent;
		} else if (flag === "--db") {
			const path = argv[++i];
			if (!path) throw new Error("--db requires a path");
			args.dbPath = path;
		} else if (flag === "--retention-rounds") {
			const n = numericFlag(argv[++i]);
			if (!Number.isInteger(n) || n < 0 || n > MAX_RETENTION_ROUNDS) {
				throw new Error(
					`--retention-rounds must be an integer in 0..${MAX_RETENTION_ROUNDS}`,
				);
			}
			args.retentionRounds = n;
		} else if (flag === "--recovery-runs") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--recovery-runs must be a positive integer");
			}
			args.recoveryRuns = n;
		} else if (flag === "--cycles") {
			const n = numericFlag(argv[++i]);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--cycles must be a positive integer");
			}
			args.cycles = n;
		} else if (flag === "--mode") {
			const mode = argv[++i] ?? "";
			if (
				mode !== "permutation" &&
				mode !== "bootstrap" &&
				mode !== "eviction" &&
				mode !== "recovery" &&
				mode !== "both"
			) {
				throw new Error(
					`--mode must be permutation, bootstrap, eviction, recovery, or both (got "${mode}")`,
				);
			}
			args.mode = mode;
		} else if (flag === "--trials") {
			const n = numericFlag(argv[++i]);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--trials must be a positive integer");
			}
			args.trials = n;
		} else if (flag === "--runs") {
			const n = numericFlag(argv[++i]);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--runs must be a positive integer");
			}
			args.permRuns = n;
			args.bootRuns = n;
		} else if (flag === "--rent") {
			const n = numericFlag(argv[++i]);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error("--rent must be a positive number");
			}
			args.rent = n;
		} else if (flag === "--seed") {
			const n = numericFlag(argv[++i]);
			if (!Number.isInteger(n)) throw new Error("--seed must be an integer");
			args.seed = n;
		} else {
			throw new Error(`unknown flag: ${flag}`);
		}
	}
	return args;
}

function pct(x: number): string {
	return `${(x * 100).toFixed(1)}%`;
}

/**
 * Mean of every replicate in the pool, pooled across tasks WITHOUT re-weighting
 * by task — a task with more recorded replicates counts for more.
 *
 * It is the denominator every injected effect is expressed against ("a rule
 * saving 5% of a run"), so all three modes must compute it the same way or a
 * "5%" row would mean a different number of tokens in each table. It was three
 * copies of the same two lines.
 */
function pooledMean(groups: readonly ReplicateGroup[]): number {
	const all = groups.flatMap((g) => g.totals);
	return all.reduce((a, b) => a + b, 0) / all.length;
}

function ci(k: number, n: number): string {
	const w = wilson(k, n);
	return `${pct(k / n)} [${pct(w.lo)}, ${pct(w.hi)}]`;
}

const INSUFFICIENT =
	"insufficient replicate history (need >= 2 tasks with >= 2x runs-per-side completed active-set runs at one ruleset version)";

/**
 * RECOVERY mode: the false-positive cost and the power benefit of allowing one
 * stricter, deeper second look at an underpowered eviction.
 *
 * The two arms are PAIRED on identical draws and the policy arm can only add
 * keeps, so the column that matters is the difference, not the two levels: at a
 * true saving of 0 it is the added false-positive rate, and every other row is
 * recovered power. Wilson intervals cover Monte-Carlo error only.
 */
function reportRecovery(
	groups: ReplicateGroup[],
	args: EmpiricalArgs,
	agentSeed: number,
): void {
	if (groups.length < 2) {
		console.log(`recovery: ${INSUFFICIENT}`);
		return;
	}
	if (args.recoveryRuns < args.bootRuns) {
		console.log(
			`recovery: --recovery-runs (${args.recoveryRuns}) must be at least --runs (${args.bootRuns}).`,
		);
		return;
	}
	if (args.recoveryRuns === args.bootRuns) {
		console.log(
			"WARNING: equal-depth second look — this is the CONTROL ARM the shipped policy refuses. " +
				"A recovery attempt is held until the run budget exceeds the depth its eviction was decided at, " +
				"so this row measures what the depth requirement is worth, not what ships.",
		);
	}
	const mean = pooledMean(groups);
	console.log(
		`recovery of underpowered evictions (first look ${args.bootRuns} runs/side, ` +
			`second look ${args.recoveryRuns}, ${groups.length} tasks, ${args.trials} trials/row):`,
	);
	console.log(
		`zone = point estimate reached >= ${recoveryMarginFraction()} of the gate's margin above the bar; ` +
			`second look judged at ${recoveryStrictness()}x that margin. Paired arms, same draws.`,
	);
	console.log(
		[
			"true saving".padStart(20),
			"control [95% CI]".padStart(24),
			"with recovery [95% CI]".padStart(24),
			"difference".padStart(12),
			"zone".padStart(8),
			"converted".padStart(11),
		].join("  "),
	);
	for (const frac of INJECTED_FRACS) {
		const injected = Math.round(mean * frac);
		const rng = mulberry32(agentSeed ^ (0xc0de + Math.round(frac * 1000)));
		let keptFirst = 0;
		let zone = 0;
		let recovered = 0;
		for (let i = 0; i < args.trials; i++) {
			const result = recoveryTrial(rng, {
				groups,
				runsPerSide: args.bootRuns,
				recoveryRuns: args.recoveryRuns,
				rent: args.rent,
				injectedSaving: injected,
			});
			if (result.keptFirst) keptFirst++;
			if (result.inZone) zone++;
			if (result.keptOnRecovery) recovered++;
		}
		const tag = frac === 0 ? "0 (A/A: FP)" : `${pct(frac)} (${injected} tok)`;
		console.log(
			[
				tag.padStart(20),
				ci(keptFirst, args.trials).padStart(24),
				ci(keptFirst + recovered, args.trials).padStart(24),
				`+${((100 * recovered) / args.trials).toFixed(2)}pt`.padStart(12),
				pct(zone / args.trials).padStart(8),
				`${recovered}/${zone}`.padStart(11),
			].join("  "),
		);
	}
	console.log(
		"\nRead: the 0-saving row is the false-positive cost of the feature and every other row is what it buys. " +
			"A second look can only ADD keeps, so a positive difference on the 0 row is real however small — the question is its SIZE " +
			"against the power rows, and against the ~8.8% base rate the gate already carries.",
	);
}

function reportAgent(
	agent: string,
	groups: ReplicateGroup[],
	args: EmpiricalArgs,
	agentSeed: number,
): void {
	console.log(`\n=== agent: ${agent} ===`);
	const permEligible = groups.filter(
		(g) => g.totals.length >= 2 * args.permRuns,
	);
	const bootEligible = groups.filter(
		(g) => g.totals.length >= 2 * args.bootRuns,
	);
	if (groups.length < 2) {
		console.log(INSUFFICIENT);
		return;
	}
	console.log(
		["task".padEnd(24), "runs".padStart(5), "mean tok".padStart(10)].join("  "),
	);
	for (const g of groups) {
		const m = g.totals.reduce((a, b) => a + b, 0) / g.totals.length;
		console.log(
			[
				g.taskId.padEnd(24),
				String(g.totals.length).padStart(5),
				String(Math.round(m)).padStart(10),
			].join("  "),
		);
	}

	if (args.mode === "permutation" || args.mode === "both") {
		if (permEligible.length < 2) {
			console.log(`permutation A/A: ${INSUFFICIENT}`);
		} else {
			const rng = mulberry32(agentSeed ^ 0x5eed);
			let kept = 0;
			for (let i = 0; i < args.trials; i++) {
				if (permutationTrial(rng, permEligible, args.permRuns, args.rent)) {
					kept++;
				}
			}
			console.log(
				`permutation A/A (runs=${args.permRuns}/side, ${permEligible.length} tasks, ${args.trials} trials): ` +
					`keep rate ${ci(kept, args.trials)} — empirical false-positive rate`,
			);
		}
	}

	if (args.mode === "recovery") {
		reportRecovery(bootEligible, args, agentSeed);
		return;
	}

	if (args.mode === "bootstrap" || args.mode === "both") {
		if (bootEligible.length < 2) {
			console.log(`bootstrap: ${INSUFFICIENT}`);
		} else {
			const mean = pooledMean(bootEligible);
			console.log(
				`bootstrap (runs=${args.bootRuns}/side, ${bootEligible.length} tasks, ${args.trials} trials/row, pooled mean ${Math.round(mean)} tok):`,
			);
			console.log(
				[
					"injected saving".padStart(20),
					"keep rate [95% CI]".padStart(26),
				].join("  "),
			);
			for (const frac of INJECTED_FRACS) {
				const injected = Math.round(mean * frac);
				const rng = mulberry32(agentSeed ^ (0xb00 + Math.round(frac * 1000)));
				let kept = 0;
				for (let i = 0; i < args.trials; i++) {
					if (
						bootstrapTrial(
							rng,
							bootEligible,
							args.bootRuns,
							args.rent,
							injected,
						)
					) {
						kept++;
					}
				}
				const tag =
					frac === 0 ? "0 (A/A: FP)" : `${pct(frac)} (${injected} tok)`;
				console.log(
					[tag.padStart(20), ci(kept, args.trials).padStart(26)].join("  "),
				);
			}
		}
	}

	if (args.mode === "eviction" || args.mode === "both") {
		if (bootEligible.length < 2) {
			console.log(`eviction: ${INSUFFICIENT}`);
			return;
		}
		const mean = pooledMean(bootEligible);
		console.log(
			`false eviction (runs=${args.bootRuns}/side, ${bootEligible.length} tasks, ` +
				`${args.cycles} consecutive re-audits, ${args.trials} trials/row):`,
		);
		console.log(
			`retention budget: control (0 extra rounds, pre-v0.43.0) vs <=${args.retentionRounds} ` +
				"extra rounds. Same bar, same two-strike policy — only the evidence differs.",
		);
		console.log(
			[
				"true saving".padStart(20),
				"evicted@0 [95% CI]".padStart(26),
				`evicted@${args.retentionRounds} [95% CI]`.padStart(26),
				"median cycle".padStart(14),
				"top-ups/audit 0->N".padStart(19),
			].join("  "),
		);
		/** One arm of the comparison, at a fixed retention cap. */
		const evictionArm = (
			trueSaving: number,
			maxRetentionRounds: number,
		): { evicted: number; median: string; roundsPerAudit: number } => {
			// Same STARTING seed per arm. The two arms are NOT paired beyond that,
			// and an earlier version of this comment claimed they were: one `rng`
			// is threaded through all `trials` trials, and the policy arm draws
			// more from it, because every retention round calls `resample`. The
			// streams therefore diverge at the first trial where the arms spend
			// different rounds, and every later trial sees a different sequence.
			//
			// Executed: on the pool pinned in test/empirical-calibration.test.ts
			// the control arm consumes 1,172 rounds and the policy arm 1,801 from
			// identically seeded streams, which is only possible if the draws
			// differ. So the arm difference carries Monte-Carlo noise rather than
			// being variance-reduced by pairing. At 3,000 trials that is small
			// beside the effect sizes reported, but it is not the control the old
			// comment promised. Reseeding per trial (`mulberry32(seed ^ i)`) would
			// make it a genuinely paired comparison; that is a change to the
			// sampling and is deliberately not bundled with the banked-delta
			// correction, since the table needs re-running against the real pool
			// either way.
			const rng = mulberry32(agentSeed ^ (0xe00 + Math.round(trueSaving)));
			let evicted = 0;
			let rounds = 0;
			let audits = 0;
			const cyclesAt: number[] = [];
			for (let i = 0; i < args.trials; i++) {
				const result = falseEvictionTrial(rng, {
					groups: bootEligible,
					runsPerSide: args.bootRuns,
					rent: args.rent,
					trueSaving,
					cycles: args.cycles,
					maxRetentionRounds,
				});
				rounds += result.topUpRounds;
				audits += result.reAudits;
				if (result.evictedAt !== null) {
					evicted++;
					cyclesAt.push(result.evictedAt);
				}
			}
			return {
				evicted,
				median:
					cyclesAt.length === 0
						? "-"
						: String(
								cyclesAt.sort((a, b) => a - b)[
									Math.floor(cyclesAt.length / 2)
								] ?? "-",
							),
				roundsPerAudit: audits === 0 ? 0 : rounds / audits,
			};
		};
		for (const frac of INJECTED_FRACS) {
			// A true saving of 0 is not a false eviction — the rule genuinely is
			// not earning, and evicting it is the gate working. Skip that row.
			if (frac === 0) continue;
			const trueSaving = Math.round(mean * frac);
			const control = evictionArm(trueSaving, 0);
			const policy = evictionArm(trueSaving, args.retentionRounds);
			console.log(
				[
					`${pct(frac)} (${trueSaving} tok)`.padStart(20),
					ci(control.evicted, args.trials).padStart(26),
					ci(policy.evicted, args.trials).padStart(26),
					policy.median.padStart(14),
					`${control.roundsPerAudit.toFixed(2)}->${policy.roundsPerAudit.toFixed(2)}`.padStart(
						19,
					),
				].join("  "),
			);
		}
	}
}

export function main(argv: string[]): number {
	const args = parseEmpiricalArgs(argv);
	const agents = args.agent ? [args.agent] : knownAgents();
	const db = args.dbPath ? openDb(args.dbPath) : openDb();
	try {
		const bar = Math.ceil(keepBar(args.rent));
		console.log(
			"=== token-warden empirical calibration (recorded runs, zero tokens) ===",
		);
		console.log(
			`rent ${args.rent} (2x cache-aware bar ~${bar} tok) · confidence z=${confidenceZ()} · seed ${args.seed} · mode ${args.mode}`,
		);
		// The eligibility floor is the loosest active mode's requirement; each
		// mode re-filters to its own 2×runs floor before simulating.
		const minRuns =
			2 *
			(args.mode === "permutation"
				? args.permRuns
				: args.mode === "bootstrap"
					? args.bootRuns
					: Math.min(args.permRuns, args.bootRuns));
		agents.forEach((agent, idx) => {
			const groups = groupReplicates(goldenReplicateRuns(db, agent), minRuns);
			reportAgent(agent, groups, args, args.seed + idx * 7919);
		});
		console.log(
			"\nRead: the 0-saving rows (permutation A/A and bootstrap injected=0) are the empirical false-positive rate of candidate promotion under the agent's REAL recorded run-to-run noise — no Gaussian assumption. Compare against the synthetic harness's ~2-3% claim at z=2 (validation/calibration.ts): agreement means the noise model there is adequate; a higher empirical rate means real noise is nastier than modeled. The injected-saving rows are power: how big a true saving must be before the pipeline reliably keeps it on this data.",
		);
		return 0;
	} finally {
		db.close();
	}
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
