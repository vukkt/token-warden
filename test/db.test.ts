import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	candidateCounts,
	decideRule,
	getRuleById,
	getRunBySession,
	goldenReplicateRuns,
	insertQuestion,
	insertRule,
	listCandidates,
	MIGRATION_COUNT,
	type NewRun,
	oldestDecidedActiveRule,
	openDb,
	recentEvictedRules,
	recentQuestionsFrom,
	setRuleProbation,
	upsertRun,
	type WardenDb,
} from "../src/db.js";

let dir: string;
let db: WardenDb;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-db-"));
	db = openDb(join(dir, "warden.db"));
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function makeRun(overrides: Partial<NewRun> = {}): NewRun {
	return {
		agent: "main",
		sessionId: "s1",
		taskHash: null,
		inputTokens: 100,
		outputTokens: 50,
		cacheCreation: 10,
		cacheRead: 20,
		toolCalls: 3,
		fileRereads: 1,
		completed: true,
		rulesetVersion: 0,
		ts: "2026-06-11T00:00:00.000Z",
		...overrides,
	};
}

describe("openDb / migrations", () => {
	it("creates all tables and stamps user_version", () => {
		expect(db.pragma("user_version", { simple: true })).toBe(MIGRATION_COUNT);
		const tables = db
			.prepare<[], { name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		expect(tables).toEqual(
			expect.arrayContaining([
				"runs",
				"rules",
				"baselines",
				"ruleset_versions",
			]),
		);
	});

	it("is idempotent: reopening an existing db does not re-run migrations", () => {
		upsertRun(db, makeRun());
		db.close();
		db = openDb(join(dir, "warden.db"));
		expect(db.pragma("user_version", { simple: true })).toBe(MIGRATION_COUNT);
		expect(getRunBySession(db, "s1")).toBeDefined();
	});

	it("creates the hot-path indexes for runs and rules lookups", () => {
		const indexes = db
			.prepare<[], { name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		expect(indexes).toEqual(
			expect.arrayContaining(["idx_runs_agent_task", "idx_rules_agent_status"]),
		);
	});

	it("pins WAL + synchronous=NORMAL so hook writes stay within budget", () => {
		expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
		// 1 = NORMAL.
		expect(db.pragma("synchronous", { simple: true })).toBe(1);
	});
});

describe("upsertRun", () => {
	it("inserts a row and returns its id", () => {
		const id = upsertRun(db, makeRun());
		const row = getRunBySession(db, "s1");
		expect(row?.id).toBe(id);
		expect(row).toMatchObject({
			agent: "main",
			input_tokens: 100,
			output_tokens: 50,
			completed: 1,
			task_hash: null,
		});
	});

	it("is idempotent on session_id: same session updates in place", () => {
		const firstId = upsertRun(db, makeRun());
		const secondId = upsertRun(
			db,
			makeRun({ inputTokens: 999, completed: false }),
		);
		expect(secondId).toBe(firstId);
		const count = db
			.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs")
			.get();
		expect(count?.n).toBe(1);
		const row = getRunBySession(db, "s1");
		expect(row?.input_tokens).toBe(999);
		expect(row?.completed).toBe(0);
	});

	it("creates separate rows for distinct sessions", () => {
		upsertRun(db, makeRun({ sessionId: "s1" }));
		upsertRun(db, makeRun({ sessionId: "s2", agent: "backend" }));
		const count = db
			.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs")
			.get();
		expect(count?.n).toBe(2);
		expect(getRunBySession(db, "s2")?.agent).toBe("backend");
	});

	it("round-trips duration_ms and defaults it to null", () => {
		upsertRun(db, makeRun({ sessionId: "s1" }));
		expect(getRunBySession(db, "s1")?.duration_ms).toBeNull();
		upsertRun(db, makeRun({ sessionId: "s2", durationMs: 42_000 }));
		expect(getRunBySession(db, "s2")?.duration_ms).toBe(42_000);
	});
});

describe("rule queue ordering", () => {
	function seedRule(body: string, createdAt: string): number {
		return insertRule(db, {
			agent: "sql",
			body,
			contextCost: 8,
			sourceRun: null,
			createdAt,
		});
	}

	it("listCandidates returns oldest first, capped", () => {
		const ids = [
			seedRule("Rule body number one here.", "2026-06-03"),
			seedRule("Rule body number two here.", "2026-06-01"),
			seedRule("Rule body number three here.", "2026-06-02"),
			seedRule("Rule body number four here.", "2026-06-04"),
		];
		const picked = listCandidates(db, "sql", 3).map((r) => r.id);
		expect(picked).toEqual([ids[1], ids[2], ids[0]]);
	});

	it("oldestDecidedActiveRule round-robins by decided_at", () => {
		const first = seedRule("Rule body number one here.", "t");
		const second = seedRule("Rule body number two here.", "t");
		decideRule(db, first, "active", 100, "ok", "2026-06-02");
		decideRule(db, second, "active", 100, "ok", "2026-06-01");
		expect(oldestDecidedActiveRule(db, "sql")?.id).toBe(second);
	});

	it("setRuleProbation round-trips and defaults to 0", () => {
		const id = seedRule("Rule body number one here.", "t");
		expect(getRuleById(db, id)?.probation).toBe(0);
		setRuleProbation(db, id, true);
		expect(getRuleById(db, id)?.probation).toBe(1);
		setRuleProbation(db, id, false);
		expect(getRuleById(db, id)?.probation).toBe(0);
	});

	it("recentEvictedRules returns newest-decided first, capped, evicted-only", () => {
		const a = seedRule("Rule body number one here.", "t");
		const b = seedRule("Rule body number two here.", "t");
		const c = seedRule("Rule body number three here.", "t");
		const d = seedRule("Rule body number four here.", "t");
		decideRule(db, a, "evicted", -50, "non-positive delta (-50)", "2026-06-01");
		decideRule(db, b, "active", 900, "ok", "2026-06-02");
		decideRule(db, c, "evicted", 5, "sub-threshold", "2026-06-03");
		decideRule(db, d, "evicted", null, "no comparable runs", "2026-06-02");

		const recent = recentEvictedRules(db, "sql", 2);
		expect(recent.map((r) => r.body)).toEqual([
			"Rule body number three here.",
			"Rule body number four here.",
		]);
		expect(recent[0]).toMatchObject({
			measured_delta: 5,
			decided_reason: "sub-threshold",
		});
		// Other agents' evictions are invisible.
		expect(recentEvictedRules(db, "backend", 5)).toHaveLength(0);
	});

	it("goldenReplicateRuns returns completed active-set runs keyed for replicate grouping", () => {
		const base: Omit<NewRun, "sessionId" | "ts"> = {
			agent: "sql",
			taskHash: "sql-01",
			inputTokens: 1000,
			outputTokens: 0,
			cacheCreation: 0,
			cacheRead: 0,
			toolCalls: 1,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 2,
			config: "active",
		};
		upsertRun(db, { ...base, sessionId: "g1", ts: "2026-06-01" });
		upsertRun(db, {
			...base,
			sessionId: "g2",
			ts: "2026-06-02",
			inputTokens: 1200,
		});
		// Different ruleset version: a separate replicate group, same task.
		upsertRun(db, {
			...base,
			sessionId: "g3",
			ts: "2026-06-03",
			rulesetVersion: 3,
		});
		// Excluded: incomplete, non-active config, real work (null task).
		upsertRun(db, {
			...base,
			sessionId: "g4",
			ts: "2026-06-04",
			completed: false,
		});
		upsertRun(db, {
			...base,
			sessionId: "g5",
			ts: "2026-06-05",
			config: "candidate",
		});
		upsertRun(db, {
			...base,
			sessionId: "g6",
			ts: "2026-06-06",
			taskHash: null,
			config: "real",
		});

		const rows = goldenReplicateRuns(db, "sql");
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.total)).toEqual([1000, 1200, 1000]);
		expect(rows.map((r) => r.rulesetVersion)).toEqual([2, 2, 3]);
		expect(rows.every((r) => r.taskHash === "sql-01")).toBe(true);
		expect(rows.every((r) => r.model === "")).toBe(true);
		expect(goldenReplicateRuns(db, "backend")).toHaveLength(0);
	});

	it("candidateCounts groups pending candidates per agent, largest first", () => {
		seedRule("Rule body number one here.", "t");
		seedRule("Rule body number two here.", "t");
		const decided = seedRule("Rule body number three here.", "t");
		decideRule(db, decided, "active", 100, "ok", "2026-06-01");
		insertRule(db, {
			agent: "backend",
			body: "A backend candidate rule body.",
			contextCost: 8,
			sourceRun: null,
			createdAt: "t",
		});

		expect(candidateCounts(db)).toEqual([
			{ agent: "sql", pending: 2 },
			{ agent: "backend", pending: 1 },
		]);
	});
});

describe("questions", () => {
	it("recentQuestionsFrom returns newest question bodies first, capped", () => {
		insertQuestion(db, "frontend", "backend", "How is auth refreshed?", "t1");
		insertQuestion(db, "frontend", "sql", "Which index covers orders?", "t2");
		insertQuestion(db, "backend", "sql", "Not from frontend.", "t3");

		expect(recentQuestionsFrom(db, "frontend", 1)).toEqual([
			"Which index covers orders?",
		]);
		expect(recentQuestionsFrom(db, "frontend", 5)).toEqual([
			"Which index covers orders?",
			"How is auth refreshed?",
		]);
		expect(recentQuestionsFrom(db, "sql", 5)).toEqual([]);
	});
});
