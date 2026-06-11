import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export type WardenDb = Database.Database;

/** DB lives outside any repo so the plugin works across projects. */
export function defaultDbPath(): string {
	return (
		process.env.TOKEN_WARDEN_DB ?? join(homedir(), ".token-warden", "warden.db")
	);
}

/**
 * Versioned migrations keyed by `PRAGMA user_version`. Append-only: never
 * edit a shipped entry, add a new one.
 */
const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE IF NOT EXISTS runs (
		id INTEGER PRIMARY KEY,
		agent TEXT NOT NULL,
		session_id TEXT NOT NULL,
		task_hash TEXT,
		input_tokens INTEGER NOT NULL,
		output_tokens INTEGER NOT NULL,
		cache_creation INTEGER NOT NULL DEFAULT 0,
		cache_read INTEGER NOT NULL DEFAULT 0,
		tool_calls INTEGER NOT NULL DEFAULT 0,
		file_rereads INTEGER NOT NULL DEFAULT 0,
		completed INTEGER NOT NULL DEFAULT 1,
		ruleset_version INTEGER NOT NULL DEFAULT 0,
		ts TEXT NOT NULL
	);

	CREATE UNIQUE INDEX IF NOT EXISTS runs_session_id ON runs(session_id);

	CREATE TABLE IF NOT EXISTS rules (
		id INTEGER PRIMARY KEY,
		agent TEXT NOT NULL,
		body TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'candidate',
		measured_delta INTEGER,
		context_cost INTEGER NOT NULL,
		source_run INTEGER REFERENCES runs(id),
		decided_at TEXT,
		created_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS baselines (
		agent TEXT NOT NULL,
		task_hash TEXT NOT NULL,
		run1_tokens INTEGER NOT NULL,
		best_tokens INTEGER NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (agent, task_hash)
	);
	`,
	`
	CREATE TABLE IF NOT EXISTS ruleset_versions (
		agent TEXT PRIMARY KEY,
		version INTEGER NOT NULL DEFAULT 0,
		updated_at TEXT NOT NULL
	);
	`,
];

function migrate(db: WardenDb): void {
	const current = db.pragma("user_version", { simple: true }) as number;
	for (let version = current; version < MIGRATIONS.length; version++) {
		const sql = MIGRATIONS[version];
		if (sql === undefined) break;
		db.transaction(() => {
			db.exec(sql);
			db.pragma(`user_version = ${version + 1}`);
		})();
	}
}

export function openDb(path: string = defaultDbPath()): WardenDb {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 2000");
	migrate(db);
	return db;
}

export interface NewRun {
	agent: string;
	sessionId: string;
	taskHash: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheCreation: number;
	cacheRead: number;
	toolCalls: number;
	fileRereads: number;
	completed: boolean;
	rulesetVersion: number;
	ts: string;
}

/** Row shape as stored (snake_case, ints for booleans). */
export interface RunRow {
	id: number;
	agent: string;
	session_id: string;
	task_hash: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_creation: number;
	cache_read: number;
	tool_calls: number;
	file_rereads: number;
	completed: number;
	ruleset_version: number;
	ts: string;
}

/**
 * Insert or update the run for a session. The Stop hook fires after every
 * turn with the same session_id and a longer transcript, so the row always
 * holds the latest cumulative totals for that session.
 */
export function upsertRun(db: WardenDb, run: NewRun): number {
	const row = db
		.prepare<unknown[], { id: number }>(
			`INSERT INTO runs (
				agent, session_id, task_hash, input_tokens, output_tokens,
				cache_creation, cache_read, tool_calls, file_rereads,
				completed, ruleset_version, ts
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				agent = excluded.agent,
				task_hash = excluded.task_hash,
				input_tokens = excluded.input_tokens,
				output_tokens = excluded.output_tokens,
				cache_creation = excluded.cache_creation,
				cache_read = excluded.cache_read,
				tool_calls = excluded.tool_calls,
				file_rereads = excluded.file_rereads,
				completed = excluded.completed,
				ruleset_version = excluded.ruleset_version,
				ts = excluded.ts
			RETURNING id`,
		)
		.get(
			run.agent,
			run.sessionId,
			run.taskHash,
			run.inputTokens,
			run.outputTokens,
			run.cacheCreation,
			run.cacheRead,
			run.toolCalls,
			run.fileRereads,
			run.completed ? 1 : 0,
			run.rulesetVersion,
			run.ts,
		);
	if (row === undefined) {
		throw new Error("upsertRun: INSERT ... RETURNING produced no row");
	}
	return row.id;
}

export function getRunBySession(
	db: WardenDb,
	sessionId: string,
): RunRow | undefined {
	return db
		.prepare<unknown[], RunRow>("SELECT * FROM runs WHERE session_id = ?")
		.get(sessionId);
}

export interface RuleRow {
	id: number;
	agent: string;
	body: string;
	status: string;
	measured_delta: number | null;
	context_cost: number;
	source_run: number | null;
	decided_at: string | null;
	created_at: string;
}

export function getRuleById(db: WardenDb, id: number): RuleRow | undefined {
	return db
		.prepare<unknown[], RuleRow>("SELECT * FROM rules WHERE id = ?")
		.get(id);
}

/** Active rules for an agent, best measured savings first — the order they
 * are compiled into MEMORY.md. */
export function getActiveRules(db: WardenDb, agent: string): RuleRow[] {
	return db
		.prepare<unknown[], RuleRow>(
			`SELECT * FROM rules
			 WHERE agent = ? AND status = 'active'
			 ORDER BY measured_delta DESC, id ASC`,
		)
		.all(agent);
}

export interface BaselineRow {
	agent: string;
	task_hash: string;
	run1_tokens: number;
	best_tokens: number;
	updated_at: string;
}

export function getBaseline(
	db: WardenDb,
	agent: string,
	taskHash: string,
): BaselineRow | undefined {
	return db
		.prepare<unknown[], BaselineRow>(
			"SELECT * FROM baselines WHERE agent = ? AND task_hash = ?",
		)
		.get(agent, taskHash);
}

export interface NewRule {
	agent: string;
	body: string;
	contextCost: number;
	sourceRun: number | null;
	createdAt: string;
}

/** Insert a candidate rule. Candidates live only in SQLite until measured
 * (invariant #1). */
export function insertRule(db: WardenDb, rule: NewRule): number {
	const row = db
		.prepare<unknown[], { id: number }>(
			`INSERT INTO rules (agent, body, status, context_cost, source_run, created_at)
			 VALUES (?, ?, 'candidate', ?, ?, ?) RETURNING id`,
		)
		.get(
			rule.agent,
			rule.body,
			rule.contextCost,
			rule.sourceRun,
			rule.createdAt,
		);
	if (row === undefined) throw new Error("insertRule produced no row");
	return row.id;
}

export function listRulesByAgent(db: WardenDb, agent: string): RuleRow[] {
	return db
		.prepare<unknown[], RuleRow>(
			"SELECT * FROM rules WHERE agent = ? ORDER BY id ASC",
		)
		.all(agent);
}

/** Oldest-first candidates, capped — the selector processes at most a few
 * per invocation to bound benchmarking cost. */
export function listCandidates(
	db: WardenDb,
	agent: string,
	limit: number,
): RuleRow[] {
	return db
		.prepare<unknown[], RuleRow>(
			`SELECT * FROM rules
			 WHERE agent = ? AND status = 'candidate'
			 ORDER BY created_at ASC, id ASC LIMIT ?`,
		)
		.all(agent, limit);
}

/** The active rule least recently (re-)decided — the round-robin re-audit
 * target. */
export function oldestDecidedActiveRule(
	db: WardenDb,
	agent: string,
): RuleRow | undefined {
	return db
		.prepare<unknown[], RuleRow>(
			`SELECT * FROM rules
			 WHERE agent = ? AND status = 'active'
			 ORDER BY decided_at ASC, id ASC LIMIT 1`,
		)
		.get(agent);
}

/** Record a verdict. Evicted rules are never deleted — they are the
 * negative dataset. */
export function decideRule(
	db: WardenDb,
	id: number,
	status: "active" | "evicted",
	measuredDelta: number | null,
	decidedAt: string,
): void {
	db.prepare(
		"UPDATE rules SET status = ?, measured_delta = ?, decided_at = ? WHERE id = ?",
	).run(status, measuredDelta, decidedAt, id);
}

export function getRulesetVersion(db: WardenDb, agent: string): number {
	const row = db
		.prepare<unknown[], { version: number }>(
			"SELECT version FROM ruleset_versions WHERE agent = ?",
		)
		.get(agent);
	return row?.version ?? 0;
}

export function bumpRulesetVersion(
	db: WardenDb,
	agent: string,
	ts: string,
): number {
	const row = db
		.prepare<unknown[], { version: number }>(
			`INSERT INTO ruleset_versions (agent, version, updated_at)
			 VALUES (?, 1, ?)
			 ON CONFLICT(agent) DO UPDATE SET
				version = version + 1,
				updated_at = excluded.updated_at
			 RETURNING version`,
		)
		.get(agent, ts);
	if (row === undefined) throw new Error("bumpRulesetVersion produced no row");
	return row.version;
}

/**
 * Record a completed golden run against the baseline. The first-ever record
 * for an (agent, task) freezes `run1_tokens` permanently (design invariant
 * #5); later records only ratchet `best_tokens` downward.
 */
export function recordBaseline(
	db: WardenDb,
	agent: string,
	taskHash: string,
	totalTokens: number,
	ts: string,
): void {
	db.prepare(
		`INSERT INTO baselines (agent, task_hash, run1_tokens, best_tokens, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(agent, task_hash) DO UPDATE SET
			best_tokens = MIN(best_tokens, excluded.best_tokens),
			updated_at = excluded.updated_at`,
	).run(agent, taskHash, totalTokens, totalTokens, ts);
}
