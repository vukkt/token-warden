import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getActiveRules,
	getRuleById,
	insertAuthoredRule,
	insertRule,
	oldestDecidedActiveRule,
	openDb,
	setRuleProtected,
	type WardenDb,
} from "../src/db.js";
import { main, parseProtectArgs, runProtect } from "../src/protect.js";

describe("parseProtectArgs", () => {
	it("requires exactly one action", () => {
		expect(() => parseProtectArgs(["--agent", "sql"])).toThrow(/exactly one/);
		expect(() =>
			parseProtectArgs(["--agent", "sql", "--add", "x", "--list"]),
		).toThrow(/exactly one/);
	});

	it("rejects an unknown agent and a non-integer id", () => {
		expect(() => parseProtectArgs(["--agent", "nope", "--list"])).toThrow(
			/--agent/,
		);
		expect(() =>
			parseProtectArgs(["--agent", "sql", "--protect", "x"]),
		).toThrow(/integer/);
	});

	it("rejects an unknown flag and a blank rule body", () => {
		expect(() => parseProtectArgs(["--agent", "sql", "--bogus"])).toThrow(
			/unknown flag: --bogus/,
		);
		expect(() => parseProtectArgs(["--agent", "sql", "--add", "   "])).toThrow(
			/non-empty rule body/,
		);
	});

	it("parses a valid add", () => {
		const args = parseProtectArgs(["--agent", "sql", "--add", "Be careful."]);
		expect(args).toMatchObject({ agent: "sql", add: "Be careful." });
	});
});

describe("authored / protected rules in the db", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-protect-"));
		db = openDb(join(dir, "warden.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("inserts an authored rule directly as active and protected", () => {
		const id = insertAuthoredRule(db, {
			agent: "sql",
			body: "Never drop a table without confirmation.",
			contextCost: 12,
			sourceRun: null,
			createdAt: "t",
		});
		const rule = getRuleById(db, id);
		expect(rule?.status).toBe("active");
		expect(rule?.protected).toBe(1);
		// Compiled into memory like any active rule.
		expect(getActiveRules(db, "sql").map((r) => r.id)).toContain(id);
	});

	it("never makes a protected rule the re-audit target", () => {
		const normal = insertRule(db, {
			agent: "sql",
			body: "A normal distilled efficiency rule body.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t1",
		});
		// Promote the normal rule so both are active.
		setRuleProtected(db, normal, false); // status -> active
		insertAuthoredRule(db, {
			agent: "sql",
			body: "Protected behavioral rule.",
			contextCost: 8,
			sourceRun: null,
			createdAt: "t0", // older decided_at — would be picked first if eligible
		});
		const target = oldestDecidedActiveRule(db, "sql");
		expect(target?.id).toBe(normal); // the protected (older) rule is skipped
		expect(target?.protected).toBe(0);
	});

	it("toggles protection and reactivates an evicted rule when protected", () => {
		const id = insertRule(db, {
			agent: "sql",
			body: "An efficiency rule that got token-evicted.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});
		setRuleProtected(db, id, true);
		expect(getRuleById(db, id)?.protected).toBe(1);
		expect(getRuleById(db, id)?.status).toBe("active");
		setRuleProtected(db, id, false);
		expect(getRuleById(db, id)?.protected).toBe(0);
	});
});

describe("runProtect", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-protect-run-"));
		db = openDb(join(dir, "warden.db"));
		process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_MEMORY_DIR;
	});

	it("adds a protected rule and compiles it into memory", () => {
		const out = runProtect(db, {
			agent: "sql",
			add: "Never run destructive SQL without a dry run.",
			protect: null,
			unprotect: null,
			list: false,
		});
		expect(out).toMatch(/Added protected rule/);
		const active = getActiveRules(db, "sql");
		expect(active).toHaveLength(1);
		expect(active[0]?.protected).toBe(1);
	});

	it("lists rules with their protected flag", () => {
		insertAuthoredRule(db, {
			agent: "sql",
			body: "Protected one.",
			contextCost: 5,
			sourceRun: null,
			createdAt: "t",
		});
		const out = runProtect(db, {
			agent: "sql",
			add: null,
			protect: null,
			unprotect: null,
			list: true,
		});
		expect(out).toContain("[PROTECTED]");
	});

	it("protects and unprotects a rule through the CLI action", () => {
		const id = insertRule(db, {
			agent: "sql",
			body: "A distilled rule worth pinning.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});

		const protectedOut = runProtect(db, {
			agent: "sql",
			add: null,
			protect: id,
			unprotect: null,
			list: false,
		});
		expect(protectedOut).toContain(`Rule ${id} is now PROTECTED`);
		expect(getRuleById(db, id)).toMatchObject({
			protected: 1,
			status: "active",
		});

		const unprotectedOut = runProtect(db, {
			agent: "sql",
			add: null,
			protect: null,
			unprotect: id,
			list: false,
		});
		expect(unprotectedOut).toContain(`Rule ${id} is no longer protected`);
		expect(getRuleById(db, id)?.protected).toBe(0);
	});

	it("rejects protecting a rule that belongs to another agent", () => {
		const id = insertRule(db, {
			agent: "backend",
			body: "Backend rule body here.",
			contextCost: 5,
			sourceRun: null,
			createdAt: "t",
		});
		expect(() =>
			runProtect(db, {
				agent: "sql",
				add: null,
				protect: id,
				unprotect: null,
				list: false,
			}),
		).toThrow(/no rule/);
	});
});

describe("protect main()", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-protect-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_DB;
		delete process.env.TOKEN_WARDEN_MEMORY_DIR;
	});

	it("adds a protected rule end to end and returns 0", () => {
		expect(main(["--agent", "sql", "--add", "Never delete prod data."])).toBe(
			0,
		);
		const db = openDb(process.env.TOKEN_WARDEN_DB as string);
		expect(getActiveRules(db, "sql")[0]?.protected).toBe(1);
		db.close();
	});
});
