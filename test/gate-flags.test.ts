/**
 * The gate's remaining opt-in seams.
 *
 * v1.0.0 removed the moderation and online-FDR flags along with the modules
 * behind them, so what is left is the context budget and the explicit
 * confidence multiple the calibration harness sweeps. Both are exercised here
 * because a seam nothing runs is a seam nothing checks.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TaskSummary } from "../src/bench.js";
import { summarizeTask } from "../src/bench.js";
import { assessDelta } from "../src/select.js";
import {
	confidenceZ,
	memoryContextBudget,
	recoveryMarginFraction,
	recoveryStrictness,
	sessionsPerWeek,
} from "../src/stats.js";

function task(id: string, tokens: number[]): TaskSummary {
	return summarizeTask(
		id,
		tokens.map((t, i) => ({
			sessionId: `${id}-${i}`,
			tokens: t,
			completed: true,
		})),
	);
}

describe("assessDelta with an explicit confidence multiple", () => {
	const without = [task("t1", [10_000, 10_400]), task("t2", [9_000, 9_600])];
	const withRule = [task("t1", [8_000, 8_400]), task("t2", [7_200, 7_600])];

	it("reports the multiple it was given", () => {
		expect(assessDelta(without, withRule, 25, 1.5).confidenceMultiple).toBe(
			1.5,
		);
	});

	it("falls back to confidenceZ() when none is given", () => {
		// 1.5 since v1.0.0, down from 2 -- see stats.ts#confidenceZ for the
		// measured FP/power table behind that reversal.
		expect(assessDelta(without, withRule, 25).confidenceMultiple).toBe(1.5);
	});

	/**
	 * A wider band can only ever make a verdict less certain, never more. Stated
	 * as MONOTONICITY rather than as two hand-picked points: an earlier draft
	 * asserted `uncertain` at z=8 and failed, because this delta clears the bar
	 * by 1,896 tokens against an SE near 229 and so stays certain until z>8.3.
	 * The property was right; the constant was a guess.
	 */
	it("never narrows the uncertain band as the multiple grows", () => {
		let previous = false;
		for (const z of [0.5, 1, 2, 4, 8, 16, 32]) {
			const { uncertain } = assessDelta(without, withRule, 25, z);
			if (previous) expect(uncertain).toBe(true);
			previous = uncertain;
		}
		// And it does eventually flip, so the sweep is not vacuously monotone.
		expect(previous).toBe(true);
		expect(assessDelta(without, withRule, 25, 0.5).uncertain).toBe(false);
	});
});

describe("WARDEN_CONTEXT_BUDGET", () => {
	afterEach(() => {
		delete process.env.WARDEN_CONTEXT_BUDGET;
	});

	it("is null unless set to a positive number", () => {
		expect(memoryContextBudget()).toBeNull();
		// Zero is REJECTED rather than clamped: a budget of 0 would compile an
		// empty MEMORY.md, silently discarding every rule the operator paid to
		// measure. Blank must mean ABSENT rather than zero -- Number("") is 0,
		// the trap recoveryMarginFraction documents.
		for (const bad of ["0", "-100", "abc", "", "   "]) {
			process.env.WARDEN_CONTEXT_BUDGET = bad;
			expect(memoryContextBudget()).toBeNull();
		}
	});

	it("reads a positive budget", () => {
		process.env.WARDEN_CONTEXT_BUDGET = "500";
		expect(memoryContextBudget()).toBe(500);
	});
});

/**
 * BLANK ENVIRONMENT OVERRIDES ARE ABSENT, NOT ZERO.
 *
 * `Number("")` and `Number(" ")` are both 0, so `export WARDEN_X=` reads as a
 * deliberate zero under the natural `Number(process.env.X ?? fallback)` idiom.
 * This project shipped exactly that hole in `pricing.ts`, where a blank
 * override priced a whole workload at zero (v0.40.0).
 *
 * Two of these five readers used that idiom and were safe only because 0 falls
 * outside their legal range -- `recoveryMarginFraction`'s own comment admitted
 * `confidenceZ` was "accidentally safe". They now share one reader that treats
 * blank as absent by construction, and this sweeps every one of them so the
 * coincidence cannot come back as a range widens.
 *
 * `WARDEN_SESSIONS_PER_WEEK` had no test of any kind before this.
 */
describe("numeric environment overrides", () => {
	const BLANKS = ["", " ", "\t", "\n"];
	const readers = [
		["WARDEN_SESSIONS_PER_WEEK", sessionsPerWeek, 20],
		["WARDEN_CONFIDENCE_Z", confidenceZ, 1.5],
		["WARDEN_RECOVERY_MARGIN", recoveryMarginFraction, 0.5],
		["WARDEN_RECOVERY_STRICTNESS", recoveryStrictness, 1.5],
	] as const;

	afterEach(() => {
		for (const [name] of readers) delete process.env[name];
		delete process.env.WARDEN_CONTEXT_BUDGET;
	});

	it.each(
		readers,
	)("%s falls back to its calibrated default when blank", (name, read, fallback) => {
		for (const blank of BLANKS) {
			process.env[name] = blank;
			expect(read(), `${name}=${JSON.stringify(blank)}`).toBe(fallback);
		}
	});

	it.each(
		readers,
	)("%s falls back when unparseable or out of range", (name, read, fallback) => {
		for (const bad of ["abc", "NaN", "-999", "Infinity"]) {
			process.env[name] = bad;
			expect(read(), `${name}=${bad}`).toBe(fallback);
		}
	});

	it.each(readers)("%s reads a legitimate override", (name, read) => {
		// Inside every reader's range: >0, >=1, [0,1), >=1 respectively.
		process.env[name] = "0.75";
		const value = read();
		expect(Number.isFinite(value)).toBe(true);
	});

	it("WARDEN_CONTEXT_BUDGET is null when blank, not zero", () => {
		// The one reader with no fallback. Zero here would compile an EMPTY
		// MEMORY.md, discarding every rule the operator paid to measure.
		for (const blank of BLANKS) {
			process.env.WARDEN_CONTEXT_BUDGET = blank;
			expect(memoryContextBudget()).toBeNull();
		}
	});
});
