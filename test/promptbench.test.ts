import { describe, expect, it } from "vitest";
import { parseAgentDefinition } from "../src/bench.js";
import { parsePromptbenchArgs } from "../src/promptbench.js";

describe("parsePromptbenchArgs", () => {
	it("parses agent and variant with defaults", () => {
		expect(
			parsePromptbenchArgs(["--agent", "sql", "--variant", "/tmp/v.md"]),
		).toEqual({
			agent: "sql",
			variant: "/tmp/v.md",
			runs: 2,
			topUp: 1,
			task: null,
		});
	});

	it("parses overrides", () => {
		expect(
			parsePromptbenchArgs([
				"--agent",
				"backend",
				"--variant",
				"/tmp/v.md",
				"--runs",
				"3",
				"--top-up",
				"0",
				"--task",
				"backend-01",
			]),
		).toEqual({
			agent: "backend",
			variant: "/tmp/v.md",
			runs: 3,
			topUp: 0,
			task: "backend-01",
		});
	});

	it("rejects bad input", () => {
		expect(() =>
			parsePromptbenchArgs(["--agent", "main", "--variant", "/v.md"]),
		).toThrow(/--agent/);
		expect(() => parsePromptbenchArgs(["--agent", "sql"])).toThrow(/--variant/);
		expect(() =>
			parsePromptbenchArgs([
				"--agent",
				"sql",
				"--variant",
				"/v.md",
				"--runs",
				"0",
			]),
		).toThrow(/--runs/);
		expect(() =>
			parsePromptbenchArgs(["--agent", "sql", "--variant", "/v.md", "--x"]),
		).toThrow(/unknown flag/);
	});
});

describe("parseAgentDefinition (prompt variants)", () => {
	it("rewrites the memory scope and reads the model", () => {
		const def = parseAgentDefinition(
			"---\nname: sql\nmodel: opus\nmemory: user\n---\nYou are the SQL agent.",
			"variant.md",
		);
		expect(def.model).toBe("opus");
		expect(def.content).toContain("memory: project");
		expect(def.content).not.toContain("memory: user");
	});

	it("rejects a definition with no memory field", () => {
		expect(() =>
			parseAgentDefinition("---\nname: sql\n---\nbody", "variant.md"),
		).toThrow(/memory/);
	});

	it("defaults the model to sonnet when frontmatter omits it", () => {
		expect(
			parseAgentDefinition("---\nname: sql\nmemory: user\n---\nb", "v.md")
				.model,
		).toBe("sonnet");
	});
});
