import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	decideRule,
	getRunBySession,
	insertRule,
	listCandidates,
	MIGRATION_COUNT,
	type NewRun,
	oldestDecidedActiveRule,
	openDb,
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
});
