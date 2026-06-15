import { describe, expect, it } from "vitest";
import { checkProposal, parseEvolveArgs } from "../src/evolve.js";

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
});
