import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fixtureDirFor,
	loadAgentDefinition,
	loadGoldenTasks,
} from "../src/bench.js";
import {
	assertKnownAgent,
	isValidAgentName,
	knownAgents,
	userAgentsDir,
	userBenchmarksDir,
	userFixturesDir,
} from "../src/registry.js";
import { parseSelectArgs } from "../src/select.js";
import { DOMAIN_AGENTS } from "../src/types.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let agentsDir: string;
let benchmarksDir: string;
let fixturesDir: string;

beforeEach(() => {
	agentsDir = mkdtempSync(join(tmpdir(), "warden-agents-"));
	benchmarksDir = mkdtempSync(join(tmpdir(), "warden-benchmarks-"));
	fixturesDir = mkdtempSync(join(tmpdir(), "warden-fixtures-"));
});

afterEach(() => {
	rmSync(agentsDir, { recursive: true, force: true });
	rmSync(benchmarksDir, { recursive: true, force: true });
	rmSync(fixturesDir, { recursive: true, force: true });
	delete process.env.TOKEN_WARDEN_AGENTS_DIR;
	delete process.env.TOKEN_WARDEN_BENCHMARKS_DIR;
	delete process.env.TOKEN_WARDEN_FIXTURES_DIR;
});

describe("userAgentsDir / userBenchmarksDir", () => {
	it("honor the env overrides", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR = benchmarksDir;
		expect(userAgentsDir()).toBe(agentsDir);
		expect(userBenchmarksDir()).toBe(benchmarksDir);
	});

	it("userFixturesDir honors its override and defaults under ~/.token-warden", () => {
		process.env.TOKEN_WARDEN_FIXTURES_DIR = fixturesDir;
		expect(userFixturesDir()).toBe(fixturesDir);
		delete process.env.TOKEN_WARDEN_FIXTURES_DIR;
		expect(userFixturesDir().endsWith(join(".token-warden", "fixtures"))).toBe(
			true,
		);
	});

	it("default under ~/.token-warden when unset", () => {
		expect(userAgentsDir().endsWith(join(".token-warden", "agents"))).toBe(
			true,
		);
		expect(
			userBenchmarksDir().endsWith(join(".token-warden", "benchmarks")),
		).toBe(true);
	});
});

describe("knownAgents", () => {
	it("returns exactly the bundled defaults when the user dir is absent", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = join(agentsDir, "does-not-exist");
		expect(knownAgents()).toEqual([...DOMAIN_AGENTS]);
	});

	it("appends valid custom names, bundled first then custom sorted", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		writeFileSync(join(agentsDir, "zeta.md"), "memory: user\n");
		writeFileSync(join(agentsDir, "alpha.md"), "memory: user\n");
		expect(knownAgents()).toEqual([...DOMAIN_AGENTS, "alpha", "zeta"]);
	});

	it("rejects bad basenames (uppercase, dots, over-long, non-md)", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		writeFileSync(join(agentsDir, "Upper.md"), "memory: user\n");
		writeFileSync(join(agentsDir, "has.dot.md"), "memory: user\n");
		writeFileSync(join(agentsDir, `${"x".repeat(40)}.md`), "memory: user\n");
		writeFileSync(join(agentsDir, "notes.txt"), "ignored\n");
		writeFileSync(join(agentsDir, "good.md"), "memory: user\n");
		expect(knownAgents()).toEqual([...DOMAIN_AGENTS, "good"]);
	});

	it("never lets a listed name become a path escape", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		// Basenames a hostile or careless drop-in could produce. None of these
		// may reach a join() as an agent name.
		for (const name of ["..md", ".md", "-rf.md", "a b.md", "a.b.md", "x.md"]) {
			writeFileSync(join(agentsDir, name), "memory: user\n");
		}
		// A directory (not a definition) that happens to end in .md.
		mkdirSync(join(agentsDir, "adir.md"));
		expect(knownAgents()).toEqual([...DOMAIN_AGENTS]);
	});

	it("dedupes a custom override of a bundled name", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		writeFileSync(join(agentsDir, `${DOMAIN_AGENTS[0]}.md`), "memory: user\n");
		const agents = knownAgents();
		expect(agents).toEqual([...DOMAIN_AGENTS]);
		expect(agents.filter((a) => a === DOMAIN_AGENTS[0])).toHaveLength(1);
	});
});

describe("isValidAgentName", () => {
	it("accepts lowercase slugs of 2-32 characters", () => {
		for (const name of ["sql", "my-agent", "a1", "a".repeat(32)]) {
			expect(isValidAgentName(name)).toBe(true);
		}
		for (const bundled of DOMAIN_AGENTS) {
			expect(isValidAgentName(bundled)).toBe(true);
		}
	});

	it("rejects anything that could escape a path or an argv slot", () => {
		for (const name of [
			"",
			"a",
			"..",
			"../etc/passwd",
			"sql/../../x",
			"sql/sub",
			"sql\\win",
			"-rf",
			"--agent",
			"Sql",
			"sql agent",
			"sql.md",
			"sql ",
			"sql\n",
			"a".repeat(33),
		]) {
			expect(isValidAgentName(name), name).toBe(false);
		}
	});
});

describe("assertKnownAgent", () => {
	it("passes for a bundled agent", () => {
		expect(() => assertKnownAgent("sql")).not.toThrow();
	});

	it("throws with the full discovered list in the message", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		writeFileSync(join(agentsDir, "custom.md"), "memory: user\n");
		expect(() => assertKnownAgent("nope")).toThrow(
			`--agent must be one of: ${[...DOMAIN_AGENTS, "custom"].join(", ")} (got "nope")`,
		);
	});
});

describe("bench loaders resolve custom agents via the env overrides", () => {
	it("loadAgentDefinition reads a user agent .md; bundled unaffected", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		writeFileSync(
			join(agentsDir, "custom.md"),
			"---\nmemory: user\nmodel: haiku\n---\nbody\n",
		);
		const custom = loadAgentDefinition("custom");
		expect(custom.model).toBe("haiku");
		expect(custom.content).toContain("memory: project");
		// A bundled agent still resolves from the shipped agents/ dir.
		expect(() => loadAgentDefinition("sql")).not.toThrow();
	});

	it("loadGoldenTasks reads a user suite when no bundled dir exists", () => {
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR = benchmarksDir;
		const suiteDir = join(benchmarksDir, "custom");
		mkdirSync(suiteDir, { recursive: true });
		writeFileSync(
			join(suiteDir, "golden-01.md"),
			[
				"---",
				'id: "custom-01"',
				'agent: "custom"',
				'prompt: "do a thing"',
				'success_check: "true"',
				"---",
				"",
			].join("\n"),
		);
		const tasks = loadGoldenTasks("custom");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.id).toBe("custom-01");
	});

	it("loadGoldenTasks mentions both paths when neither exists", () => {
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR = benchmarksDir;
		expect(() => loadGoldenTasks("ghost")).toThrow(/benchmarks.*ghost/s);
	});
});

/**
 * BYOA made the agent definition and the golden suite overridable and left the
 * third leg — the repository the tasks actually run in — hardcoded to the
 * bundled fixture. A suite drafted from a user's own recorded work asks the
 * agent to change the user's code and checks it with the user's test command,
 * so against a toy e-commerce repo it cannot pass in principle.
 *
 * The frozen bundled fixture stays frozen for the bundled four: their recorded
 * `run1_tokens` baselines and every published comparison were measured there,
 * and an env var that could redirect them would invalidate the lot silently.
 */
describe("fixtureDirFor", () => {
	const bundled = join(pluginRoot, "benchmarks", "fixture");

	it("keeps a bundled agent on the frozen fixture, whatever the env says", () => {
		process.env.TOKEN_WARDEN_FIXTURES_DIR = fixturesDir;
		mkdirSync(join(fixturesDir, "sql"), { recursive: true });
		expect(fixtureDirFor("sql")).toBe(bundled);
	});

	it("gives a custom agent its own fixture when one exists", () => {
		process.env.TOKEN_WARDEN_FIXTURES_DIR = fixturesDir;
		const own = join(fixturesDir, "custom");
		mkdirSync(own, { recursive: true });
		expect(fixtureDirFor("custom")).toBe(own);
	});

	it("falls back to the bundled fixture when a custom agent has none", () => {
		process.env.TOKEN_WARDEN_FIXTURES_DIR = fixturesDir;
		expect(fixtureDirFor("custom")).toBe(bundled);
	});
});

describe("CLI validation accepts a custom agent", () => {
	it("parseSelectArgs accepts an agent supplied by the user dir", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		writeFileSync(join(agentsDir, "myagent.md"), "memory: user\n");
		expect(parseSelectArgs(["--agent", "myagent"]).agent).toBe("myagent");
		expect(() => parseSelectArgs(["--agent", "nope"])).toThrow(/--agent/);
	});
});
