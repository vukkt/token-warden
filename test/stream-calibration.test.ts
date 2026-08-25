/**
 * The break-even harm solver.
 *
 * Every net-token sweep this project has run priced a kept worthless rule at
 * exactly its rent, so the sweeps all concluded the gate should loosen -- at a
 * harm of zero a false positive is nearly free against a missed rule's ~4,769
 * tokens, and net tokens rise monotonically all the way to z=0. That is the
 * hidden assumption read back, not a finding about the noise.
 *
 * `breakEvenHarm` names the assumption. Net tokens are LINEAR in harm, so two
 * arms cross at exactly one point and it is solved rather than searched. These
 * tests check the algebra and the two degenerate cases, because the number it
 * returns is the whole argument in docs/hundred-algorithms.md.
 */
import { describe, expect, it } from "vitest";
import {
	breakEvenHarm,
	type HarmLine,
} from "../validation/stream-calibration.js";

/** Net tokens for an arm at a given harm -- the line the solver intersects. */
const netAt = (arm: HarmLine, harm: number): number =>
	arm.netBeforeHarm - arm.falseDiscoveries * harm;

describe("breakEvenHarm", () => {
	// A loose arm keeps more of everything; a tight arm keeps less. Numbers in
	// the shape the sql pool produces at overlap 0.85.
	const loose: HarmLine = { netBeforeHarm: 20_703, falseDiscoveries: 16.0 };
	const tight: HarmLine = { netBeforeHarm: 11_384, falseDiscoveries: 2.8 };

	it("returns the harm at which the two arms tie", () => {
		const h = breakEvenHarm(loose, tight);
		expect(h).not.toBeNull();
		expect(netAt(loose, h as number)).toBeCloseTo(netAt(tight, h as number), 6);
	});

	it("puts the crossing between the arms' own harm scales", () => {
		// Sanity on magnitude: the solved value must be a real token quantity,
		// not an artefact of a sign slip.
		expect(breakEvenHarm(loose, tight)).toBeCloseTo(9319 / 13.2, 4);
	});

	it("hands the win to the looser arm below the crossing", () => {
		const h = breakEvenHarm(loose, tight) as number;
		expect(netAt(loose, h * 0.5)).toBeGreaterThan(netAt(tight, h * 0.5));
	});

	it("hands the win to the tighter arm above the crossing", () => {
		const h = breakEvenHarm(loose, tight) as number;
		expect(netAt(tight, h * 2)).toBeGreaterThan(netAt(loose, h * 2));
	});

	/**
	 * Parallel lines. Two arms keeping the same number of worthless rules can
	 * never be separated by harm -- one dominates at every value of it -- and
	 * returning a number here would invent a crossing that does not exist.
	 * This is the case the harness hits when both arms run the same z.
	 */
	it("returns null when both arms keep the same worthless count", () => {
		expect(
			breakEvenHarm(
				{ netBeforeHarm: 12_000, falseDiscoveries: 4 },
				{ netBeforeHarm: 9_000, falseDiscoveries: 4 },
			),
		).toBeNull();
	});

	/**
	 * A crossing at negative harm is not a quantity this project can have: it
	 * would mean a worthless rule PAYS beyond saving its own rent. The arms do
	 * cross, but not anywhere reachable, so there is no break-even to report.
	 */
	it("returns null when the arms cross at a negative harm", () => {
		// The looser arm is behind on net BEFORE harm, so more harm only widens
		// the gap; the algebraic crossing sits below zero.
		expect(
			breakEvenHarm(
				{ netBeforeHarm: 5_000, falseDiscoveries: 16 },
				{ netBeforeHarm: 11_000, falseDiscoveries: 3 },
			),
		).toBeNull();
	});

	it("is antisymmetric in its arguments", () => {
		// Same crossing whichever arm is named first -- both numerator and
		// denominator flip sign.
		expect(breakEvenHarm(tight, loose)).toBeCloseTo(
			breakEvenHarm(loose, tight) as number,
			6,
		);
	});
});
