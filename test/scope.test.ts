import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileMemoryMd } from "../src/bench.js";
import {
	getRuleById,
	insertRule,
	openDb,
	setRuleScope,
	type WardenDb,
} from "../src/db.js";
import { parseScopeArgs, runScope } from "../src/scope.js";

describe("compileMemoryMd scope rendering", () => {
	it("prefixes a scoped rule with (when <scope>), leaves global rules plain", () => {
		const md = compileMemoryMd([
			{ body: "Global rule." },
			{ body: "Scoped rule.", scope: "Python files" },
		]);
		expect(md).toContain("- Global rule.");
		expect(md).toContain("- (when Python files) Scoped rule.");
	});
});

describe("parseScopeArgs", () => {
	it("requires a rule and a scope/clear for a mutation", () => {
		expect(() => parseScopeArgs(["--agent", "sql"])).toThrow(/--rule/);
		expect(() => parseScopeArgs(["--agent", "sql", "--rule", "1"])).toThrow(
			/--scope/,
		);
	});

	it("accepts --list without a rule and rejects a bad agent", () => {
		expect(parseScopeArgs(["--agent", "sql", "--list"]).list).toBe(true);
		expect(() => parseScopeArgs(["--agent", "nope", "--list"])).toThrow(
			/--agent/,
		);
	});

	it("parses a set and a clear", () => {
		expect(
			parseScopeArgs(["--agent", "sql", "--rule", "3", "--scope", "api/"]),
		).toMatchObject({ rule: 3, scope: "api/" });
		expect(
			parseScopeArgs(["--agent", "sql", "--rule", "3", "--clear"]).clear,
		).toBe(true);
	});
});

describe("runScope", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-scope-"));
		db = openDb(join(dir, "warden.db"));
		process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_MEMORY_DIR;
	});

	it("sets and clears a rule's scope, recompiling memory", () => {
		const id = insertRule(db, {
			agent: "sql",
			body: "A rule to scope.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});
		const set = runScope(db, {
			agent: "sql",
			rule: id,
			scope: "migration tasks",
			clear: false,
			list: false,
		});
		expect(set).toMatch(/applies only when: migration tasks/);
		expect(getRuleById(db, id)?.scope).toBe("migration tasks");

		runScope(db, {
			agent: "sql",
			rule: id,
			scope: null,
			clear: true,
			list: false,
		});
		expect(getRuleById(db, id)?.scope).toBeNull();
	});

	it("lists rules with their scope", () => {
		const id = insertRule(db, {
			agent: "sql",
			body: "Scoped one.",
			contextCost: 5,
			sourceRun: null,
			createdAt: "t",
		});
		setRuleScope(db, id, "Python");
		const out = runScope(db, {
			agent: "sql",
			rule: null,
			scope: null,
			clear: false,
			list: true,
		});
		expect(out).toContain("(when Python)");
	});

	it("rejects a rule that belongs to another agent", () => {
		const id = insertRule(db, {
			agent: "backend",
			body: "Backend rule.",
			contextCost: 5,
			sourceRun: null,
			createdAt: "t",
		});
		expect(() =>
			runScope(db, {
				agent: "sql",
				rule: id,
				scope: "x",
				clear: false,
				list: false,
			}),
		).toThrow(/no rule/);
	});
});
