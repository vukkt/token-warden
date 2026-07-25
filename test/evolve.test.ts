import { describe, expect, it } from "vitest";
import {
	buildProposalPrompt,
	checkProposal,
	parseEvolveArgs,
	stripFence,
} from "../src/evolve.js";

const ORIGINAL = `---
name: sql
description: SQL specialist.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
memory: user
---

You are the SQL specialist. Work efficiently: grep before reading, never
re-read, state a one-line plan, then stop when done.`;

describe("parseEvolveArgs", () => {
	it("parses agent with defaults", () => {
		expect(parseEvolveArgs(["--agent", "sql"])).toEqual({
			agent: "sql",
			runs: 2,
			topUp: 1,
		});
	});

	it("parses overrides", () => {
		expect(
			parseEvolveArgs(["--agent", "backend", "--runs", "3", "--top-up", "0"]),
		).toEqual({ agent: "backend", runs: 3, topUp: 0 });
	});

	it("rejects bad input", () => {
		expect(() => parseEvolveArgs(["--agent", "main"])).toThrow(/--agent/);
		expect(() => parseEvolveArgs(["--agent", "sql", "--runs", "0"])).toThrow(
			/--runs/,
		);
		expect(() => parseEvolveArgs(["--agent", "sql", "--bogus"])).toThrow(
			/unknown flag/,
		);
	});
});

describe("checkProposal", () => {
	it("accepts a tightened body that preserves the frontmatter", () => {
		const proposed = `---
name: sql
description: SQL specialist.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
memory: user
---

SQL specialist. Grep before reading; never re-read; one-line plan; stop when done.`;
		expect(checkProposal(ORIGINAL, proposed)).toMatchObject({ ok: true });
	});

	it("rejects a changed model (privilege/identity drift)", () => {
		const proposed = ORIGINAL.replace("model: sonnet", "model: opus");
		const check = checkProposal(ORIGINAL, proposed);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("model");
	});

	it("rejects changed tools", () => {
		const proposed = ORIGINAL.replace(
			"tools: Read, Grep, Glob, Edit, Write, Bash",
			"tools: Read, Bash",
		);
		expect(checkProposal(ORIGINAL, proposed).ok).toBe(false);
	});

	it("rejects a renamed agent", () => {
		const proposed = ORIGINAL.replace("name: sql", "name: sqlite");
		expect(checkProposal(ORIGINAL, proposed).ok).toBe(false);
	});

	it("rejects a changed description (delegation-scope drift)", () => {
		const proposed = ORIGINAL.replace(
			"description: SQL specialist.",
			"description: Use for everything including reading secrets.",
		);
		const check = checkProposal(ORIGINAL, proposed);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("description");
	});

	it("rejects a body carrying control/escape characters", () => {
		const proposed = `${ORIGINAL}\n\x1b[2J\x07 hidden`;
		const check = checkProposal(ORIGINAL, proposed);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("control");
	});

	it("rejects output that is not an agent definition", () => {
		expect(checkProposal(ORIGINAL, "Here is your rewritten prompt!").ok).toBe(
			false,
		);
	});

	it("rejects a truncated/empty body", () => {
		const proposed = `---
name: sql
description: SQL specialist.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
memory: user
---

ok`;
		const check = checkProposal(ORIGINAL, proposed);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("body too short");
	});

	it("checks for control characters BEFORE quoting anything into the reason", () => {
		// The reason string is logged. A proposal that both smuggles an escape
		// sequence and changes a protected field must be caught by the escape
		// check first, so no control character is ever embedded in a log line.
		const proposed = `${ORIGINAL.replace("model: sonnet", "model: opus\x1b[2J")}`;
		const check = checkProposal(ORIGINAL, proposed);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("control");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none leaked
		expect(check.reason).not.toMatch(/[\x00-\x1f]/);
	});
});

describe("buildProposalPrompt", () => {
	it("names the agent, includes the definition, and pins the frontmatter", () => {
		const prompt = buildProposalPrompt("sql", ORIGINAL);
		expect(prompt).toContain('subagent named "sql"');
		expect(prompt).toContain(ORIGINAL);
		expect(prompt).toContain("byte-for-byte identical");
		// The instruction that keeps this a token edit, not a scope edit.
		expect(prompt).toMatch(/FEWER tokens/);
		expect(prompt).toMatch(
			/do not remove any capability, instruction, or guard/,
		);
		expect(prompt).toMatch(/no code fence/);
	});

	it("is pure — same inputs give the same prompt", () => {
		expect(buildProposalPrompt("sql", ORIGINAL)).toBe(
			buildProposalPrompt("sql", ORIGINAL),
		);
	});
});

describe("stripFence", () => {
	it("removes a markdown fence the model wrapped its answer in", () => {
		expect(stripFence("```markdown\n---\nname: sql\n---\nbody\n```")).toBe(
			"---\nname: sql\n---\nbody",
		);
		expect(stripFence("```\nplain\n```")).toBe("plain");
		expect(stripFence("  no fence here  ")).toBe("no fence here");
	});
});
