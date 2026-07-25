import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findContradictions,
	main,
	parseContradictArgs,
	renderContradictions,
} from "../src/contradict.js";
import { insertAuthoredRule, listRulesByAgent, openDb } from "../src/db.js";
import type { RuleId } from "../src/types.js";

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

	it("is total on empty and degenerate input", () => {
		expect(findContradictions([], "Always read the whole file.")).toEqual([]);
		expect(
			findContradictions([{ id: 1, body: "Never read files." }], ""),
		).toEqual([]);
		// A rule whose every token is a stopword or a negation has no topic to
		// share, so it can never reach the >=1 shared-word branch.
		expect(
			findContradictions([{ id: 1, body: "do not" }], "Always do it.\n"),
		).toEqual([]);
		// Whitespace-only conventions file: no directive lines at all.
		expect(
			findContradictions(
				[{ id: 1, body: "Never read the whole file." }],
				"\n \n",
			),
		).toEqual([]);
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
			{ ruleId: 1 as RuleId, ruleBody: "x", conflictingLine: "y", reason: "z" },
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

	it("defaults to CLAUDE_PROJECT_DIR when set (slash command cd's away)", () => {
		const prev = process.env.CLAUDE_PROJECT_DIR;
		process.env.CLAUDE_PROJECT_DIR = "/my/project";
		try {
			expect(parseContradictArgs([]).file).toBe("/my/project/CLAUDE.md");
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
			else process.env.CLAUDE_PROJECT_DIR = prev;
		}
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

	// ---- PROPERTY: this module cannot evict, structurally ----------------
	//
	// The lexical check is a shared-topic heuristic, not evidence. Governance
	// says only a measured fixture verdict may remove a rule, so "contradict
	// flags but never evicts" has to be a property of the code, not a habit.

	it("leaves every flagged rule untouched in the database", () => {
		const dbPath = process.env.TOKEN_WARDEN_DB as string;
		const db = openDb(dbPath);
		insertAuthoredRule(db, {
			agent: "sql",
			body: "Never read the whole file before editing.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});
		const before = listRulesByAgent(db, "sql");
		db.close();
		expect(before).toHaveLength(1);

		const file = join(dir, "CLAUDE.md");
		writeFileSync(file, "Always read the whole file before editing.\n");
		// Run it the two ways a user can, including the CI gate.
		expect(main(["--agent", "sql", "--file", file, "--gate"])).toBe(1);
		expect(main(["--file", file])).toBe(0);

		const after = openDb(dbPath);
		const rows = listRulesByAgent(after, "sql");
		after.close();
		// Same rows, same status, same probation, same everything: a flag is a
		// report, and reports do not mutate state.
		expect(rows).toEqual(before);
	});

	it("imports no state-mutating db API (guards against a future auto-evict)", () => {
		const source = readFileSync(
			new URL("../src/contradict.ts", import.meta.url),
			"utf8",
		);
		const importBlock = source.match(
			/import\s*\{([^}]*)\}\s*from\s*"\.\/db\.js"/,
		)?.[1];
		expect(importBlock).toBeDefined();
		const imported = (importBlock as string)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		// Read-only allowlist. Adding anything that writes a `rules` row — or a
		// raw `db.prepare`/`db.exec` escape hatch — must fail here first.
		expect(imported.sort()).toEqual(["getActiveRules", "openDb"]);
		expect(source).not.toMatch(/\bdb\.(prepare|exec|transaction)\b/);
		expect(source).not.toMatch(
			/\b(decideRule|insertRule|insertAuthoredRule|setRuleProbation|setRuleProtected|setRuleScope|bumpRulesetVersion|recordReceipt|upsertRun)\b/,
		);
	});
});
