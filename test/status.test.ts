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
import { verdictWithReason } from "../src/select.js";
import { pctChange, renderStatus, suiteComparison } from "../src/status.js";

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

	it("warns when benching with no collected real work", () => {
		expect(metaCost(500, 0)).toMatchObject({ ratio: null, warn: true });
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
