import { afterEach, describe, expect, it } from "vitest";
import {
	blendedDollarsPerToken,
	CACHE_READ_MULTIPLIER,
	CACHE_WRITE_MULTIPLIER,
	DEFAULT_MODEL,
	DEFAULT_PRICES,
	dollarsForTokens,
	priceFor,
} from "../src/pricing.js";

describe("rate card", () => {
	it("matches the public Anthropic per-1M-token rates", () => {
		expect(DEFAULT_PRICES["claude-opus-5"]?.input).toBe(5);
		expect(DEFAULT_PRICES["claude-opus-5"]?.output).toBe(25);
		expect(DEFAULT_PRICES["claude-opus-4-8"]?.input).toBe(5);
		expect(DEFAULT_PRICES["claude-fable-5"]?.output).toBe(50);
		expect(DEFAULT_PRICES["claude-mythos-5"]?.input).toBe(10);
		expect(DEFAULT_PRICES["claude-haiku-4-5"]?.input).toBe(1);
		expect(DEFAULT_PRICES["claude-sonnet-5"]?.input).toBe(3);
		// The default model is a real, priced entry.
		expect(DEFAULT_PRICES[DEFAULT_MODEL]).toBeDefined();
	});

	it("is internally consistent: every entry derives its cache rates from input", () => {
		for (const [model, price] of Object.entries(DEFAULT_PRICES)) {
			expect(price.cacheWrite, model).toBeCloseTo(
				price.input * CACHE_WRITE_MULTIPLIER,
				9,
			);
			expect(price.cacheRead, model).toBeCloseTo(
				price.input * CACHE_READ_MULTIPLIER,
				9,
			);
			// Rates are dollars per 1M tokens, never per token: a $3/MTok model
			// must read as 3, not 0.000003. Catches a unit slip by 1e6.
			expect(price.input, model).toBeGreaterThanOrEqual(1);
			expect(price.output, model).toBeGreaterThan(price.input);
		}
	});

	it("prices the friendly aliases the same as their concrete model ids", () => {
		expect(DEFAULT_PRICES.opus).toEqual(DEFAULT_PRICES["claude-opus-5"]);
		expect(DEFAULT_PRICES.sonnet).toEqual(DEFAULT_PRICES["claude-sonnet-5"]);
		expect(DEFAULT_PRICES.haiku).toEqual(DEFAULT_PRICES["claude-haiku-4-5"]);
		expect(DEFAULT_PRICES.fable).toEqual(DEFAULT_PRICES["claude-fable-5"]);
	});
});

const PRICE_ENVS = [
	"TOKEN_WARDEN_PRICE_INPUT",
	"TOKEN_WARDEN_PRICE_OUTPUT",
	"TOKEN_WARDEN_PRICE_CACHE_WRITE",
	"TOKEN_WARDEN_PRICE_CACHE_READ",
];

afterEach(() => {
	for (const k of PRICE_ENVS) delete process.env[k];
});

describe("priceFor", () => {
	it("resolves a known model with the standard cache multipliers", () => {
		const p = priceFor("claude-sonnet-4-6");
		expect(p.input).toBe(3);
		expect(p.output).toBe(15);
		expect(p.cacheWrite).toBeCloseTo(3.75, 6); // 1.25× input
		expect(p.cacheRead).toBeCloseTo(0.3, 6); // 0.1× input
	});

	it("falls back to the sonnet-tier default for an unknown/empty model", () => {
		expect(priceFor("who-knows").input).toBe(3);
		expect(priceFor(null).input).toBe(3);
		expect(priceFor(undefined).input).toBe(3);
		expect(priceFor("").input).toBe(3);
	});

	// DEFAULT_PRICES is an object literal, so these names resolve through
	// Object.prototype to a truthy FUNCTION. A truthiness guard lets them past
	// and leaves base.input undefined, NaN-ing the whole dollar layer. Reachable
	// since v0.36.0: `model:` comes from a user-written agent .md file.
	it.each([
		"constructor",
		"toString",
		"valueOf",
		"__proto__",
		"hasOwnProperty",
		"isPrototypeOf",
		"propertyIsEnumerable",
		"toLocaleString",
	])("treats inherited Object.prototype key %s as an unknown model", (name) => {
		const p = priceFor(name);
		expect(p.input).toBe(3);
		expect(p.output).toBe(15);
		expect(p.cacheWrite).toBeCloseTo(3.75, 6);
		expect(p.cacheRead).toBeCloseTo(0.3, 6);
		for (const rate of [p.input, p.output, p.cacheWrite, p.cacheRead]) {
			expect(Number.isFinite(rate)).toBe(true);
		}
		// The failure this guards is silent: NaN reaching the printed figures.
		const blended = blendedDollarsPerToken(
			{ input: 1000, output: 100, cacheCreation: 0, cacheRead: 5000 },
			p,
		);
		expect(Number.isNaN(blended)).toBe(false);
		expect(blended).toBeGreaterThan(0);
		expect(
			Number.isFinite(
				dollarsForTokens(
					{ input: 1000, output: 100, cacheCreation: 0, cacheRead: 5000 },
					p,
				),
			),
		).toBe(true);
	});

	it("lets env vars override the rates (apply your own per-token prices)", () => {
		process.env.TOKEN_WARDEN_PRICE_INPUT = "2";
		const p = priceFor("claude-opus-4-8");
		expect(p.input).toBe(2);
		expect(p.cacheWrite).toBeCloseTo(2.5, 6); // derived from overridden input
		expect(p.cacheRead).toBeCloseTo(0.2, 6);
		process.env.TOKEN_WARDEN_PRICE_CACHE_READ = "9";
		expect(priceFor("claude-opus-4-8").cacheRead).toBe(9);
	});

	// parseFloat/Number of garbage yields NaN, and NaN propagates silently
	// through every downstream dollar figure. A bad override must be ignored,
	// never adopted.
	it("ignores a non-numeric override instead of NaN-ing the whole report", () => {
		process.env.TOKEN_WARDEN_PRICE_INPUT = "three dollars";
		const p = priceFor("claude-sonnet-4-6");
		expect(p.input).toBe(3);
		expect(Number.isNaN(p.input)).toBe(false);
		expect(Number.isNaN(p.cacheWrite)).toBe(false);
		expect(Number.isNaN(p.cacheRead)).toBe(false);
	});

	it("ignores a blank override — `export VAR=` must not price work at zero", () => {
		// Number("") is 0, so an exported-but-empty var would otherwise make
		// every rule look free.
		process.env.TOKEN_WARDEN_PRICE_INPUT = "";
		process.env.TOKEN_WARDEN_PRICE_OUTPUT = "   ";
		const p = priceFor("claude-sonnet-4-6");
		expect(p.input).toBe(3);
		expect(p.output).toBe(15);
	});

	it("ignores negative and non-finite overrides", () => {
		process.env.TOKEN_WARDEN_PRICE_INPUT = "-5";
		expect(priceFor("claude-sonnet-4-6").input).toBe(3);
		process.env.TOKEN_WARDEN_PRICE_INPUT = "Infinity";
		expect(priceFor("claude-sonnet-4-6").input).toBe(3);
	});

	it("accepts an explicit zero rate (a genuinely free deployment)", () => {
		process.env.TOKEN_WARDEN_PRICE_INPUT = "0";
		const p = priceFor("claude-sonnet-4-6");
		expect(p.input).toBe(0);
		expect(p.cacheRead).toBe(0);
	});
});

describe("dollarsForTokens", () => {
	it("prices each token type at its own rate", () => {
		const sonnet = priceFor("claude-sonnet-4-6");
		expect(
			dollarsForTokens(
				{ input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 },
				sonnet,
			),
		).toBeCloseTo(3, 6);
		expect(
			dollarsForTokens(
				{ input: 0, output: 1_000_000, cacheCreation: 0, cacheRead: 0 },
				sonnet,
			),
		).toBeCloseTo(15, 6);
		expect(
			dollarsForTokens(
				{ input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 },
				sonnet,
			),
		).toBeCloseTo(0.3, 6); // cache-read is ~10% of input
	});
});

describe("blendedDollarsPerToken", () => {
	it("is the input rate for an all-input workload", () => {
		const sonnet = priceFor("claude-sonnet-4-6");
		const blended = blendedDollarsPerToken(
			{ input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 },
			sonnet,
		);
		expect(blended).toBeCloseTo(3 / 1_000_000, 12);
	});

	it("falls back to the input rate on an empty mix", () => {
		const sonnet = priceFor("claude-sonnet-4-6");
		expect(
			blendedDollarsPerToken(
				{ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
				sonnet,
			),
		).toBeCloseTo(3 / 1_000_000, 12);
	});

	it("falls back to the input rate on a negative or non-finite mix", () => {
		const sonnet = priceFor("claude-sonnet-4-6");
		// A negative total would otherwise flip the sign of every saving; a NaN
		// total would silently poison every figure derived from it.
		expect(
			blendedDollarsPerToken(
				{ input: -100, output: 0, cacheCreation: 0, cacheRead: 0 },
				sonnet,
			),
		).toBeCloseTo(3 / 1_000_000, 12);
		expect(
			blendedDollarsPerToken(
				{ input: Number.NaN, output: 0, cacheCreation: 0, cacheRead: 0 },
				sonnet,
			),
		).toBeCloseTo(3 / 1_000_000, 12);
	});

	it("a cache-read-heavy mix is far cheaper per token than the output rate", () => {
		const sonnet = priceFor("claude-sonnet-4-6");
		const blended = blendedDollarsPerToken(
			{ input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 },
			sonnet,
		);
		expect(blended).toBeCloseTo(0.3 / 1_000_000, 12);
		expect(blended).toBeLessThan(15 / 1_000_000); // << output rate
	});
});

describe("priceFor with dated model ids", () => {
	// Released ids carry a date; the rate card is keyed on the family. Exact
	// matching missed every dated id and fell through to the Sonnet default,
	// pricing Haiku at 3x its real input rate. Invisible, because the fallback
	// is a valid price rather than an error.
	it("resolves a dated id to its family rate", () => {
		expect(priceFor("claude-haiku-4-5-20251001").input).toBe(1);
		expect(priceFor("claude-haiku-4-5").input).toBe(1);
	});

	it("does not price Haiku as Sonnet", () => {
		expect(priceFor("claude-haiku-4-5-20251001").input).not.toBe(
			priceFor("claude-sonnet-5").input,
		);
	});

	it("prefers the longest matching family key", () => {
		expect(priceFor("claude-sonnet-4-6-20260101").input).toBe(3);
		expect(priceFor("claude-opus-5-20260101").input).toBe(5);
	});

	it("still falls back for a genuinely unknown model", () => {
		expect(priceFor("some-other-vendor-model").input).toBe(
			priceFor("claude-sonnet-5").input,
		);
	});

	it("does not resolve a partial family name by accident", () => {
		// `claude-haiku-4` is not `claude-haiku-4-5`; a bare prefix must not
		// match, or a future family would silently inherit an older rate.
		expect(priceFor("claude-haiku-4").input).toBe(3);
	});

	it("cannot be walked onto Object.prototype", () => {
		// The model string is user-supplied since bring-your-own-agent.
		for (const hostile of ["constructor", "__proto__", "toString", "valueOf"]) {
			const p = priceFor(hostile);
			expect(Number.isFinite(p.input)).toBe(true);
			expect(p.input).toBe(3);
		}
	});
});
