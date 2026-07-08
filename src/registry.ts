/**
 * Discoverable agent registry (bring-your-own-agent).
 *
 * token-warden ships four domain agents (`DOMAIN_AGENTS`) with golden suites,
 * but an integrator can point it at their own agents by dropping
 * `<name>.md` files into `TOKEN_WARDEN_AGENTS_DIR` (default
 * `~/.token-warden/agents`) and golden suites into `TOKEN_WARDEN_BENCHMARKS_DIR`
 * (default `~/.token-warden/benchmarks/<name>/`). With neither env var set and
 * no such directory present, every function here behaves exactly as the old
 * hardcoded `DOMAIN_AGENTS` checks did.
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DOMAIN_AGENTS } from "./types.js";

/** Custom-agent basenames must be a lowercase slug: leading letter, then 1-31
 * more of `[a-z0-9-]`. Anything else (uppercase, dots, over-long) is ignored so
 * a stray file never becomes a valid agent name. */
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Directory scanned for user-supplied `<name>.md` agent definitions. */
export function userAgentsDir(): string {
	return (
		process.env.TOKEN_WARDEN_AGENTS_DIR ??
		join(homedir(), ".token-warden", "agents")
	);
}

/** Directory scanned for user-supplied `<name>/golden-*.md` suites. */
export function userBenchmarksDir(): string {
	return (
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR ??
		join(homedir(), ".token-warden", "benchmarks")
	);
}

/** The full set of agents token-warden knows about: the bundled defaults first
 * (in their shipped order), then the basenames of valid `<name>.md` files in
 * `userAgentsDir()`, sorted and deduped. A missing or unreadable directory
 * contributes nothing; this never throws. */
export function knownAgents(): string[] {
	const bundled = [...DOMAIN_AGENTS];
	const seen = new Set<string>(bundled);
	let custom: string[] = [];
	try {
		custom = readdirSync(userAgentsDir())
			.filter((name) => name.endsWith(".md"))
			.map((name) => name.slice(0, -".md".length))
			.filter((name) => AGENT_NAME_PATTERN.test(name) && !seen.has(name));
	} catch {
		// Missing/unreadable dir: no custom agents, defaults stand.
	}
	custom.sort();
	return [...bundled, ...custom];
}

/** Throw if `agent` is not a known agent, with the discovered list in the
 * message (mirrors the pre-BYOA `--agent must be one of: ...` error style). */
export function assertKnownAgent(agent: string): void {
	if (!knownAgents().includes(agent)) {
		throw new Error(
			`--agent must be one of: ${knownAgents().join(", ")} (got "${agent}")`,
		);
	}
}
