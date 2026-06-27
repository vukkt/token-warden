import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agentCosts,
	computeRuleCost,
	main,
	parseCostArgs,
	projectAgent,
	renderCosts,
	renderProjection,
} from "../src/cost.js";
import {
	decideRule,
	insertRule,
	openDb,
	recordReceipt,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import { priceFor } from "../src/pricing.js";

function seedReceipt(
	db: WardenDb,
	ruleId: number,
	overrides: Partial<Parameters<typeof recordReceipt>[1]> = {},
): void {
	recordReceipt(db, {
		ruleId,
		agent: "sql",
		decidedAt: "2026-06-24T00:00:00.000Z",
		status: "active",
		kind: "candidate",
		reason: "savings",
		model: "claude-sonnet-4-6",
		fixtureHash: "abc",
		runs: 6,
		delta: 10_000,
		contextCost: 20,
		standardError: 100,
		regression: false,
		withTokens: 50_000,
		withoutTokens: 60_000,
		withToolCalls: 0,
		withoutToolCalls: 0,
		withFileRereads: 0,
		withoutFileRereads: 0,
		tasksTotal: 5,
		tasksPassedWith: 5,
		tasksPassedWithout: 5,
		...overrides,
	});
}

describe("computeRuleCost", () => {
	it("translates a token receipt into per-session and weekly dollars", () => {
		const price = priceFor("claude-sonnet-4-6"); // input $3/MTok
		const blendedPerToken = 3 / 1_000_000; // all-input blend
		const receipt = {
			rule_id: 1,
			body: "Grep before reading.",
			model: "claude-sonnet-4-6",
			delta: 10_000,
			context_cost: 20,
			runs: 6,
			with_tokens: 50_000,
			without_tokens: 60_000,
		} as Parameters<typeof computeRuleCost>[0];
		const c = computeRuleCost(receipt, price, blendedPerToken, 20);
		expect(c.savingsDollars).toBeCloseTo(0.03, 6); // 10k × $3/MTok
		expect(c.rentDollars).toBeCloseTo(0.00006, 8); // 20 × $3/MTok
		expect(c.netDollars).toBeCloseTo(0.02994, 6);
		expect(c.weeklyDollars).toBeCloseTo(0.5988, 4);
		// discovery = 6 × (50k+60k) = 660k tokens × $3/MTok = $1.98
		expect(c.discoveryDollars).toBeCloseTo(1.98, 4);
		expect(c.breakEvenSessions).toBe(67); // ceil(1.98 / 0.02994)
	});

	it("reports no break-even when the rule is net-negative", () => {
		const price = priceFor("claude-sonnet-4-6");
		const receipt = {
			rule_id: 2,
			body: "Barely-saving rule.",
			model: "claude-sonnet-4-6",
			delta: 1,
			context_cost: 1_000_000, // absurd rent dwarfs the saving
			runs: 2,
			with_tokens: 1000,
			without_tokens: 1000,
		} as Parameters<typeof computeRuleCost>[0];
		const c = computeRuleCost(receipt, price, 3 / 1_000_000, 20);
		expect(c.netDollars).toBeLessThan(0);
		expect(c.breakEvenSessions).toBeNull();
	});
});

describe("agentCosts (db-backed)", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-cost-"));
		db = openDb(join(dir, "warden.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("prices each active rule and skips evicted ones", () => {
		const active = insertRule(db, {
			agent: "sql",
			body: "An active, earning rule.",
			contextCost: 20,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, active, "active", 10_000, "savings", "t");
		seedReceipt(db, active);

		const evicted = insertRule(db, {
			agent: "sql",
			body: "An evicted rule.",
			contextCost: 20,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, evicted, "evicted", 5, "sub-threshold", "t");
		seedReceipt(db, evicted, { ruleId: evicted, delta: 5 });

		// A real-work run to give the agent a token mix (mostly cache-read → cheap).
		upsertRun(db, {
			agent: "sql",
			sessionId: "s1",
			taskHash: null,
			inputTokens: 1000,
			outputTokens: 200,
			cacheCreation: 0,
			cacheRead: 50_000,
			toolCalls: 1,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 1,
			ts: "t",
			config: "real",
		});

		const costs = agentCosts(db, "sql");
		expect(costs).toHaveLength(1);
		expect(costs[0]?.ruleId).toBe(active);
		expect(costs[0]?.savingsDollars).toBeGreaterThan(0);
	});

	it("returns nothing when there are no active rules", () => {
		expect(agentCosts(db, "sql")).toEqual([]);
	});

	it("projects savings, operating cost, and a with/without comparison", () => {
		const id = insertRule(db, {
			agent: "sql",
			body: "An active, earning rule.",
			contextCost: 20,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, id, "active", 10_000, "savings", "t");
		seedReceipt(db, id);
		// One real-work session establishes the without-plugin baseline.
		upsertRun(db, {
			agent: "sql",
			sessionId: "s1",
			taskHash: null,
			inputTokens: 1000,
			outputTokens: 200,
			cacheCreation: 0,
			cacheRead: 50_000,
			toolCalls: 1,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 1,
			ts: "t",
			config: "real",
		});

		const p = projectAgent(db, "sql", 13, 20);
		expect(p.horizonSessions).toBe(260); // 13 × 20
		expect(p.rules).toBe(1);
		expect(p.netBenefit).toBeGreaterThan(0);
		expect(p.operatingCost).toBeGreaterThan(0);
		expect(p.breakEvenSessions).toBeGreaterThan(0);
		expect(p.baselineCost).not.toBeNull();
		expect(p.withPluginCost ?? 0).toBeLessThan(p.baselineCost ?? 0);
		expect(p.pctSaved ?? 0).toBeGreaterThan(0);
		expect(p.pctSaved ?? 1).toBeLessThan(1);
	});

	it("projects a null baseline when there are no real-work runs", () => {
		const id = insertRule(db, {
			agent: "sql",
			body: "Active rule, no real-work history.",
			contextCost: 20,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, id, "active", 10_000, "savings", "t");
		seedReceipt(db, id);
		const p = projectAgent(db, "sql", 13, 20);
		expect(p.baselineCost).toBeNull();
		expect(p.withPluginCost).toBeNull();
		expect(p.netBenefit).toBeGreaterThan(0); // savings still computed
	});
});

describe("renderCosts / parseCostArgs", () => {
	it("renders a dollars report with a break-even and weekly total", () => {
		const out = renderCosts("sql", [
			{
				ruleId: 1,
				body: "x",
				model: "claude-sonnet-4-6",
				rentTokens: 20,
				deltaTokens: 10_000,
				rentDollars: 0.00006,
				savingsDollars: 0.03,
				netDollars: 0.02994,
				weeklyDollars: 0.5988,
				discoveryDollars: 1.98,
				breakEvenSessions: 67,
			},
		]);
		expect(out).toContain("net $0.03/session");
		expect(out).toContain("67 sessions");
		expect(out).toMatch(/net savings: \$0\.60\/week/);
	});

	it("says all-clear with no priced rules", () => {
		expect(renderCosts("sql", [])).toMatch(/no active rules/);
	});

	it("parses --agent and --json, rejects a bad agent", () => {
		expect(parseCostArgs(["--json"]).json).toBe(true);
		expect(parseCostArgs(["--agent", "sql"]).agent).toBe("sql");
		expect(() => parseCostArgs(["--agent", "nope"])).toThrow(/--agent/);
	});

	it("parses projection flags (--project, --months, --sessions-per-week)", () => {
		expect(parseCostArgs(["--project"]).weeks).toBe(13); // ~3 months default
		const m = parseCostArgs(["--months", "6"]);
		expect(m.project).toBe(true);
		expect(m.weeks).toBe(Math.round(6 * 4.345)); // 26
		const s = parseCostArgs(["--sessions-per-week", "40"]);
		expect(s.project).toBe(true);
		expect(s.sessionsPerWeek).toBe(40);
		expect(() => parseCostArgs(["--weeks", "-1"])).toThrow(/positive/);
	});

	it("renders a projection with a with/without comparison", () => {
		const out = renderProjection({
			agent: "sql",
			weeks: 13,
			sessionsPerWeek: 20,
			horizonSessions: 260,
			rules: 1,
			netPerSession: 0.004,
			grossSavings: 1.07,
			operatingCost: 0.27,
			netBenefit: 0.78,
			breakEvenSessions: 67,
			baselineCost: 5.46,
			withPluginCost: 4.68,
			pctSaved: 0.143,
		});
		expect(out).toMatch(/~3\.0 months/);
		expect(out).toContain("NET benefit: $0.78");
		expect(out).toContain("WITHOUT plugin: $5.46");
		expect(out).toContain("14.3% cheaper");
	});
});

describe("cost main()", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-cost-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_DB;
	});

	it("returns 0 for both text and json output", () => {
		expect(main(["--agent", "sql"])).toBe(0);
		expect(main(["--agent", "sql", "--json"])).toBe(0);
	});

	it("returns 0 for projection output", () => {
		expect(main(["--agent", "sql", "--project"])).toBe(0);
		expect(main(["--agent", "sql", "--months", "3", "--json"])).toBe(0);
	});
});
