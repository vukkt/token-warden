import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findContradictions,
	main,
	parseContradictArgs,
	renderContradictions,
} from "../src/contradict.js";
import { insertAuthoredRule, openDb } from "../src/db.js";

describe("findContradictions", () => {
	it("flags a rule that shares a topic but states the opposite", () => {
		const rules = [
			{ id: 1, body: "Never read a whole file; grep for the symbol first." },
		];
		const claudeMd = "Always read the entire file before editing it.";
		const found = findContradictions(rules, claudeMd);
		expect(found).toHaveLength(1);
		expect(found[0]?.ruleId).toBe(1);
		expect(found[0]?.reason).toMatch(/opposite-polarity/);
	});

	it("flags an explicit antonym pair on a shared topic", () => {
		// Same polarity (neither negated), so this exercises the antonym branch:
		// "all" vs "none" on the shared cache/endpoints topic.
		const rules = [{ id: 7, body: "Cache responses for all endpoints." }];
		const claudeMd = "- Cache none of the authenticated endpoints.";
		const found = findContradictions(rules, claudeMd);
		expect(found).toHaveLength(1);
		expect(found[0]?.reason).toMatch(/all.*none|none.*all/);
	});

	it("does not flag an unrelated convention", () => {
		const rules = [
			{ id: 2, body: "Grep before opening a file to save tokens." },
		];
		const claudeMd = "Write conventional commit messages in the imperative.";
		expect(findContradictions(rules, claudeMd)).toHaveLength(0);
	});

	it("does not flag a rule that agrees with the conventions", () => {
		const rules = [
			{ id: 3, body: "Always run the tests before committing changes." },
		];
		const claudeMd = "Always run the tests before you commit changes.";
		expect(findContradictions(rules, claudeMd)).toHaveLength(0);
	});

	it("reports at most one flag per rule", () => {
		const rules = [{ id: 4, body: "Never read the whole file." }];
		const claudeMd = [
			"Always read the whole file.",
			"You should read the whole file every time.",
		].join("\n");
		expect(findContradictions(rules, claudeMd)).toHaveLength(1);
	});
});

describe("renderContradictions", () => {
	it("says all-clear with no contradictions", () => {
		expect(renderContradictions("sql", [])).toMatch(/no rules contradict/);
	});

	it("lists flagged rules and notes they are not auto-evicted", () => {
		const out = renderContradictions("sql", [
			{ ruleId: 1, ruleBody: "x", conflictingLine: "y", reason: "z" },
		]);
		expect(out).toContain("rule 1");
		expect(out).toMatch(/not auto-evicted/);
	});
});

describe("parseContradictArgs", () => {
	it("defaults to CLAUDE.md in the cwd and all agents", () => {
		const args = parseContradictArgs([]);
		expect(args.agent).toBeNull();
		expect(args.file).toMatch(/CLAUDE\.md$/);
		expect(args.gate).toBe(false);
	});

	it("parses --agent, --file and --gate", () => {
		const args = parseContradictArgs([
			"--agent",
			"sql",
			"--file",
			"X.md",
			"--gate",
		]);
		expect(args).toMatchObject({ agent: "sql", file: "X.md", gate: true });
	});

	it("rejects an unknown agent", () => {
		expect(() => parseContradictArgs(["--agent", "nope"])).toThrow(/--agent/);
	});
});

describe("contradict main()", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-contradict-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_DB;
	});

	it("returns 0 when the CLAUDE.md file is absent", () => {
		expect(main(["--agent", "sql", "--file", join(dir, "nope.md")])).toBe(0);
	});

	it("--gate exits non-zero when an active rule contradicts CLAUDE.md", () => {
		const db = openDb(process.env.TOKEN_WARDEN_DB as string);
		insertAuthoredRule(db, {
			agent: "sql",
			body: "Never read the whole file before editing.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});
		db.close();
		const file = join(dir, "CLAUDE.md");
		writeFileSync(file, "Always read the whole file before editing.\n");
		expect(main(["--agent", "sql", "--file", file, "--gate"])).toBe(1);
		// Without --gate, a contradiction reports but does not fail.
		expect(main(["--agent", "sql", "--file", file])).toBe(0);
	});
});
