import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuleRow } from "../src/db.js";
import {
	decideRule,
	type GoldenTaskTotal,
	insertAuthoredRule,
	insertRule,
	openDb,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import {
	main,
	parseHealthArgs,
	rankTaskVariance,
	renderHealth,
	renderVariance,
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
		replaces: null,
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

describe("rankTaskVariance", () => {
	const totals = (taskHash: string, values: number[]): GoldenTaskTotal[] =>
		values.map((total, i) => ({
			taskHash,
			total,
			ts: `2026-06-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`,
		}));

	it("ranks tasks by coefficient of variation, noisiest first", () => {
		const rows = [
			...totals("sql-01", [1000, 1005, 995]), // quiet
			...totals("sql-02", [1000, 2000, 500]), // loud
		];
		const ranked = rankTaskVariance(rows);
		expect(ranked.map((t) => t.taskId)).toEqual(["sql-02", "sql-01"]);
		expect(ranked[0]?.cv).toBeGreaterThan(0.25);
		expect(ranked[1]?.cv).toBeLessThan(0.05);
	});

	it("skips tasks with too few runs and caps the window at recent runs", () => {
		const rows = [
			...totals("sql-01", [1000, 1000]), // below minRuns
			...totals(
				"sql-02",
				Array.from({ length: 15 }, (_, i) => 1000 + i),
			),
		];
		const ranked = rankTaskVariance(rows);
		expect(ranked.map((t) => t.taskId)).toEqual(["sql-02"]);
		expect(ranked[0]?.n).toBe(10); // window cap
	});

	it("renders noisy tasks with the add-not-edit instruction, or an all-quiet line", () => {
		const noisy = rankTaskVariance([...totals("sql-02", [1000, 2000, 500])]);
		const out = renderVariance("sql", noisy);
		expect(out).toContain("noisy golden task(s)");
		expect(out).toContain("sql-02");
		expect(out).toContain("ADDING quieter task files");

		expect(renderVariance("sql", [])).toContain(
			"no golden task exceeds the 25%",
		);
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

	it("reports noisy golden tasks from active-set history without gating", () => {
		const db: WardenDb = openDb(process.env.TOKEN_WARDEN_DB as string);
		// Three active-config golden runs of sql-02 spread over a 3x range.
		const tokens = [1000, 2500, 400];
		tokens.forEach((inputTokens, i) => {
			upsertRun(db, {
				agent: "sql",
				sessionId: `golden-${i}`,
				taskHash: "sql-02",
				inputTokens,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: day(String(10 + i).padStart(2, "0")),
				config: "active",
			});
		});
		db.close();

		// Noise is informational: the gate stays green.
		expect(main(["--agent", "sql", "--gate"], NOW)).toBe(0);
		const out = vi
			.mocked(console.log)
			.mock.calls.map((c) => String(c[0]))
			.join("\n");
		expect(out).toContain("noisy golden task(s)");
		expect(out).toContain("sql-02");
	});
});
