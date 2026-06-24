/**
 * Token pricing — turn token counts into dollars so verdicts speak in money, not
 * a raw-token proxy that critics rightly dismiss. Input, output, cache-write, and
 * cache-read tokens are priced very differently (cache-read ~0.1×, output ~5×),
 * so a dollar figure is the honest unit.
 *
 * Prices are in US dollars per 1M tokens, sourced from the public Anthropic
 * rate card (cache-write = 1.25× input for the 5-minute TTL; cache-read = 0.1×
 * input). They change over time and per deployment, so every field is
 * overridable via env — apply YOUR per-token rates.
 */

export interface Price {
	/** $/1M input tokens. */
	input: number;
	/** $/1M output tokens. */
	output: number;
	/** $/1M cache-write (5-minute TTL) tokens (~1.25× input). */
	cacheWrite: number;
	/** $/1M cache-read tokens (~0.1× input). */
	cacheRead: number;
}

/** Build a Price from a base input/output pair using the standard cache
 * multipliers (write 1.25×, read 0.1× of input). */
function priced(input: number, output: number): Price {
	return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 };
}

/** Public per-1M-token rates by model id (and friendly alias). */
export const DEFAULT_PRICES: Record<string, Price> = {
	"claude-opus-4-8": priced(5, 25),
	"claude-opus-4-7": priced(5, 25),
	"claude-opus-4-6": priced(5, 25),
	"claude-sonnet-4-6": priced(3, 15),
	"claude-haiku-4-5": priced(1, 5),
	"claude-fable-5": priced(10, 50),
	opus: priced(5, 25),
	sonnet: priced(3, 15),
	haiku: priced(1, 5),
	fable: priced(10, 50),
};

/** Fallback when a model is unknown or unset — Sonnet-tier, a reasonable middle. */
export const DEFAULT_MODEL = "sonnet";

/**
 * Resolve a model name to a Price. Any of TOKEN_WARDEN_PRICE_INPUT/_OUTPUT/
 * _CACHE_WRITE/_CACHE_READ (in $/1M tokens) override the looked-up rate; unset
 * cache fields default to the 1.25×/0.1× multipliers of the resolved input.
 */
export function priceFor(model?: string | null): Price {
	const base =
		(model && DEFAULT_PRICES[model]) ?? DEFAULT_PRICES[DEFAULT_MODEL];
	if (!base) throw new Error("no default price configured");
	const envNum = (name: string): number | null => {
		const raw = process.env[name];
		if (raw === undefined) return null;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : null;
	};
	const input = envNum("TOKEN_WARDEN_PRICE_INPUT") ?? base.input;
	return {
		input,
		output: envNum("TOKEN_WARDEN_PRICE_OUTPUT") ?? base.output,
		cacheWrite: envNum("TOKEN_WARDEN_PRICE_CACHE_WRITE") ?? input * 1.25,
		cacheRead: envNum("TOKEN_WARDEN_PRICE_CACHE_READ") ?? input * 0.1,
	};
}

export interface TokenBreakdown {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
}

/** Dollar cost of a typed token breakdown at the given price. */
export function dollarsForTokens(t: TokenBreakdown, price: Price): number {
	return (
		(t.input * price.input +
			t.output * price.output +
			t.cacheCreation * price.cacheWrite +
			t.cacheRead * price.cacheRead) /
		1_000_000
	);
}

/** Blended $/token implied by a workload's actual token-type mix. Returns the
 * input rate (per token) when the breakdown has no tokens, so callers always get
 * a usable, conservative number. */
export function blendedDollarsPerToken(
	t: TokenBreakdown,
	price: Price,
): number {
	const total = t.input + t.output + t.cacheCreation + t.cacheRead;
	if (total === 0) return price.input / 1_000_000;
	return dollarsForTokens(t, price) / total;
}
