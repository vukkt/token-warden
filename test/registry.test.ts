import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentDefinition, loadGoldenTasks } from "../src/bench.js";
import {
	assertKnownAgent,
	knownAgents,
	userAgentsDir,
	userBenchmarksDir,
} from "../src/registry.js";
import { parseSelectArgs } from "../src/select.js";
import { DOMAIN_AGENTS } from "../src/types.js";

let agentsDir: string;
let benchmarksDir: string;

beforeEach(() => {
	agentsDir = mkdtempSync(join(tmpdir(), "warden-agents-"));
	benchmarksDir = mkdtempSync(join(tmpdir(), "warden-benchmarks-"));
});

afterEach(() => {
	rmSync(agentsDir, { recursive: true, force: true });
	rmSync(benchmarksDir, { recursive: true, force: true });
	delete process.env.TOKEN_WARDEN_AGENTS_DIR;
	delete process.env.TOKEN_WARDEN_BENCHMARKS_DIR;
});

describe("userAgentsDir / userBenchmarksDir", () => {
	it("honor the env overrides", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR = benchmarksDir;
		expect(userAgentsDir()).toBe(agentsDir);
		expect(userBenchmarksDir()).toBe(benchmarksDir);
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

	it("dedupes a custom override of a bundled name", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		writeFileSync(join(agentsDir, `${DOMAIN_AGENTS[0]}.md`), "memory: user\n");
		const agents = knownAgents();
		expect(agents).toEqual([...DOMAIN_AGENTS]);
		expect(agents.filter((a) => a === DOMAIN_AGENTS[0])).toHaveLength(1);
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

describe("CLI validation accepts a custom agent", () => {
	it("parseSelectArgs accepts an agent supplied by the user dir", () => {
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		writeFileSync(join(agentsDir, "myagent.md"), "memory: user\n");
		expect(parseSelectArgs(["--agent", "myagent"]).agent).toBe("myagent");
		expect(() => parseSelectArgs(["--agent", "nope"])).toThrow(/--agent/);
	});
});
