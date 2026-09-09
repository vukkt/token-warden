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
import { DOMAIN_AGENTS, MAIN_TARGET } from "./types.js";

/** Custom-agent basenames must be a lowercase slug: leading letter, then 1-31
 * more of `[a-z0-9-]`. Anything else (uppercase, dots, over-long) is ignored so
 * a stray file never becomes a valid agent name.
 *
 * SECURITY: this is also the traversal guard. An agent name becomes a path
 * component (`<agentsDir>/<name>.md`, `<benchmarksDir>/<name>/`) and a CLI
 * argument, so the pattern deliberately excludes `/`, `\`, `.`, NUL and every
 * other separator — `..`, `../../etc/passwd` and `sql/../../x` can never match. */
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** True when `name` is safe to use as an agent identifier — i.e. as a path
 * component or a subprocess argument. Exported so every boundary that accepts
 * a foreign agent name (imported ledgers, CLI flags) tests the same rule. */
export function isValidAgentName(name: string): boolean {
	return AGENT_NAME_PATTERN.test(name);
}

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

/**
 * Directory scanned for user-supplied `<name>/` FIXTURES — the repository
 * snapshot a custom agent's golden tasks run against.
 *
 * BYOA shipped the agent definition and the suite as overridable, and left the
 * third leg hardcoded: every task, bundled or custom, was copied into
 * `benchmarks/fixture` (the toy e-commerce repo). A task mined from a user's
 * own work says "fix the N+1 in the orders repository" and its check runs the
 * user's own test command, so against the bundled fixture it can only ever
 * fail. Without this directory a custom suite is unrunnable in principle, not
 * merely unvalidated.
 *
 * Bundled agents are deliberately NOT affected — `benchmarks/fixture` is a
 * frozen fixture the project's published results depend on; see
 * `fixtureDirFor` in bench.ts.
 */
export function userFixturesDir(): string {
	return (
		process.env.TOKEN_WARDEN_FIXTURES_DIR ??
		join(homedir(), ".token-warden", "fixtures")
	);
}

/** The full set of agents token-warden knows about: the bundled defaults first
 * (in their shipped order), then the basenames of valid `<name>.md` files in
 * `userAgentsDir()`, sorted and deduped. A missing or unreadable directory
 * contributes nothing; this never throws.
 *
 * A custom file whose basename collides with a bundled agent is dropped, not
 * appended: the bundled name stays a single entry and keeps its shipped
 * position, so `sql.md` in the user directory can never shadow the bundled
 * `sql` in this list (bench.ts likewise prefers the bundled definition and
 * suite, so the two resolutions agree). */
export function knownAgents(): string[] {
	const bundled = [...DOMAIN_AGENTS];
	const seen = new Set<string>(bundled);
	let custom: string[] = [];
	try {
		custom = readdirSync(userAgentsDir(), { withFileTypes: true })
			// A *directory* named `foo.md` is not an agent definition; anything
			// else readable (file or symlink to one) is allowed through.
			.filter((entry) => !entry.isDirectory() && entry.name.endsWith(".md"))
			.map((entry) => entry.name.slice(0, -".md".length))
			.filter((name) => isValidAgentName(name) && !seen.has(name));
	} catch {
		// Missing/unreadable dir: no custom agents, defaults stand.
	}
	custom.sort();
	return [...bundled, ...custom];
}

/**
 * True when the main target has a golden suite — i.e. when drafts mined from
 * the user's own sessions have been promoted into `<benchmarks>/main/`.
 *
 * This is the whole gate on measuring real work. `main` is not "known" the way
 * an agent is known (it has no definition and never will); it becomes
 * MEASURABLE the moment there is something to measure it against, and stops
 * being measurable if that suite is removed. Checking the filesystem rather
 * than caching a flag keeps those two facts from drifting apart.
 */
export function mainTargetMeasurable(): boolean {
	const dir = join(userBenchmarksDir(), MAIN_TARGET);
	try {
		return readdirSync(dir).some((name) => /^golden-\d+\.md$/.test(name));
	} catch {
		return false;
	}
}

/**
 * Everything a verdict can be produced for: the definition-backed agents, plus
 * the user's own session once it has a drafted suite.
 *
 * Separate from `knownAgents()` on purpose. `knownAgents()` answers "what has an
 * agent definition I can install into a fixture" — the question `bench.ts` asks
 * when it materializes a child. This answers "what can be measured", which is
 * the question the CLI, the selector and the distiller ask. Conflating them put
 * `main` into `--agent all` and into the shipped-suite hygiene checks, where it
 * has no definition and no bundled suite to find.
 */
export function measurableTargets(): string[] {
	const agents = knownAgents();
	return mainTargetMeasurable() ? [MAIN_TARGET, ...agents] : agents;
}

/**
 * Throw unless `agent` is a target a SUITE COULD BE DRAFTED FOR.
 *
 * Deliberately looser than `assertKnownAgent`: the main target is measurable
 * only once it has a suite, and drafting is what produces that suite, so
 * validating the drafter's `--agent` against measurability is a cycle nothing
 * can enter. The drafter refused `main` with "must be one of: frontend,
 * backend, sql, testing" on a fresh installation -- the hook would have spawned
 * it every six hours forever, to be turned away every time.
 */
export function assertDraftTarget(agent: string): void {
	const targets = [MAIN_TARGET, ...knownAgents()];
	if (!targets.includes(agent)) {
		throw new Error(
			`--agent must be one of: ${targets.join(", ")} (got "${agent}")`,
		);
	}
}

/** Throw if `agent` is not a known agent, with the discovered list in the
 * message (mirrors the pre-BYOA `--agent must be one of: ...` error style).
 * The main target passes once it has a suite — see `measurableTargets`. */
export function assertKnownAgent(agent: string): void {
	// One directory scan, not two (this used to re-list the agents dir just to
	// build the error message).
	const agents = measurableTargets();
	if (!agents.includes(agent)) {
		throw new Error(
			`--agent must be one of: ${agents.join(", ")} (got "${agent}")`,
		);
	}
}
