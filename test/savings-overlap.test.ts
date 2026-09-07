/**
 * THE MEASURED-OVERLAP QUESTION, AND WHY THE PROXY STAYED.
 *
 * `knapsack.ts` and `memory.ts#packToBudget` both state the packer's honest
 * limit: its redundancy signal is trigram overlap between rule bodies, a
 * TEXTUAL proxy for the savings overlap the facility-location objective
 * actually weighs. The stated reason it is still a proxy used to be "measuring
 * real pairwise savings overlap is a token burn nobody has run".
 *
 * `validation/savings-overlap.ts` tested that, zero-token, against the recorded
 * pool, and the answer was no on three counts. This file pins all three, plus
 * the properties any replacement similarity would have to meet, so the negative
 * result cannot quietly rot into a different one:
 *
 *   1. ATTRIBUTION. `runs` carries no rule id. A pass is tied to its rule only
 *      by falling between two `decided_at` stamps, and half the live ledger's
 *      decided rules cannot be recovered even that way.
 *   2. DISAGREEMENT. Where a pair IS recoverable, measured overlap and textual
 *      overlap disagree hugely -- which is the case the feature exists for, and
 *      is the reason the third point matters rather than being a footnote.
 *   3. THE NULL. That disagreement is not signal. Two rules measured against
 *      the SAME baseline pass share its error term, giving their saving vectors
 *      a correlation of 1/2 under a null where neither rule does anything -- at
 *      every run depth, because more runs shrink the shared and private terms
 *      alike.
 *
 * The numbers below are the live ledger's, transcribed rather than read from a
 * DB so the pin survives without one: agent `sql`, ruleset version 1,
 * 2026-06-11, totals as `bench.ts#totalTokens` counts them.
 */
import { describe, expect, it } from "vitest";
import { packRules, type Similarity } from "../src/knapsack.js";
import { trigramSimilarity } from "../src/rules.js";
import { mulberry32 } from "../validation/rng.js";
import {
	attributePasses,
	drawNullSavingVectors,
	fractionAtLeast,
	type LedgerRule,
	type LedgerRun,
	nullCosineAtDepth,
	nullCosineDistribution,
	quantile,
	SHARED_BASELINE_NULL_CORRELATION,
	savingCosine,
	type TaskNoise,
	type TaskPool,
	toBlocks,
	toSimilarity,
} from "../validation/savings-overlap.js";

// --- the recorded pool, transcribed ----------------------------------------

/** Rule 3's body and rule 4's body, verbatim from the live ledger. They read
 * as different rules -- and trigram overlap agrees, which is the whole point. */
const RULE_3_BODY =
	"Consolidate file discovery into single queries instead of multiple find/ls operations across related paths.";
const RULE_4_BODY =
	"Parse task descriptions for technical direction; verify schema/dependencies only if code doesn't clarify them.";

/** The shared active-set baseline pass, and the two candidate passes measured
 * against it. Three tasks, 2-3 completed runs a side. */
const BASELINE: Record<string, number[]> = {
	"sql-01": [39998, 39604, 39539],
	"sql-02": [60859, 80664],
	"sql-03": [49821, 50786],
};
const WITH_RULE_3: Record<string, number[]> = {
	"sql-01": [39318, 39763],
	"sql-02": [60271, 73956],
	"sql-03": [53393, 50839],
};
const WITH_RULE_4: Record<string, number[]> = {
	"sql-01": [39292, 40035],
	"sql-02": [59569, 48919],
	"sql-03": [49146, 49930],
};

const TASKS = ["sql-01", "sql-02", "sql-03"];

function runsFrom(
	totals: Record<string, number[]>,
	config: string,
	startMs: number,
): LedgerRun[] {
	const out: LedgerRun[] = [];
	let at = startMs;
	for (const taskId of TASKS) {
		for (const tokens of totals[taskId] ?? []) {
			out.push({
				taskId,
				config,
				rulesetVersion: 1,
				completed: true,
				ts: new Date(at).toISOString(),
				tokens,
			});
			at += 30_000;
		}
	}
	return out;
}

const BASE_MS = Date.parse("2026-06-11T22:30:00.000Z");
const baselineRuns = runsFrom(BASELINE, "active", BASE_MS);
const rule3Runs = runsFrom(WITH_RULE_3, "candidate", BASE_MS + 600_000);
const rule4Runs = runsFrom(WITH_RULE_4, "candidate", BASE_MS + 1_200_000);
const lastTs = (runs: LedgerRun[]): string => runs[runs.length - 1]?.ts ?? "";

const RULE_3: LedgerRule = {
	id: 3,
	body: RULE_3_BODY,
	status: "active",
	measuredDelta: 622,
	decidedAt: lastTs(rule3Runs),
};
const RULE_4: LedgerRule = {
	id: 4,
	body: RULE_4_BODY,
	status: "active",
	measuredDelta: 5731,
	decidedAt: lastTs(rule4Runs),
};
const allRuns = [...baselineRuns, ...rule3Runs, ...rule4Runs];
const decisions = [RULE_3.decidedAt, RULE_4.decidedAt].flatMap((d) =>
	d === null ? [] : [d],
);

const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
const vectorFor = (withRule: Record<string, number[]>): Map<string, number> =>
	new Map(
		TASKS.map((t) => [t, mean(BASELINE[t] ?? []) - mean(withRule[t] ?? [])]),
	);

// --- 1. attribution ---------------------------------------------------------

describe("attribution -- a recorded run does not say which rule it measured", () => {
	it("splits two back-to-back candidate passes only at the decision stamps", () => {
		// Nothing on the ROWS distinguishes rule 3's pass from rule 4's: same
		// agent, same config, same ruleset version, same tasks. Without the
		// decided_at cuts they are one block and neither rule has a vector.
		expect(toBlocks(allRuns).map((b) => b.runs.length)).toEqual([7, 12]);
		expect(toBlocks(allRuns, decisions).map((b) => b.runs.length)).toEqual([
			7, 6, 6,
		]);
	});

	it("accepts a pass only when it reproduces the verdict the selector banked", () => {
		const blocks = toBlocks(allRuns, decisions);
		const passes = attributePasses([RULE_3, RULE_4], blocks);
		expect(passes.map((p) => p.separable)).toEqual([true, true]);
		// Re-derived from the runs alone, within rounding of the banked number.
		expect(Math.round(passes[0]?.derivedDelta ?? 0)).toBe(670);
		expect(Math.round(passes[1]?.derivedDelta ?? 0)).toBe(5778);
	});

	it("rejects a pass whose re-derived saving is not the banked one", () => {
		// The live ledger's rules 2, 5 and 6 fail exactly here. The recovered runs
		// are not the ones the verdict was taken on -- for rules 5 and 6 because
		// the swap A/B recorded BOTH sides as config='candidate' inside one block,
		// so no cut separates them. A vector built from those runs would be a
		// confident-looking number about the wrong measurement, which is worse
		// than no number.
		const wrongDelta: LedgerRule = { ...RULE_4, measuredDelta: -71998 };
		const passes = attributePasses([wrongDelta], toBlocks(allRuns, decisions));
		expect(passes[0]?.separable).toBe(false);
		expect(passes[0]?.reason).toContain("does not reproduce");
	});

	it("rejects a rule whose pass is buried inside a longer shared block", () => {
		// No cuts supplied: rule 3's pass ends mid-block, so nothing ends at its
		// decided_at and there is no pass to attribute.
		const passes = attributePasses([RULE_3], toBlocks(allRuns));
		expect(passes[0]?.separable).toBe(false);
		expect(passes[0]?.reason).toContain("no candidate/audit block");
	});
});

// --- 2. the disagreement ----------------------------------------------------

describe("measured overlap and textual overlap disagree on the real pair", () => {
	const v3 = vectorFor(WITH_RULE_3);
	const v4 = vectorFor(WITH_RULE_4);

	it("is the case the whole feature exists for", () => {
		const cosine = savingCosine(v3, v4);
		expect(cosine).not.toBeNull();
		// Measured: near-total redundancy. Textual: all but independent.
		expect(toSimilarity(cosine ?? 0)).toBeCloseTo(0.937, 2);
		expect(trigramSimilarity(RULE_3_BODY, RULE_4_BODY)).toBeCloseTo(0.074, 2);
	});

	it("would change which rule the packer carries", () => {
		// The two real rules plus a third, cheap, unrelated one, and a budget with
		// room for exactly two. Under trigram overlap rule 3 is independent of
		// rule 4 and its full 622 is still on the table, so greedy takes it; under
		// the measured overlap rule 4 already covers 94% of rule 3's mode, its
		// marginal gain collapses to ~39 tokens, and the third rule wins the slot
		// instead. Pinned because this swap is the reason a measured signal would
		// be worth having -- if it were signal.
		const pool = [
			{ id: "3", contextCost: 27, saving: 622 },
			{ id: "4", contextCost: 28, saving: 5731 },
			{ id: "other", contextCost: 27, saving: 200 },
		];
		const overlap = toSimilarity(savingCosine(v3, v4) ?? 0);
		const pair = new Set(["3", "4"]);
		const measured: Similarity = (i, m) =>
			i.id === m.id ? 1 : pair.has(i.id) && pair.has(m.id) ? overlap : 0;
		const textualOverlap = trigramSimilarity(RULE_3_BODY, RULE_4_BODY);
		const textual: Similarity = (i, m) =>
			i.id === m.id ? 1 : pair.has(i.id) && pair.has(m.id) ? textualOverlap : 0;
		expect(packRules(pool, 56, textual).chosen).toEqual(["4", "3"]);
		expect(packRules(pool, 56, measured).chosen).toEqual(["4", "other"]);
	});

	it("keeps the preconditions knapsack.ts requires", () => {
		// [0, 1], symmetric, 1 on the diagonal -- the non-negativity precondition
		// and the facility-location objective both depend on all three.
		for (const c of [-1, -0.5, 0, 0.5, 1]) {
			expect(toSimilarity(c)).toBeGreaterThanOrEqual(0);
			expect(toSimilarity(c)).toBeLessThanOrEqual(1);
		}
		expect(toSimilarity(1)).toBe(1);
		expect(savingCosine(v3, v3)).toBeCloseTo(1, 10);
		expect(savingCosine(v3, v4)).toBeCloseTo(savingCosine(v4, v3) ?? 0, 10);
	});

	it("has no direction to compare when a vector is all zero or shares no task", () => {
		expect(savingCosine(v3, new Map([["sql-09", 5]]))).toBeNull();
		expect(savingCosine(v3, new Map(TASKS.map((t) => [t, 0])))).toBeNull();
	});
});

// --- 3. the null ------------------------------------------------------------

const pools: TaskPool[] = TASKS.map((taskId) => ({
	taskId,
	without: BASELINE[taskId] ?? [],
	withA: WITH_RULE_3[taskId] ?? [],
	withB: WITH_RULE_4[taskId] ?? [],
}));

describe("the shared baseline makes the measured overlap uninformative", () => {
	it("puts the observed cosine well inside a no-effect permutation null", () => {
		const nulls = nullCosineDistribution(pools, 20_000, mulberry32(20260906));
		const observed = savingCosine(
			vectorFor(WITH_RULE_3),
			vectorFor(WITH_RULE_4),
		);
		expect(observed).not.toBeNull();
		// Under a null where NEITHER rule does anything, the median cosine is
		// already high and the observed value is unremarkable within it.
		expect(quantile(nulls, 0.5)).toBeGreaterThan(0.8);
		expect(fractionAtLeast(nulls, observed ?? 0)).toBeGreaterThan(0.2);
		// And a pure-noise pair reads as half-redundant most of the time.
		expect(fractionAtLeast(nulls, 0.5)).toBeGreaterThan(0.5);
	});

	it("gives two do-nothing rules a correlation of 1/2 whatever the depth", () => {
		// The structural result. s_r,t = true_r,t + (e_W,t - e_r,t), and e_W,t is
		// the SAME draw in both rules' vectors: cov = Var(e_W), Var = 2*Var(e_W),
		// so rho = 1/2 exactly. Both terms shrink as 1/n, so the ratio is a
		// constant -- more runs never separate a redundant pair from an
		// independent one.
		const noise: TaskNoise[] = [{ taskId: "t", mean: 50_000, sd: 8_000 }];
		for (const runsPerSide of [2, 16, 128]) {
			const rng = mulberry32(4242 + runsPerSide);
			const xs: number[] = [];
			const ys: number[] = [];
			for (let d = 0; d < 20_000; d++) {
				const { a, b } = drawNullSavingVectors(noise, runsPerSide, rng);
				xs.push(a.get("t") ?? 0);
				ys.push(b.get("t") ?? 0);
			}
			const mx = mean(xs);
			const my = mean(ys);
			let cov = 0;
			let vx = 0;
			let vy = 0;
			for (let i = 0; i < xs.length; i++) {
				const dx = (xs[i] ?? 0) - mx;
				const dy = (ys[i] ?? 0) - my;
				cov += dx * dy;
				vx += dx * dx;
				vy += dy * dy;
			}
			expect(cov / Math.sqrt(vx * vy)).toBeCloseTo(
				SHARED_BASELINE_NULL_CORRELATION,
				1,
			);
		}
	});

	it("does not concentrate the null cosine as runs are added", () => {
		// The depth sweep the harness prints. A signal that a bigger burn would
		// rescue would show this fraction falling toward chance; it does not
		// move, which is why the answer is not "spend more".
		const noise: TaskNoise[] = TASKS.map((taskId) => ({
			taskId,
			mean: mean(BASELINE[taskId] ?? []),
			sd: 8_000,
		}));
		const shallow = nullCosineAtDepth(noise, 2, 5_000, mulberry32(11));
		const deep = nullCosineAtDepth(noise, 128, 5_000, mulberry32(12));
		expect(fractionAtLeast(deep, 0.5)).toBeCloseTo(
			fractionAtLeast(shallow, 0.5),
			1,
		);
	});
});
