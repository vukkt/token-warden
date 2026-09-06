/**
 * The cross-pool sweep's three pure decisions.
 *
 * `validation/cross-pool-gate.ts` re-runs the published z-sweep on a SECOND
 * replicate pool, and the published claim it tests is not a single number: it
 * is "net tokens fall monotonically as z rises" plus "the break-even harm is
 * small against one tool call". Both readings are computed here rather than
 * eyeballed off a table, so both are pinned.
 *
 * `breakEvenPerSeed` matters most. The break-even is a ratio whose denominator
 * differences two arms' worthless-rule counts, and on a thin pool those counts
 * can coincide — at which point a seed-averaged break-even would report a
 * confident number for a crossing that does not exist on any seed. The
 * unresolved count is what keeps that visible, and it is the finding on the
 * live ledger's z=1.5-vs-2.0 cell.
 */
import { describe, expect, it } from "vitest";
import {
	argmaxZ,
	breakEvenPerSeed,
	loosensMonotonically,
	thinGroups,
} from "../validation/cross-pool-gate.js";
import type { HarmLine } from "../validation/stream-calibration.js";

/** A sweep cell reduced to the two fields these functions read. */
const cell = (z: number, netTokensPerRun: number, lines: HarmLine[] = []) => ({
	z,
	netTokensPerRun,
	lines,
	falseDiscoveryProportion: 0,
	discoveries: 0,
	trueDiscoveries: 0,
	missedReal: 0,
	netBeforeHarm: 0,
	falseDiscoveries: 0,
	netSpread: 0,
});

describe("loosensMonotonically", () => {
	it("is true when net tokens fall at every tightening step", () => {
		// The shape both pools produced at overlap 0.85.
		expect(
			loosensMonotonically([
				cell(0, 20_825),
				cell(0.5, 18_703),
				cell(1, 15_388),
				cell(1.5, 11_456),
				cell(2, 8_603),
			]),
		).toBe(true);
	});

	it("is false as soon as one tightening step pays", () => {
		expect(
			loosensMonotonically([
				cell(0, 20_825),
				cell(0.5, 18_703),
				cell(1, 19_000),
			]),
		).toBe(false);
	});

	it("is vacuously true for a single-point grid", () => {
		expect(loosensMonotonically([cell(1.5, 11_456)])).toBe(true);
	});
});

describe("argmaxZ", () => {
	it("picks the z with the most net tokens", () => {
		expect(argmaxZ([cell(0, 20_825), cell(1.5, 11_456), cell(2, 8_603)])).toBe(
			0,
		);
	});

	it("keeps the looser z when two cells tie exactly", () => {
		// The grid arrives ascending and the update is strict, so the first
		// maximum wins. A tie means the extra strictness bought nothing, so
		// reporting the looser end is the honest reading, not an accident.
		expect(argmaxZ([cell(1, 100), cell(1.5, 100)])).toBe(1);
	});

	it("returns null for an empty grid", () => {
		expect(argmaxZ([])).toBeNull();
	});
});

describe("thinGroups", () => {
	const groups = [
		{ taskId: "sql-01", totals: [1, 2, 3, 4, 5, 6] },
		{ taskId: "sql-02", totals: [1, 2, 3, 4, 5, 6] },
		{ taskId: "sql-03", totals: [1, 2, 3, 4, 5, 6] },
		{ taskId: "sql-04", totals: [1, 2, 3, 4, 5, 6] },
	];

	it("caps both the task count and the replicate depth", () => {
		const thinned = thinGroups(groups, 3, 4);
		expect(thinned.map((g) => g.taskId)).toEqual([
			"sql-01",
			"sql-02",
			"sql-03",
		]);
		expect(thinned.every((g) => g.totals.length === 4)).toBe(true);
	});

	it("treats a non-positive cap as no cap on that axis", () => {
		expect(thinGroups(groups, 0, 2).length).toBe(4);
		expect(thinGroups(groups, 2, 0)[0]?.totals.length).toBe(6);
		expect(thinGroups(groups, 0, 0)).toEqual(groups);
	});

	it("does not mutate the pool it thins", () => {
		thinGroups(groups, 2, 2);
		expect(groups[0]?.totals.length).toBe(6);
		expect(groups.length).toBe(4);
	});

	it("is deterministic — no seed enters the thinning", () => {
		expect(thinGroups(groups, 3, 4)).toEqual(thinGroups(groups, 3, 4));
	});
});

describe("breakEvenPerSeed", () => {
	const shipped: HarmLine[] = [
		{ netBeforeHarm: 11_456, falseDiscoveries: 2.6 },
		{ netBeforeHarm: 11_200, falseDiscoveries: 2.5 },
	];

	it("solves each seed family separately and sorts ascending", () => {
		const looser: HarmLine[] = [
			{ netBeforeHarm: 20_825, falseDiscoveries: 15.8 },
			{ netBeforeHarm: 20_000, falseDiscoveries: 16.5 },
		];
		const { solved, unresolved } = breakEvenPerSeed(shipped, looser);
		expect(unresolved).toBe(0);
		expect(solved).toHaveLength(2);
		expect(solved[0] as number).toBeLessThanOrEqual(solved[1] as number);
		// The shipped arm is the tighter one, so the crossing is where its extra
		// net-before-harm is paid for by the looser arm's extra junk.
		expect(solved).toContainEqual((11_456 - 20_825) / (2.6 - 15.8));
	});

	/**
	 * The live-ledger cell. Tightening from z=1.5 to z=2.0 on that pool removes
	 * real discoveries without removing worthless ones, so the two lines are
	 * parallel and no harm separates them. Counting those families instead of
	 * dropping them is what stops the report claiming a crossing.
	 */
	it("counts families where the arms keep the same worthless count", () => {
		const parallel: HarmLine[] = [
			{ netBeforeHarm: 8_603, falseDiscoveries: 2.6 },
			{ netBeforeHarm: 8_400, falseDiscoveries: 2.5 },
		];
		expect(breakEvenPerSeed(shipped, parallel)).toEqual({
			solved: [],
			unresolved: 2,
		});
	});

	it("counts a negative crossing as unresolved, not as a harm", () => {
		// A crossing below zero would mean a worthless rule PAYS beyond its rent.
		const impossible: HarmLine[] = [
			{ netBeforeHarm: 5_000, falseDiscoveries: 15.8 },
			{ netBeforeHarm: 5_000, falseDiscoveries: 16.5 },
		];
		expect(breakEvenPerSeed(shipped, impossible).solved).toHaveLength(0);
		expect(breakEvenPerSeed(shipped, impossible).unresolved).toBe(2);
	});

	it("stops at the shorter of the two seed lists", () => {
		expect(
			breakEvenPerSeed(shipped, [
				{ netBeforeHarm: 20_825, falseDiscoveries: 15.8 },
			]).solved,
		).toHaveLength(1);
	});
});
