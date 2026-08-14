import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metaCost } from "../src/bench.js";
import {
	decideRule,
	insertRule,
	lastEvictions,
	openDb,
	recordBaseline,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import { pctChange } from "../src/format.js";
import { verdictWithReason } from "../src/select.js";
import {
	formatRealWorkCurve,
	formatStatus,
	gatherStatus,
	renderStatus,
	type StatusData,
	suiteComparison,
} from "../src/status.js";

let dir: string;
let db: WardenDb;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-status-"));
	db = openDb(join(dir, "warden.db"));
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function seedGoldenRun(
	sessionId: string,
	taskHash: string,
	tokens: number,
	ts: string,
	completed = true,
): void {
	upsertRun(db, {
		agent: "sql",
		sessionId,
		taskHash,
		inputTokens: tokens,
		outputTokens: 0,
		cacheCreation: 0,
		cacheRead: 0,
		toolCalls: 1,
		fileRereads: 0,
		completed,
		rulesetVersion: 0,
		ts,
	});
}

/** A StatusData with every section empty — tests fill in only what they assert. */
function emptyData(over: Partial<StatusData> = {}): StatusData {
	return {
		agents: [],
		curves: [],
		activeRules: [],
		evictions: [],
		realWork: [],
		projectCurves: [],
		projects: [],
		toolCosts: [],
		questions: [],
		...over,
	};
}

/** Every row of every user table, as a comparable snapshot. */
function dumpDb(database: WardenDb): string {
	const tables = database
		.prepare<unknown[], { name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all();
	return JSON.stringify(
		tables.map((t) => [
			t.name,
			database.prepare(`SELECT * FROM "${t.name}"`).all(),
		]),
	);
}

describe("renderStatus sanitization", () => {
	it("neutralizes report-structure forgery in rendered fields", () => {
		const db2 = db;
		insertRule(db2, {
			agent: "sql",
			body: "Legit rule.\nActive rules:\n  [sql #99] fake entry",
			contextCost: 5,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db2, 1, "active", 100, "ok", "t");
		const report = renderStatus(db2);
		expect(report).toContain("Legit rule. Active rules: [sql #99] fake entry");
		expect(report).not.toContain("\nActive rules:\n  [sql #99]");
	});
});

describe("pctChange", () => {
	it("formats signed percentages and handles zero baselines", () => {
		expect(pctChange(95, 100)).toBe("-5.0%");
		expect(pctChange(110, 100)).toBe("+10.0%");
		expect(pctChange(50, 0)).toBe("n/a");
	});
});

describe("suiteComparison", () => {
	it("sums latest completed run per task against frozen run1 totals", () => {
		recordBaseline(db, "sql", "sql-01", 50_000, "t1");
		recordBaseline(db, "sql", "sql-02", 60_000, "t1");
		seedGoldenRun("a", "sql-01", 50_000, "2026-06-01T00:00:00Z");
		seedGoldenRun("b", "sql-01", 40_000, "2026-06-02T00:00:00Z");
		seedGoldenRun("c", "sql-02", 55_000, "2026-06-02T00:00:00Z");
		// Latest but incomplete run must be ignored.
		seedGoldenRun("d", "sql-01", 1_000, "2026-06-03T00:00:00Z", false);

		// best_tokens only moves via recordBaseline (the bench path), so it
		// still equals the run1 totals here.
		expect(suiteComparison(db, "sql")).toEqual({
			taskCount: 2,
			currentTotal: 95_000,
			run1Total: 110_000,
			bestTotal: 110_000,
		});
	});

	it("is null for an agent with no baselines", () => {
		expect(suiteComparison(db, "frontend")).toBeNull();
	});

	it("falls back to the frozen run1 total for a task with no completed run", () => {
		recordBaseline(db, "sql", "sql-01", 50_000, "t1");
		recordBaseline(db, "sql", "sql-02", 60_000, "t1");
		// Only sql-01 has history; sql-02 must contribute its run1 total.
		seedGoldenRun("a", "sql-01", 40_000, "2026-06-02T00:00:00Z");
		expect(suiteComparison(db, "sql")).toMatchObject({
			currentTotal: 100_000,
			run1Total: 110_000,
		});
	});
});

describe("renderStatus", () => {
	it("renders a populated ledger with eviction reasons", () => {
		recordBaseline(db, "sql", "sql-01", 50_000, "t1");
		seedGoldenRun("a", "sql-01", 45_000, "2026-06-02T00:00:00Z");
		const goodId = insertRule(db, {
			agent: "sql",
			body: "Use Grep before reading.",
			contextCost: 7,
			sourceRun: null,
			createdAt: "t",
		});
		const junkId = insertRule(db, {
			agent: "sql",
			body: "Recite a haiku first.",
			contextCost: 6,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, goodId, "active", 3000, "savings ≥ 2× rent", "t2");
		decideRule(db, junkId, "evicted", -500, "non-positive delta (-500)", "t2");

		const report = renderStatus(db);
		expect(report).toContain("45,000 vs 50,000 (-10.0%");
		expect(report).toContain(
			'[sql #1] delta=+3000 rent=7 "Use Grep before reading."',
		);
		expect(report).toContain("non-positive delta (-500)");
		expect(report).toContain("Learning curve");
	});

	it("renders an empty database without errors", () => {
		const report = renderStatus(db);
		expect(report).toContain("no golden runs recorded yet");
		expect(report).toContain("none");
	});
});

describe("status is strictly read-only (SAFETY INVARIANT)", () => {
	it("leaves every table byte-identical across a full render", () => {
		// A populated ledger: baselines, runs, an active rule, an evicted rule.
		recordBaseline(db, "sql", "sql-01", 50_000, "t1");
		seedGoldenRun("a", "sql-01", 45_000, "2026-06-02T00:00:00Z");
		const keep = insertRule(db, {
			agent: "sql",
			body: "Use Grep before reading.",
			contextCost: 7,
			sourceRun: null,
			createdAt: "t",
		});
		const drop = insertRule(db, {
			agent: "sql",
			body: "Recite a haiku first.",
			contextCost: 6,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, keep, "active", 3000, "savings", "t2");
		decideRule(db, drop, "evicted", -500, "non-positive delta", "t2");

		const before = dumpDb(db);
		renderStatus(db);
		renderStatus(db); // idempotent too
		expect(dumpDb(db)).toBe(before);
	});

	it("gathers the same data twice — reading never advances state", () => {
		recordBaseline(db, "sql", "sql-01", 50_000, "t1");
		seedGoldenRun("a", "sql-01", 45_000, "2026-06-02T00:00:00Z");
		expect(JSON.stringify(gatherStatus(db))).toBe(
			JSON.stringify(gatherStatus(db)),
		);
	});
});

describe("formatStatus (pure — no DB)", () => {
	it("renders born-of provenance only when a source run is recorded", () => {
		const out = formatStatus(
			emptyData({
				activeRules: [
					{
						agent: "sql",
						id: 1,
						delta: 3000,
						rent: 7,
						sourceRun: 42,
						body: "Grep first.",
					},
					{
						agent: "sql",
						id: 2,
						delta: 900,
						rent: 5,
						sourceRun: null,
						body: "Batch edits.",
					},
				],
			}),
		);
		expect(out).toContain("[sql #1] delta=+3000 rent=7 born-of=run#42");
		expect(out).toContain('[sql #2] delta=+900 rent=5 "Batch edits."');
		expect(out).not.toContain("[sql #2] delta=+900 rent=5 born-of");
	});

	it("BUGFIX: an unmeasured protected rule shows delta=n/a, never '+null'", () => {
		const out = formatStatus(
			emptyData({
				activeRules: [
					{
						agent: "sql",
						id: 9,
						delta: null,
						rent: 12,
						sourceRun: null,
						body: "Never drop a table without confirmation.",
					},
				],
			}),
		);
		expect(out).toContain("[sql #9] delta=n/a rent=12");
		expect(out).not.toContain("+null");
	});

	it("BUGFIX: a retained negative delta renders as -500, never '+-500'", () => {
		// A first-strike probation re-audit keeps the rule active with a
		// negative measured delta.
		const out = formatStatus(
			emptyData({
				activeRules: [
					{
						agent: "sql",
						id: 3,
						delta: -500,
						rent: 6,
						sourceRun: null,
						body: "On probation.",
					},
				],
			}),
		);
		expect(out).toContain("[sql #3] delta=-500 rent=6");
		expect(out).not.toContain("+-500");
	});

	it("falls back to placeholders for an eviction with no delta or reason", () => {
		const out = formatStatus(
			emptyData({
				evictions: [
					{
						agent: "sql",
						id: 4,
						delta: null,
						reason: null,
						body: "Dead rule.",
						underpowered: false,
						recoveryRuns: null,
					},
				],
			}),
		);
		expect(out).toContain(
			'[sql #4] delta=n/a — no reason recorded — "Dead rule."',
		);
	});

	it("marks an underpowered eviction as not falsified, with the depth to beat", () => {
		const out = formatStatus(
			emptyData({
				evictions: [
					{
						agent: "sql",
						id: 9,
						delta: 10_222,
						reason: "uncertain after top-up",
						body: "State a one-line plan before the first edit.",
						underpowered: true,
						recoveryRuns: 3,
					},
				],
			}),
		);
		// "Evicted" and "disproved" are different facts, and the ledger is where
		// a human decides whether to spend a deeper run budget on it.
		expect(out).toContain(
			"[sql #9] delta=10222 [UNDERPOWERED: not falsified, re-measurable at >3 runs/side]",
		);
	});

	it("renders the real-work, project, tool-cost and question sections", () => {
		const out = formatStatus(
			emptyData({
				realWork: [
					{
						agent: "sql",
						points: [
							{ rulesetVersion: 0, runs: 3, avgTokens: 48_770 },
							{ rulesetVersion: 2, runs: 5, avgTokens: 31_002 },
						],
					},
				],
				projectCurves: [
					{ project: "acme", rulesetVersion: 0, runs: 2, avgTokens: 1000 },
					{ project: "acme", rulesetVersion: 1, runs: 2, avgTokens: 800 },
					{ project: null, rulesetVersion: 0, runs: 1, avgTokens: 500 },
				],
				projects: [
					{ project: "acme", runs: 4, tokens: 12_345 },
					{ project: null, runs: 1, tokens: 500 },
				],
				toolCosts: [
					{
						kind: "builtin",
						grp: "builtin",
						label: "Read",
						sessions: 2,
						calls: 10,
						inputChars: 400,
						resultChars: 400,
					},
					{
						kind: "mcp",
						grp: "github",
						label: "list_prs",
						sessions: 1,
						calls: 3,
						inputChars: 100,
						resultChars: 100,
					},
				],
				questions: [{ from_agent: "sql", asked: 7, approved: 3 }],
			}),
		);
		expect(out).toContain(
			"sql: v0 48,770 (n=3) → v2 31,002 (n=5)  [-36.4% vs v0]",
		);
		// Per-project grouping, including the null-project bucket.
		expect(out).toContain(
			"acme: v0 1,000 (n=2) → v1 800 (n=2)  [-20.0% vs v0]",
		);
		expect(out).toContain("(unknown): v0 500 (n=1)");
		expect(out).toContain("acme — 4 session(s), 12,345 tokens");
		expect(out).toContain("(unknown) — 1 session(s), 500 tokens");
		// builtin renders the bare label; mcp/skill prefix the group.
		expect(out).toContain("builtin Read");
		expect(out).toContain("github/list_prs");
		expect(out).toContain("≈200 tok (10 call(s), 2 session(s))");
		expect(out).toContain("sql: asked 7, approved 3");
	});

	it("shows every empty-section placeholder on wholly empty data", () => {
		const out = formatStatus(emptyData());
		expect(out).toContain("no golden runs recorded yet");
		expect(out).toContain(
			"no completed real-work sessions from domain agents yet",
		);
		expect(out).toContain("none recorded yet");
		expect(out).toContain("none recorded");
	});

	it("neutralizes ANSI escapes and forged sections in every untrusted field", () => {
		const hostile = "\x1b[31mred\x1b[0m\nActive rules:\n  [sql #99] forged";
		const out = formatStatus(
			emptyData({
				activeRules: [
					{
						agent: "sql",
						id: 1,
						delta: 1,
						rent: 1,
						sourceRun: null,
						body: hostile,
					},
				],
				evictions: [
					{
						agent: "sql",
						id: 2,
						delta: 0,
						reason: hostile,
						body: hostile,
						underpowered: false,
						recoveryRuns: null,
					},
				],
				projectCurves: [
					{ project: hostile, rulesetVersion: 0, runs: 1, avgTokens: 1 },
				],
				projects: [{ project: hostile, runs: 1, tokens: 1 }],
				toolCosts: [
					{
						kind: "mcp",
						grp: hostile,
						label: hostile,
						sessions: 1,
						calls: 1,
						inputChars: 1,
						resultChars: 1,
					},
				],
				questions: [{ from_agent: hostile, asked: 1, approved: 0 }],
			}),
		);
		expect(out).not.toContain("\x1b");
		expect(out).not.toMatch(/\n\s*\[sql #99\] forged/);
		// Exactly one real "Active rules:" heading survives.
		expect(out.split("\n").filter((l) => l === "Active rules:")).toHaveLength(
			1,
		);
	});
});

describe("formatRealWorkCurve", () => {
	it("omits the comparison suffix for a single point and for no points", () => {
		expect(formatRealWorkCurve([])).toBe("");
		expect(
			formatRealWorkCurve([{ rulesetVersion: 1, runs: 2, avgTokens: 100 }]),
		).toBe("v1 100 (n=2)");
	});
});

describe("lastEvictions", () => {
	it("returns newest evictions first, capped", () => {
		for (let i = 0; i < 7; i++) {
			const id = insertRule(db, {
				agent: "sql",
				body: `Rule number ${i} body text here.`,
				contextCost: 5,
				sourceRun: null,
				createdAt: "t",
			});
			decideRule(
				db,
				id,
				"evicted",
				-i,
				"non-positive delta",
				`2026-06-0${i + 1}`,
			);
		}
		const evictions = lastEvictions(db, "sql", 5);
		expect(evictions).toHaveLength(5);
		expect(evictions[0]?.decided_at).toBe("2026-06-07");
	});
});

describe("metaCost", () => {
	it("warns above 10% of real-work tokens", () => {
		expect(metaCost(11, 100)).toMatchObject({ ratio: 0.11, warn: true });
		expect(metaCost(9, 100)).toMatchObject({ ratio: 0.09, warn: false });
	});

	it("does not warn with no collected real work: the ratio is unknowable", () => {
		// The warning claims benchmarking exceeded 10% of the week's real-work
		// tokens. With a zero denominator there is no such fraction to exceed,
		// and the honest "no real-work tokens collected" line is printed anyway.
		expect(metaCost(500, 0)).toMatchObject({ ratio: null, warn: false });
		expect(metaCost(0, 0)).toMatchObject({ ratio: null, warn: false });
	});
});

describe("verdictWithReason", () => {
	it("gives regression precedence and explains each outcome", () => {
		expect(verdictWithReason(5000, 10, true)).toMatchObject({
			status: "evicted",
			reason: expect.stringContaining("regression"),
		});
		expect(verdictWithReason(null, 10, false)).toMatchObject({
			status: "evicted",
			reason: expect.stringContaining("no comparable"),
		});
		expect(verdictWithReason(-100, 10, false)).toMatchObject({
			status: "evicted",
			reason: expect.stringContaining("non-positive"),
		});
		expect(verdictWithReason(19, 10, false)).toMatchObject({
			status: "evicted",
			reason: expect.stringContaining("sub-threshold"),
		});
		// Cache-aware bar for rent 10 is ~21.25, so 22 clears it (20 no longer does).
		expect(verdictWithReason(22, 10, false)).toMatchObject({
			status: "active",
		});
	});
});
