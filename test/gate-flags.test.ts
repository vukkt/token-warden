/**
 * The gate's opt-in paths.
 *
 * `WARDEN_MODERATE_VARIANCE` and `WARDEN_ONLINE_FDR` are both default-off,
 * pending calibration that (so far) rejected both. That is exactly why they
 * need tests: code nothing runs is code nothing checks, and a flag flipped
 * during a future calibration should exercise something already known to work
 * rather than something being run for the first time.
 *
 * These also pin the DEFAULT-OFF contract itself, which is the part a careless
 * edit would break silently.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TaskSummary } from "../src/bench.js";
import { summarizeTask } from "../src/bench.js";
import { assessDelta } from "../src/select.js";
import {
	moderateVarianceEnabled,
	onlineFdrAlpha,
	onlineFdrEnabled,
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

afterEach(() => {
	delete process.env.WARDEN_MODERATE_VARIANCE;
	delete process.env.WARDEN_ONLINE_FDR;
	delete process.env.WARDEN_FDR_ALPHA;
});

describe("gate feature flags", () => {
	it("are off unless set to exactly 1", () => {
		expect(moderateVarianceEnabled()).toBe(false);
		expect(onlineFdrEnabled()).toBe(false);
		for (const value of ["0", "true", "yes", "", "2"]) {
			process.env.WARDEN_MODERATE_VARIANCE = value;
			process.env.WARDEN_ONLINE_FDR = value;
			expect(moderateVarianceEnabled()).toBe(false);
			expect(onlineFdrEnabled()).toBe(false);
		}
	});

	it("turn on for 1", () => {
		process.env.WARDEN_MODERATE_VARIANCE = "1";
		process.env.WARDEN_ONLINE_FDR = "1";
		expect(moderateVarianceEnabled()).toBe(true);
		expect(onlineFdrEnabled()).toBe(true);
	});
});

describe("onlineFdrAlpha", () => {
	it("defaults to 0.10, the value that puts a fresh stream on z=2", () => {
		expect(onlineFdrAlpha()).toBe(0.1);
	});

	it("accepts a value inside (0, 1)", () => {
		process.env.WARDEN_FDR_ALPHA = "0.05";
		expect(onlineFdrAlpha()).toBe(0.05);
	});

	it("rejects rather than clamps anything outside (0, 1)", () => {
		// The same discipline as confidenceZ and recoveryMarginFraction: a typo
		// yields the calibrated default, never a policy nobody measured. Note
		// "0" and "1" are both REJECTED -- an alpha of 0 admits nothing and an
		// alpha of 1 admits everything, and neither is a rate.
		for (const bad of ["0", "1", "-0.5", "1.5", "abc", "", "   "]) {
			process.env.WARDEN_FDR_ALPHA = bad;
			expect(onlineFdrAlpha()).toBe(0.1);
		}
	});
});

describe("assessDelta with an explicit confidence multiple", () => {
	const without = [task("t1", [10_000, 10_400]), task("t2", [9_000, 9_600])];
	const withRule = [task("t1", [8_000, 8_400]), task("t2", [7_200, 7_600])];

	it("reports the multiple it was given", () => {
		expect(assessDelta(without, withRule, 25, 1.5).confidenceMultiple).toBe(
			1.5,
		);
	});

	it("falls back to confidenceZ() when none is given", () => {
		expect(assessDelta(without, withRule, 25).confidenceMultiple).toBe(2);
	});

	/**
	 * A wider band can only ever make a verdict less certain, never more. This
	 * is the property the online-FDR wiring depends on when it hands LORD's
	 * per-arrival multiple to the same machinery, and it is stated as
	 * MONOTONICITY rather than as two hand-picked points: an earlier draft
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

describe("assessDelta with variance moderation enabled", () => {
	// Deliberately heterogeneous per-task noise: a quiet task and a loud one is
	// the case moderation exists to reconcile, and the case where leaving it
	// unexercised would hide an indexing error between the two sides.
	const without = [
		task("quiet", [10_000, 10_010, 10_020]),
		task("loud", [9_000, 14_000, 6_000]),
	];
	const withRule = [
		task("quiet", [8_000, 8_010, 8_030]),
		task("loud", [7_000, 12_000, 4_000]),
	];

	it("produces a finite standard error on the same delta", () => {
		const plain = assessDelta(without, withRule, 25);
		process.env.WARDEN_MODERATE_VARIANCE = "1";
		const moderated = assessDelta(without, withRule, 25);

		// The point estimate is a function of the MEANS and must not move:
		// moderation touches variances only.
		expect(moderated.delta).toBe(plain.delta);
		expect(moderated.standardError).not.toBeNull();
		expect(Number.isFinite(moderated.standardError as number)).toBe(true);
		expect(moderated.standardError).toBeGreaterThan(0);
	});

	it("changes the standard error it reports", () => {
		const plain = assessDelta(without, withRule, 25).standardError as number;
		process.env.WARDEN_MODERATE_VARIANCE = "1";
		const moderated = assessDelta(without, withRule, 25)
			.standardError as number;
		// If these matched, the flag would be wired to nothing -- which is the
		// failure mode a default-off feature is most likely to have.
		expect(moderated).not.toBeCloseTo(plain, 6);
	});

	it("survives a task whose runs are identical (zero sample variance)", () => {
		process.env.WARDEN_MODERATE_VARIANCE = "1";
		const flat = [task("a", [5_000, 5_000, 5_000]), task("b", [7_000, 9_000])];
		const moved = [task("a", [3_000, 3_000, 3_000]), task("b", [5_000, 7_000])];
		const a = assessDelta(flat, moved, 25);
		expect(a.standardError).not.toBeNull();
		expect(Number.isFinite(a.standardError as number)).toBe(true);
	});

	it("still reports null confidence when no task can estimate variance", () => {
		process.env.WARDEN_MODERATE_VARIANCE = "1";
		const one = [task("a", [5_000])];
		const two = [task("a", [3_000])];
		// One run a side leaves nothing to moderate; the gate must stand down
		// rather than invent a band from a fitted prior.
		expect(assessDelta(one, two, 25).standardError).toBeNull();
	});
});
