import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bumpRulesetVersion,
	candidateCounts,
	decideRule,
	getRuleById,
	getRulesetVersion,
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
	recentRealWorkTotals,
	setRuleProbation,
	setRuleUnderpowered,
	upsertRun,
	type WardenDb,
	withDb,
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

	it("arms busy_timeout so a concurrent writer waits instead of throwing", () => {
		expect(db.pragma("busy_timeout", { simple: true })).toBe(2000);
	});

	it("creates the latency-path indexes for real-work and measurement reads", () => {
		const indexes = db
			.prepare<[], { name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		expect(indexes).toEqual(
			expect.arrayContaining([
				"idx_runs_config_ts",
				"idx_runs_realwork",
				"idx_receipts_agent",
			]),
		);
	});

	it("plans the Stop hook's recent-real-work read through the partial index", () => {
		// The Stop hook has a hard 2s budget; this read must not scan `runs`.
		const plan = db
			.prepare<
				unknown[],
				{ detail: string }
			>(`EXPLAIN QUERY PLAN SELECT id FROM runs
				 WHERE agent = ? AND id != ? AND task_hash IS NULL AND completed = 1
				 ORDER BY ts DESC LIMIT ?`)
			.all("sql", 0, 5)
			.map((row) => row.detail)
			.join(" | ");
		expect(plan).toContain("idx_runs_realwork");
		expect(plan).not.toContain("SCAN runs");
	});

	it("opens a second connection to the same file without re-migrating", () => {
		// A Stop hook can fire while a benchmark holds the same DB. Both
		// connections must land on the same stamp and both must be writable.
		const other = openDb(join(dir, "warden.db"));
		try {
			expect(other.pragma("user_version", { simple: true })).toBe(
				MIGRATION_COUNT,
			);
			upsertRun(db, makeRun({ sessionId: "a" }));
			upsertRun(other, makeRun({ sessionId: "b" }));
			expect(getRunBySession(db, "b")).toBeDefined();
		} finally {
			other.close();
		}
	});

	it("resumes migrating a database left at an intermediate version", () => {
		// A crash between migrations leaves an older stamp with the newer DDL
		// already rolled back. The tail migration is now an ADD COLUMN, which is
		// NOT idempotent, so the fixture is hand-built exactly as the previous
		// version of this test warned it would have to be: undo the tail
		// migration's DDL, then rewind the stamp to match.
		db.exec(
			`ALTER TABLE rules DROP COLUMN underpowered;
			 ALTER TABLE rules DROP COLUMN recovery_runs;
			 ALTER TABLE rules DROP COLUMN recovers;`,
		);
		db.pragma(`user_version = ${MIGRATION_COUNT - 1}`);
		db.close();
		db = openDb(join(dir, "warden.db"));
		expect(db.pragma("user_version", { simple: true })).toBe(MIGRATION_COUNT);
		const columns = db
			.prepare<[], { name: string }>(
				"SELECT name FROM pragma_table_info('rules')",
			)
			.all()
			.map((row) => row.name);
		expect(columns).toEqual(
			expect.arrayContaining(["underpowered", "recovery_runs", "recovers"]),
		);
		upsertRun(db, makeRun());
		expect(getRunBySession(db, "s1")).toBeDefined();
	});

	it("defaults the eviction-class columns on an existing ledger", () => {
		// The migration must never reclassify history: a rule that predates it
		// reads as a plain eviction, not as a recoverable one.
		db.exec(
			`ALTER TABLE rules DROP COLUMN underpowered;
			 ALTER TABLE rules DROP COLUMN recovery_runs;
			 ALTER TABLE rules DROP COLUMN recovers;`,
		);
		db.prepare(
			`INSERT INTO rules (id, agent, body, status, measured_delta, context_cost, created_at)
			 VALUES (7, 'sql', 'An old rule body from before the migration.', 'evicted', 12, 10, 't')`,
		).run();
		db.pragma(`user_version = ${MIGRATION_COUNT - 1}`);
		db.close();
		db = openDb(join(dir, "warden.db"));
		const row = getRuleById(db, 7);
		expect(row?.underpowered).toBe(0);
		expect(row?.recovery_runs).toBeNull();
		expect(row?.recovers).toBeNull();
	});

	it("warns but does not touch a database newer than this build", () => {
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const future = MIGRATION_COUNT + 5;
			db.pragma(`user_version = ${future}`);
			db.close();
			db = openDb(join(dir, "warden.db"));
			// Never rewind a newer schema: the ledger lives in those columns.
			expect(db.pragma("user_version", { simple: true })).toBe(future);
			expect(String(stderr.mock.calls[0]?.[0])).toContain("WARNING:");
			expect(String(stderr.mock.calls[0]?.[0])).toContain(String(future));
			// Still fully usable on the columns this build knows about.
			upsertRun(db, makeRun());
			expect(getRunBySession(db, "s1")).toBeDefined();
		} finally {
			stderr.mockRestore();
		}
	});
});

describe("withDb", () => {
	const dbPath = (): string => join(dir, "with.db");

	it("returns the body's value and closes the connection", () => {
		let captured: WardenDb | undefined;
		const version = withDb(dbPath(), (db) => {
			captured = db;
			return getRulesetVersion(db, "sql");
		});
		expect(version).toBe(0);
		// A closed better-sqlite3 handle throws on any statement — the check that
		// the `finally` actually ran, rather than trusting the shape of the code.
		expect(() => (captured as WardenDb).pragma("user_version")).toThrow();
	});

	it("closes the connection when the body THROWS — the whole point", () => {
		let captured: WardenDb | undefined;
		expect(() =>
			withDb(dbPath(), (db) => {
				captured = db;
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(() => (captured as WardenDb).pragma("user_version")).toThrow();
	});

	it("defaults to the ledger path when none is given", () => {
		// TOKEN_WARDEN_DB is set by the test setup, so the no-path overload must
		// land on the same file `openDb()` would.
		const written = withDb((db) => {
			upsertRun(db, makeRun());
			return getRunBySession(db, "s1");
		});
		expect(written).toBeDefined();
	});
});

describe("RETURNING guards", () => {
	/** A connection whose statements silently return nothing — the corrupt-DB
	 * shape the `requireRow` guards exist for. */
	const emptyDb = {
		prepare: () => ({ get: () => undefined }),
	} as unknown as WardenDb;

	it("upsertRun throws rather than returning a bogus run id", () => {
		expect(() => upsertRun(emptyDb, makeRun())).toThrow(/upsertRun/);
	});

	it("insertRule throws rather than returning a bogus rule id", () => {
		expect(() =>
			insertRule(emptyDb, {
				agent: "sql",
				body: "Rule body number one here.",
				contextCost: 8,
				sourceRun: null,
				createdAt: "t",
			}),
		).toThrow(/insertRule/);
	});

	it("bumpRulesetVersion throws rather than returning a bogus version", () => {
		expect(() => bumpRulesetVersion(emptyDb, "sql", "t")).toThrow(
			/bumpRulesetVersion/,
		);
	});

	it("insertQuestion throws rather than returning a bogus question id", () => {
		expect(() => insertQuestion(emptyDb, "a", "b", "body", "t")).toThrow(
			/insertQuestion/,
		);
	});
});

describe("recentRealWorkTotals", () => {
	it("returns newest-first totals, excluding one run and non-real-work rows", () => {
		const base = { agent: "sql" as const, taskHash: null };
		const keep = upsertRun(
			db,
			makeRun({ ...base, sessionId: "r1", ts: "2026-06-01" }),
		);
		upsertRun(db, makeRun({ ...base, sessionId: "r2", ts: "2026-06-03" }));
		const exclude = upsertRun(
			db,
			makeRun({ ...base, sessionId: "r3", ts: "2026-06-02" }),
		);
		// Excluded by predicate: incomplete, and a golden (task_hash) run.
		upsertRun(
			db,
			makeRun({ ...base, sessionId: "r4", ts: "2026-06-04", completed: false }),
		);
		upsertRun(
			db,
			makeRun({
				...base,
				sessionId: "r5",
				ts: "2026-06-05",
				taskHash: "sql-01",
			}),
		);

		expect(recentRealWorkTotals(db, "sql", 10, exclude)).toHaveLength(2);
		// 100 + 50 + 10 + 20.
		expect(recentRealWorkTotals(db, "sql", 10, exclude)).toEqual([180, 180]);
		expect(recentRealWorkTotals(db, "sql", 1, exclude)).toHaveLength(1);
		expect(recentRealWorkTotals(db, "sql", 10, keep)).toHaveLength(2);
		expect(recentRealWorkTotals(db, "backend", 10, 0)).toEqual([]);
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

	it("setRuleUnderpowered round-trips, defaults to 0, and clears its depth", () => {
		const id = seedRule("Rule body number one here.", "t");
		expect(getRuleById(db, id)?.underpowered).toBe(0);
		expect(getRuleById(db, id)?.recovery_runs).toBeNull();
		setRuleUnderpowered(db, id, true, 3);
		expect(getRuleById(db, id)?.underpowered).toBe(1);
		expect(getRuleById(db, id)?.recovery_runs).toBe(3);
		// Clearing the class must clear the depth with it: a run depth that
		// outlived its classification would let a later recovery be judged
		// against a threshold nothing set.
		setRuleUnderpowered(db, id, false, 9);
		expect(getRuleById(db, id)?.underpowered).toBe(0);
		expect(getRuleById(db, id)?.recovery_runs).toBeNull();
	});

	it("insertRule records the recovery lineage pointer", () => {
		const parent = seedRule("Rule body number one here.", "t");
		const child = insertRule(db, {
			agent: "sql",
			body: "Rule body number one here, restated.",
			contextCost: 9,
			sourceRun: null,
			createdAt: "t",
			recovers: parent,
		});
		expect(getRuleById(db, child)?.recovers).toBe(parent);
		expect(getRuleById(db, parent)?.recovers).toBeNull();
		// A recovery attempt is a CANDIDATE: it is measured from scratch, never
		// re-banked on the numbers that got its parent evicted.
		expect(getRuleById(db, child)?.status).toBe("candidate");
		expect(getRuleById(db, child)?.measured_delta).toBeNull();
	});

	it("recentEvictedRules omits underpowered evictions from distiller feedback", () => {
		const negative = seedRule("Rule body number one here.", "t");
		const underpowered = seedRule("Rule body number two here.", "t");
		decideRule(db, negative, "evicted", -5, "non-positive delta (-5)", "d1");
		decideRule(db, underpowered, "evicted", 9000, "uncertain", "d2");
		setRuleUnderpowered(db, underpowered, true, 2);
		const bodies = recentEvictedRules(db, "sql", 8).map((r) => r.body);
		expect(bodies).toContain("Rule body number one here.");
		// Telling the proposer this one "was rejected, aim at a bigger waste
		// source" is the wrong lesson AND contradicts the dedupe, which lets the
		// body through so it can be re-measured.
		expect(bodies).not.toContain("Rule body number two here.");
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
