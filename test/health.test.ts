import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decideRule,
	insertAuthoredRule,
	insertRule,
	openDb,
	type RuleRow,
} from "../src/db.js";
import {
	main,
	parseHealthArgs,
	renderHealth,
	staleRules,
} from "../src/health.js";

function rule(over: Partial<RuleRow>): RuleRow {
	return {
		id: 1,
		agent: "sql",
		body: "A rule.",
		status: "active",
		measured_delta: 100,
		context_cost: 10,
		source_run: null,
		decided_at: null,
		created_at: "2026-01-01T00:00:00.000Z",
		decided_reason: null,
		protected: 0,
		born_digest: null,
		scope: null,
		probation: 0,
		...over,
	};
}

const NOW = Date.parse("2026-06-29T00:00:00.000Z");
const day = (d: string) => `2026-06-${d}T00:00:00.000Z`;

describe("staleRules", () => {
	it("flags rules not decided within the threshold, freshest excluded", () => {
		const rules = [
			rule({ id: 1, decided_at: day("01") }), // 28 days ago — stale at 14
			rule({ id: 2, decided_at: day("28") }), // 1 day ago — fresh
		];
		const stale = staleRules(rules, NOW, 14);
		expect(stale.map((s) => s.id)).toEqual([1]);
		expect(stale[0]?.ageDays).toBeGreaterThan(14);
	});

	it("exempts protected rules (never re-audited by design)", () => {
		const rules = [rule({ id: 9, protected: 1, decided_at: day("01") })];
		expect(staleRules(rules, NOW, 14)).toHaveLength(0);
	});

	it("falls back to created_at when never decided", () => {
		const rules = [rule({ id: 3, decided_at: null, created_at: day("01") })];
		expect(staleRules(rules, NOW, 14)).toHaveLength(1);
	});
});

describe("renderHealth", () => {
	it("says all-clear with nothing stale", () => {
		expect(renderHealth("sql", [], 30)).toMatch(/all active rules re-audited/);
	});

	it("lists stale rules and notes they are not auto-evicted", () => {
		const out = renderHealth(
			"sql",
			[{ id: 1, body: "x", ageDays: 40, decidedAt: day("01") }],
			30,
		);
		expect(out).toContain("rule 1");
		expect(out).toMatch(/not auto-evicted/);
	});
});

describe("parseHealthArgs", () => {
	it("defaults to 30 days, parses --stale-after/--gate/--json", () => {
		expect(parseHealthArgs([]).staleAfterDays).toBe(30);
		const a = parseHealthArgs(["--stale-after", "60", "--gate", "--json"]);
		expect(a).toMatchObject({ staleAfterDays: 60, gate: true, json: true });
		expect(() => parseHealthArgs(["--stale-after", "-1"])).toThrow(/positive/);
		expect(() => parseHealthArgs(["--agent", "nope"])).toThrow(/--agent/);
	});
});

describe("health main()", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-health-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_DB;
	});

	it("--gate exits non-zero when a rule is stale, zero when fresh/protected", () => {
		const db = openDb(process.env.TOKEN_WARDEN_DB as string);
		const stale = insertRule(db, {
			agent: "sql",
			body: "An old efficiency rule.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, stale, "active", 100, "savings", day("01"));
		// Protected rule is old too but must be exempt.
		insertAuthoredRule(db, {
			agent: "sql",
			body: "Protected behavioral rule.",
			contextCost: 5,
			sourceRun: null,
			createdAt: day("01"),
		});
		db.close();

		expect(main(["--agent", "sql", "--stale-after", "14", "--gate"], NOW)).toBe(
			1,
		);
		// Far-future threshold → nothing stale → exit 0.
		expect(
			main(["--agent", "sql", "--stale-after", "9999", "--gate"], NOW),
		).toBe(0);
	});
});
