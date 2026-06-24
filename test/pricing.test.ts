import { afterEach, describe, expect, it } from "vitest";
import {
	blendedDollarsPerToken,
	DEFAULT_MODEL,
	DEFAULT_PRICES,
	dollarsForTokens,
	priceFor,
} from "../src/pricing.js";

describe("rate card", () => {
	it("matches the public Anthropic per-1M-token rates", () => {
		expect(DEFAULT_PRICES["claude-opus-4-8"]?.input).toBe(5);
		expect(DEFAULT_PRICES["claude-fable-5"]?.output).toBe(50);
		expect(DEFAULT_PRICES["claude-haiku-4-5"]?.input).toBe(1);
		// The default model is a real, priced entry.
		expect(DEFAULT_PRICES[DEFAULT_MODEL]).toBeDefined();
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
