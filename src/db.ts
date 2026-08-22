import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export type WardenDb = Database.Database;

/** SQL expression for a run's total token cost — the four billable counters.
 * Centralized so adding a token column can never silently drift across the
 * queries that sum cost. */
export const RUN_TOTAL_TOKENS_SQL =
	"input_tokens + output_tokens + cache_creation + cache_read";

/** SQL expression for a run's project bucket. NULL-project rows must fold onto
 * a literal '(unknown)' rather than stay NULL: they are grouped by this, matched
 * against it with IN, and compared to a caller's project with `=`, and under
 * SQL's three-valued NULL semantics all three would silently drop them.
 * Centralized for the same reason as the token total — the sentinel appears in
 * both the grouping half and the filtering half of these queries, and a value
 * that drifted between them would mis-bucket rows rather than fail. */
const PROJECT_KEY_SQL = "COALESCE(project, '(unknown)')";

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
	`
	ALTER TABLE rules ADD COLUMN decided_reason TEXT;
	`,
	`
	ALTER TABLE runs ADD COLUMN config TEXT NOT NULL DEFAULT 'active';
	`,
	`
	CREATE TABLE IF NOT EXISTS questions (
		id INTEGER PRIMARY KEY,
		from_agent TEXT NOT NULL,
		to_agent TEXT NOT NULL,
		body TEXT NOT NULL,
		approved INTEGER,
		ts TEXT NOT NULL
	);
	`,
	`
	ALTER TABLE runs ADD COLUMN project TEXT;
	`,
	`
	ALTER TABLE runs ADD COLUMN model TEXT;
	`,
	`
	CREATE TABLE IF NOT EXISTS tool_costs (
		run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		grp TEXT NOT NULL,
		label TEXT NOT NULL,
		calls INTEGER NOT NULL,
		input_chars INTEGER NOT NULL,
		result_chars INTEGER NOT NULL,
		PRIMARY KEY (run_id, kind, grp, label)
	);
	`,
	`
	CREATE TABLE IF NOT EXISTS rule_receipts (
		rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
		agent TEXT NOT NULL,
		decided_at TEXT NOT NULL,
		status TEXT NOT NULL,
		kind TEXT NOT NULL,
		reason TEXT,
		model TEXT,
		fixture_hash TEXT,
		runs INTEGER NOT NULL,
		delta INTEGER,
		context_cost INTEGER NOT NULL,
		standard_error INTEGER,
		regression INTEGER NOT NULL DEFAULT 0,
		with_tokens INTEGER NOT NULL,
		without_tokens INTEGER NOT NULL,
		with_tool_calls INTEGER NOT NULL,
		without_tool_calls INTEGER NOT NULL,
		with_file_rereads INTEGER NOT NULL,
		without_file_rereads INTEGER NOT NULL,
		tasks_total INTEGER NOT NULL,
		tasks_passed_with INTEGER NOT NULL,
		tasks_passed_without INTEGER NOT NULL,
		PRIMARY KEY (rule_id, decided_at)
	);
	`,
	`
	ALTER TABLE rules ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
	`,
	`
	ALTER TABLE rules ADD COLUMN born_digest TEXT;
	ALTER TABLE rules ADD COLUMN scope TEXT;
	`,
	`
	ALTER TABLE runs ADD COLUMN duration_ms INTEGER;
	`,
	`
	ALTER TABLE rules ADD COLUMN probation INTEGER NOT NULL DEFAULT 0;
	`,
	// The two filter shapes every hot read query uses: real-work/golden splits
	// over runs (learning curves, anomaly windows, project usage) and per-agent
	// rule lookups by status (active memory, candidate lists, evicted feedback).
	`
	CREATE INDEX IF NOT EXISTS idx_runs_agent_task ON runs(agent, task_hash);
	CREATE INDEX IF NOT EXISTS idx_rules_agent_status ON rules(agent, status);
	`,
	// Swap provenance for compression A/B: the rule id this candidate proposes
	// to REPLACE. The selector measures such a candidate against the active set
	// minus the replaced rule (a swap, not an addition) — measuring it on top of
	// the semantically identical original would pin its marginal delta at ~0.
	`
	ALTER TABLE rules ADD COLUMN replaces INTEGER;
	`,
	// Indices for the two latency-sensitive paths. The Stop hook has a hard 2s
	// budget and reads the agent's recent real-work totals on every turn; the
	// SessionStart nudge reads the last measurement timestamp. Both scanned the
	// whole `runs` table before this. The partial index encodes the real-work
	// predicate (task_hash IS NULL AND completed = 1) so it stays small and
	// serves the ORDER BY ts DESC without a sort. `rule_receipts` had no index
	// on `agent` at all, so /warden-receipt scanned every decision ever made.
	`
	CREATE INDEX IF NOT EXISTS idx_runs_config_ts ON runs(config, ts);
	CREATE INDEX IF NOT EXISTS idx_runs_realwork ON runs(agent, ts DESC)
		WHERE task_hash IS NULL AND completed = 1;
	CREATE INDEX IF NOT EXISTS idx_receipts_agent ON rule_receipts(agent, rule_id);
	`,
	// Eviction CLASS, so the two reasons a candidate can be evicted stop looking
	// alike downstream. `underpowered` = the point estimate cleared the 2x-rent
	// bar and only the WIDTH of the measurement stopped the promotion; every
	// other eviction (sub-threshold, non-positive, regression, re-audit) leaves
	// it 0. `recovery_runs` records the per-side run depth that verdict was
	// decided at, so a later re-measurement can be required to bring MORE
	// evidence rather than re-running into the same noise. `recovers` is the
	// lineage pointer: the evicted rule this candidate is a second look at.
	// Before this, both eviction reasons were `status = 'evicted'` plus a
	// free-text reason no code parses, so the distiller's trigram dedupe
	// suppressed a good-but-unlucky rule exactly as hard as a falsified one.
	`
	ALTER TABLE rules ADD COLUMN underpowered INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE rules ADD COLUMN recovery_runs INTEGER;
	ALTER TABLE rules ADD COLUMN recovers INTEGER;
	`,
];

/** Current schema version — what `PRAGMA user_version` reads after openDb. */
export const MIGRATION_COUNT = MIGRATIONS.length;

function schemaVersion(db: WardenDb): number {
	return db.pragma("user_version", { simple: true }) as number;
}

/**
 * Apply one migration and stamp the new `user_version` in the SAME
 * transaction. SQLite makes both DDL and the user_version header write
 * transactional, so a crash mid-migration rolls the schema change back rather
 * than leaving a half-applied schema stamped as complete; the next open
 * retries it.
 *
 * BEGIN IMMEDIATE rather than the default deferred BEGIN, plus a re-read of
 * the stamp inside the lock: two warden processes can open the same DB at once
 * (a Stop hook firing while a benchmark writes). Both would read the same
 * pre-migration version and both try to apply it, and `ALTER TABLE ... ADD
 * COLUMN` is not idempotent, so the loser used to die with "duplicate column
 * name". Immediate takes the write lock up front (busy_timeout applies);
 * re-reading under it lets the loser observe the winner's stamp and stand
 * down. A deferred transaction cannot do this — a read-then-write upgrade
 * fails with SQLITE_BUSY_SNAPSHOT, which busy_timeout does NOT retry.
 *
 * Returns false when another process already moved the stamp past `version`.
 */
function applyMigration(db: WardenDb, version: number, sql: string): boolean {
	return db
		.transaction((): boolean => {
			if (schemaVersion(db) !== version) return false;
			db.exec(sql);
			db.pragma(`user_version = ${version + 1}`);
			return true;
		})
		.immediate();
}

function migrate(db: WardenDb): void {
	let version = schemaVersion(db);
	if (version > MIGRATIONS.length) {
		// Downgrade: a newer warden wrote this DB and older code is now opening
		// it. Never rewind the schema — the extra columns are harmless to
		// `SELECT *` readers and destroying them would lose the ledger. Say so
		// loudly instead, because a missing-column error three commands later is
		// far harder to diagnose than this line.
		process.stderr.write(
			`WARNING: warden database schema version ${version} is newer than this build understands (${MIGRATIONS.length}); running without migrating\n`,
		);
		return;
	}
	while (version < MIGRATIONS.length) {
		const sql = MIGRATIONS[version];
		// The loop bound guarantees a value; noUncheckedIndexedAccess does not
		// know that.
		if (sql === undefined) break;
		if (applyMigration(db, version, sql)) {
			version += 1;
			continue;
		}
		// Lost the race to a concurrent process: adopt its stamp. If that did
		// not actually move us forward, stop rather than spin forever.
		const observed = schemaVersion(db);
		if (observed <= version) break;
		version = observed;
	}
}

/**
 * Connection pragmas. Order matters — see the busy_timeout comment.
 *
 * NOTE: `foreign_keys` is deliberately left OFF (SQLite's default), so the
 * REFERENCES clauses in the schema are documentation, not enforcement.
 * Switching it on is a behavioural change that would reject writes against
 * existing ledgers holding rows whose parent was never recorded, and nothing
 * in the codebase ever deletes a run or a rule (evicted rules are the negative
 * dataset), so the cascades it would activate have no work to do.
 */
function configureConnection(db: WardenDb): void {
	// FIRST, before any other pragma: `journal_mode = WAL` needs a brief
	// exclusive lock the first time it converts a rollback-journal DB, and a
	// second warden process may hold the write lock right then. With the busy
	// timeout still at its default 0 the open would throw SQLITE_BUSY instead
	// of waiting the way every later statement does.
	db.pragma("busy_timeout = 2000");
	db.pragma("journal_mode = WAL");
	// Explicit rather than inherited: better-sqlite3's bundled build already
	// runs WAL at NORMAL (SQLITE_DEFAULT_WAL_SYNCHRONOUS=1), but the Stop hook's
	// 2s budget depends on it, so pin it instead of trusting a compile flag.
	db.pragma("synchronous = NORMAL");
}

export function openDb(path: string = defaultDbPath()): WardenDb {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	configureConnection(db);
	migrate(db);
	return db;
}

/**
 * Open the ledger, run `body`, and close the connection whatever happens.
 *
 * Every command wrote this by hand: `const db = openDb(); try { ... } finally {
 * db.close(); }`. Twenty-two copies of one lifetime is twenty-two chances for a
 * `finally` to go missing, and a leaked handle keeps a WAL lock the next warden
 * process then waits on — the SQLITE_BUSY class of bug this repo has already
 * shipped once.
 *
 * NOT for the fail-open hooks. `collect` opens with a shortened `busy_timeout`
 * so a contended write can be retried inside the hook's budget, and a hook must
 * exit 0 whatever happens; that is different knowledge from "open the ledger",
 * and it keeps its own `openHookDb`.
 */
export function withDb<T>(body: (db: WardenDb) => T): T;
export function withDb<T>(path: string, body: (db: WardenDb) => T): T;
export function withDb<T>(
	pathOrBody: string | ((db: WardenDb) => T),
	maybeBody?: (db: WardenDb) => T,
): T {
	const body = typeof pathOrBody === "function" ? pathOrBody : maybeBody;
	if (!body) throw new Error("withDb: no body supplied");
	const db = typeof pathOrBody === "string" ? openDb(pathOrBody) : openDb();
	try {
		return body(db);
	} finally {
		db.close();
	}
}

/**
 * Unwrap the row an `INSERT ... RETURNING` promised. better-sqlite3 types
 * `.get()` as possibly-undefined; for these statements that can only happen if
 * the insert did not land, which means a corrupt or concurrently-mangled DB.
 * Fail loudly rather than handing back a bogus row id that would then be
 * written into a foreign key column.
 */
function requireRow<T>(row: T | undefined, what: string): T {
	if (row === undefined) {
		throw new Error(`${what}: INSERT ... RETURNING produced no row`);
	}
	return row;
}

/** Which rule configuration produced a run: 'real' for collected work
 * sessions, 'active' for plain active-set golden runs (the only kind that
 * feeds baselines and learning curves), 'candidate'/'audit' for selector
 * measurement runs.
 *
 * 'modelbench' and 'promptbench' are LEGACY: the A/B comparison commands that
 * wrote them were removed in v1.0.0, so nothing produces these values any
 * more. They stay in the union because rows carrying them still exist in every
 * database that ever ran those commands, and a stored value that the type
 * cannot express is a lie about what a read can return. The `runs` table is
 * append-only history; history does not get retyped because the writer left. */
export type RunConfig =
	| "real"
	| "active"
	| "candidate"
	| "audit"
	| "modelbench"
	| "promptbench";

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
	config?: RunConfig;
	/** Working directory of the session for real-work runs; null for golden runs. */
	project?: string | null;
	/** Model that produced the run; token counts are only comparable within a
	 * model. Null when unknown (real-work collection does not record it). */
	model?: string | null;
	/** Wall-clock duration of the run in milliseconds, from the claude JSON
	 * result. Golden runs record it; real-work collection leaves it null. An
	 * advisory latency axis — never part of the keep/evict verdict. */
	durationMs?: number | null;
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
	config: string;
	project: string | null;
	model: string | null;
	duration_ms: number | null;
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
				completed, ruleset_version, ts, config, project, model,
				duration_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				ts = excluded.ts,
				config = excluded.config,
				project = excluded.project,
				model = excluded.model,
				duration_ms = excluded.duration_ms
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
			run.config ?? "active",
			run.project ?? null,
			run.model ?? null,
			run.durationMs ?? null,
		);
	return requireRow(row, "upsertRun").id;
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
	decided_reason: string | null;
	/** 1 = human-authored / behavioral rule, exempt from token-based eviction
	 * (compiled and rent-counted, but never auto-evicted for sub-threshold
	 * savings). 0 = distilled efficiency rule, token-gated as usual. */
	protected: number;
	/** Truncated digest of the session this rule was distilled from — the
	 * provenance shown on its receipt ("born of:"). Null for authored rules. */
	born_digest: string | null;
	/** Optional "allowed where" predicate (repo / language / task category). When
	 * set, the rule is compiled into memory with a "(when <scope>)" prefix so the
	 * agent applies it conditionally; null = always-on. */
	scope: string | null;
	/** 1 = the rule's last re-audit measured sub-threshold (first strike). It
	 * stays active — one noisy re-measure must not churn out a rule that entered
	 * at >= bar + z*SE confidence — but a SECOND consecutive sub-threshold
	 * re-audit evicts. A passing re-audit clears the strike. Regressions ignore
	 * probation and evict immediately (safety invariant). */
	probation: number;
	/** Rule id this candidate proposes to replace (compression A/B swap);
	 * null for ordinary candidates. */
	replaces: number | null;
	/** 1 = this rule was evicted for want of POWER, not for want of an effect:
	 * its point estimate cleared the 2x-rent bar and only the width of the
	 * measurement stopped the promotion. A measured negative, a regression and a
	 * re-audit eviction all leave this 0. Read only as an eviction CLASS — it
	 * never re-admits anything, it only tells the distiller's dedupe that this
	 * body has not actually been falsified. */
	underpowered: number;
	/** Per-side, per-task run depth the underpowered verdict was decided at. A
	 * recovery attempt must be measured DEEPER than this or it is held: a second
	 * look into the same noise reproduces the same verdict. */
	recovery_runs: number | null;
	/** The evicted rule this candidate is a second look at; null for ordinary
	 * candidates. Set by the distiller when it re-proposes a body that was
	 * evicted underpowered, and it caps the lineage at two measurements — a
	 * candidate that already carries it can never itself be recovered. */
	recovers: number | null;
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
	/** Provenance digest of the session this rule was distilled from. */
	bornDigest?: string | null;
	/** Rule id this candidate proposes to replace (compression A/B swap). */
	replaces?: number | null;
	/** The underpowered eviction this candidate is a second look at. The
	 * candidate is measured from scratch like any other — the pointer is
	 * provenance and a lineage cap, never a shortcut into memory. */
	recovers?: number | null;
}

/** Insert a candidate rule. Candidates live only in SQLite until measured
 * (invariant #1). */
export function insertRule(db: WardenDb, rule: NewRule): number {
	const row = db
		.prepare<unknown[], { id: number }>(
			`INSERT INTO rules (agent, body, status, context_cost, source_run, created_at, born_digest, replaces, recovers)
			 VALUES (?, ?, 'candidate', ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.get(
			rule.agent,
			rule.body,
			rule.contextCost,
			rule.sourceRun,
			rule.createdAt,
			rule.bornDigest ?? null,
			rule.replaces ?? null,
			rule.recovers ?? null,
		);
	return requireRow(row, "insertRule").id;
}

/** Set (or clear, with null) a rule's "allowed where" scope predicate. */
export function setRuleScope(
	db: WardenDb,
	id: number,
	scope: string | null,
): void {
	db.prepare("UPDATE rules SET scope = ? WHERE id = ?").run(scope, id);
}

/** Set or clear a rule's re-audit probation strike. */
export function setRuleProbation(
	db: WardenDb,
	id: number,
	probation: boolean,
): void {
	db.prepare("UPDATE rules SET probation = ? WHERE id = ?").run(
		probation ? 1 : 0,
		id,
	);
}

/** Record the CLASS of an eviction: whether it was decided by the width of the
 * measurement rather than by its point estimate, and at what per-side run depth.
 * A single statement on purpose — `select.ts` owns the transaction that writes
 * a verdict, its probation strike and its receipt as one unit, and this belongs
 * inside it. */
export function setRuleUnderpowered(
	db: WardenDb,
	id: number,
	underpowered: boolean,
	recoveryRuns: number | null,
): void {
	db.prepare(
		"UPDATE rules SET underpowered = ?, recovery_runs = ? WHERE id = ?",
	).run(underpowered ? 1 : 0, underpowered ? recoveryRuns : null, id);
}

/** The most recently decided evicted rules for an agent — the distiller's
 * negative feedback set. Each carries the measured delta and the eviction
 * reason so the proposer can learn what failed and why (a proposal that was
 * measured and rejected must not be re-proposed as a minor variant).
 *
 * UNDERPOWERED evictions are excluded. That block tells the proposer "this was
 * measured and rejected, aim at a bigger waste source", which is precisely the
 * wrong lesson from a rule whose measured effect was LARGE and merely
 * unresolvable — and it would contradict the dedupe, which deliberately lets
 * such a body be proposed again. */
export function recentEvictedRules(
	db: WardenDb,
	agent: string,
	limit: number,
): Pick<RuleRow, "body" | "measured_delta" | "decided_reason">[] {
	return db
		.prepare<
			unknown[],
			Pick<RuleRow, "body" | "measured_delta" | "decided_reason">
		>(
			`SELECT body, measured_delta, decided_reason FROM rules
			 WHERE agent = ? AND status = 'evicted' AND underpowered = 0
			 ORDER BY decided_at DESC, id DESC LIMIT ?`,
		)
		.all(agent, limit);
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
 * target. Protected rules are excluded: they are never token-evicted, so
 * re-auditing them would waste a measurement. */
export function oldestDecidedActiveRule(
	db: WardenDb,
	agent: string,
): RuleRow | undefined {
	return db
		.prepare<unknown[], RuleRow>(
			`SELECT * FROM rules
			 WHERE agent = ? AND status = 'active' AND protected = 0
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
	reason: string,
	decidedAt: string,
): void {
	db.prepare(
		`UPDATE rules SET status = ?, measured_delta = ?, decided_reason = ?, decided_at = ?
		 WHERE id = ?`,
	).run(status, measuredDelta, reason, decidedAt, id);
}

/** Most recent evictions, newest first — the status command's ledger tail. */
export function lastEvictions(
	db: WardenDb,
	agent: string,
	limit: number,
): RuleRow[] {
	return db
		.prepare<unknown[], RuleRow>(
			`SELECT * FROM rules
			 WHERE agent = ? AND status = 'evicted'
			 ORDER BY decided_at DESC, id DESC LIMIT ?`,
		)
		.all(agent, limit);
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
	return requireRow(row, "bumpRulesetVersion").version;
}

export interface QuestionRow {
	id: number;
	from_agent: string;
	to_agent: string;
	body: string;
	/** 1 when the send executed (user approved), NULL while pending or when
	 * the user denied/aborted — the gate can only observe execution. */
	approved: number | null;
	ts: string;
}

/** Log a cross-agent question at ask time (approval unknown yet). */
export function insertQuestion(
	db: WardenDb,
	fromAgent: string,
	toAgent: string,
	body: string,
	ts: string,
): number {
	const row = db
		.prepare<unknown[], { id: number }>(
			`INSERT INTO questions (from_agent, to_agent, body, approved, ts)
			 VALUES (?, ?, ?, NULL, ?) RETURNING id`,
		)
		.get(fromAgent, toAgent, body, ts);
	return requireRow(row, "insertQuestion").id;
}

/** Mark the most recent pending question matching this send as approved —
 * called from PostToolUse, which only fires when the tool actually ran. */
export function approveLatestQuestion(
	db: WardenDb,
	fromAgent: string,
	toAgent: string,
	body: string,
): boolean {
	const result = db
		.prepare(
			`UPDATE questions SET approved = 1 WHERE id = (
				SELECT id FROM questions
				WHERE from_agent = ? AND to_agent = ? AND body = ? AND approved IS NULL
				ORDER BY id DESC LIMIT 1
			)`,
		)
		.run(fromAgent, toAgent, body);
	return result.changes > 0;
}

/** Recent outbound questions from one agent — a distiller signal that its
 * memory is missing knowledge it keeps asking other agents for. */
export function recentQuestionsFrom(
	db: WardenDb,
	agent: string,
	limit: number,
): string[] {
	return db
		.prepare<unknown[], { body: string }>(
			"SELECT body FROM questions WHERE from_agent = ? ORDER BY id DESC LIMIT ?",
		)
		.all(agent, limit)
		.map((row) => row.body);
}

export interface RealWorkPoint {
	rulesetVersion: number;
	runs: number;
	avgTokens: number;
}

/**
 * The cross-project learning curve for one agent: average completed
 * real-work session cost per ruleset version. This is the test of the
 * system's core thesis — golden-suite gains must show up in real work.
 * 'main' never has compiled rules, so it has no curve.
 */
export function realWorkCurveByAgent(
	db: WardenDb,
	agent: string,
): RealWorkPoint[] {
	return db
		.prepare<unknown[], RealWorkPoint>(
			`SELECT ruleset_version AS rulesetVersion,
				COUNT(*) AS runs,
				CAST(AVG(${RUN_TOTAL_TOKENS_SQL}) AS INTEGER) AS avgTokens
			 FROM runs
			 WHERE agent = ? AND task_hash IS NULL AND completed = 1
			 GROUP BY ruleset_version ORDER BY ruleset_version`,
		)
		.all(agent);
}

export interface ProjectCurvePoint extends RealWorkPoint {
	project: string | null;
}

/**
 * Per-project learning curves, pooled across the domain agents (main is
 * excluded — no rules apply to it). Projects ordered by total volume.
 */
export function realWorkCurveByProject(
	db: WardenDb,
	limit: number,
): ProjectCurvePoint[] {
	return db
		.prepare<unknown[], ProjectCurvePoint>(
			`SELECT ${PROJECT_KEY_SQL} AS project,
				ruleset_version AS rulesetVersion,
				COUNT(*) AS runs,
				CAST(AVG(${RUN_TOTAL_TOKENS_SQL}) AS INTEGER) AS avgTokens
			 FROM runs
			 WHERE task_hash IS NULL AND completed = 1 AND agent != 'main'
				AND ${PROJECT_KEY_SQL} IN (
					SELECT ${PROJECT_KEY_SQL} FROM runs
					WHERE task_hash IS NULL AND completed = 1 AND agent != 'main'
					GROUP BY ${PROJECT_KEY_SQL}
					ORDER BY SUM(${RUN_TOTAL_TOKENS_SQL}) DESC
					LIMIT ?
				)
			 GROUP BY ${PROJECT_KEY_SQL}, ruleset_version
			 ORDER BY project, ruleset_version`,
		)
		.all(limit);
}

export interface VersionedTotal {
	rulesetVersion: number;
	total: number;
}

export interface AgentTokenMix {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
}

/** Summed token-type counts across all of an agent's completed runs — the raw
 * material for a blended $/token rate that reflects this agent's actual mix of
 * input / output / cache-write / cache-read tokens. */
export function agentTokenMix(db: WardenDb, agent: string): AgentTokenMix {
	const row = db
		.prepare<[string], AgentTokenMix>(
			`SELECT
				COALESCE(SUM(input_tokens), 0)   AS input,
				COALESCE(SUM(output_tokens), 0)  AS output,
				COALESCE(SUM(cache_creation), 0) AS cacheCreation,
				COALESCE(SUM(cache_read), 0)     AS cacheRead
			 FROM runs WHERE agent = ? AND completed = 1`,
		)
		.get(agent);
	return row ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

/**
 * Per-session completed real-work token totals for one agent, tagged with the
 * ruleset version active at the time. Unlike `realWorkCurveByAgent` (which
 * pre-averages), this returns the raw per-session values so cohort validation
 * can compute variance and a standard error, not just a mean. Optionally
 * scoped to a single project to reduce task-mix confounding.
 */
export function realWorkTotalsByVersion(
	db: WardenDb,
	agent: string,
	project?: string,
): VersionedTotal[] {
	const clause = project ? `AND ${PROJECT_KEY_SQL} = ?` : "";
	const params: unknown[] = project ? [agent, project] : [agent];
	return db
		.prepare<unknown[], VersionedTotal>(
			`SELECT ruleset_version AS rulesetVersion,
				${RUN_TOTAL_TOKENS_SQL} AS total
			 FROM runs
			 WHERE agent = ? AND task_hash IS NULL AND completed = 1 ${clause}
			 ORDER BY ruleset_version, ts`,
		)
		.all(...params);
}

/** Timestamp of the most recent benchmark run of any kind — the cooldown
 * signal for opt-in scheduled selection. Includes config='active' (the shared
 * baseline pass) deliberately: the selector spends the baseline FIRST, so a
 * crash after it must still start the cooldown — otherwise every session
 * start would re-spawn the selector and re-burn the baseline in a loop. Null
 * when nothing has ever been benchmarked. */
export function lastMeasurementTs(db: WardenDb): string | null {
	const row = db
		.prepare<[], { ts: string | null }>(
			"SELECT MAX(ts) AS ts FROM runs WHERE config IN ('active', 'candidate', 'audit')",
		)
		.get();
	return row?.ts ?? null;
}

export interface GoldenReplicateRun {
	taskHash: string;
	rulesetVersion: number;
	/** Model the run executed under; empty string when unrecorded. */
	model: string;
	total: number;
}

/**
 * Completed plain active-set golden runs with their replicate-group keys.
 * Runs sharing (task, ruleset version, model) executed the identical
 * configuration, so within a group they are genuine repeated measurements of
 * the same distribution — the raw material for empirical (permutation /
 * bootstrap) calibration and for the power planner's per-task variance.
 * Only config='active': candidate/audit passes carry per-decision rule sets
 * that are not distinguishable from the row alone.
 */
export function goldenReplicateRuns(
	db: WardenDb,
	agent: string,
): GoldenReplicateRun[] {
	return db
		.prepare<unknown[], GoldenReplicateRun>(
			`SELECT task_hash AS taskHash, ruleset_version AS rulesetVersion,
				COALESCE(model, '') AS model, ${RUN_TOTAL_TOKENS_SQL} AS total
			 FROM runs
			 WHERE agent = ? AND task_hash IS NOT NULL AND completed = 1
				AND config = 'active'
			 ORDER BY task_hash ASC, ruleset_version ASC, ts ASC`,
		)
		.all(agent);
}

/** Totals of the agent's most recent completed real-work sessions
 * (excluding one run id), newest first — the baseline for anomaly alerting. */
export function recentRealWorkTotals(
	db: WardenDb,
	agent: string,
	limit: number,
	excludeRunId: number,
): number[] {
	return db
		.prepare<unknown[], { total: number }>(
			`SELECT ${RUN_TOTAL_TOKENS_SQL} AS total
			 FROM runs
			 WHERE agent = ? AND id != ? AND task_hash IS NULL AND completed = 1
			 ORDER BY ts DESC LIMIT ?`,
		)
		.all(agent, excludeRunId, limit)
		.map((row) => row.total);
}

export interface ProjectUsage {
	project: string | null;
	runs: number;
	tokens: number;
}

/** Real-work token volume per project, heaviest first. */
export function projectUsage(db: WardenDb, limit: number): ProjectUsage[] {
	return db
		.prepare<unknown[], ProjectUsage>(
			`SELECT project,
				COUNT(*) AS runs,
				COALESCE(SUM(${RUN_TOTAL_TOKENS_SQL}), 0) AS tokens
			 FROM runs WHERE task_hash IS NULL
			 GROUP BY project ORDER BY tokens DESC LIMIT ?`,
		)
		.all(limit);
}

/** One attributed tool/skill/MCP cost row for a single run. `group` maps to
 * the `grp` column (GROUP is reserved in SQL). */
export interface ToolCostInput {
	kind: string;
	group: string;
	label: string;
	calls: number;
	inputChars: number;
	resultChars: number;
}

/**
 * Replace the persisted per-tool costs for a run. The Stop hook upserts the
 * same run repeatedly with growing totals, so the costs are recomputed and
 * fully replaced each time rather than accumulated.
 */
export function recordToolCosts(
	db: WardenDb,
	runId: number,
	costs: ToolCostInput[],
): void {
	const insert = db.prepare(
		`INSERT INTO tool_costs (run_id, kind, grp, label, calls, input_chars, result_chars)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(run_id, kind, grp, label) DO UPDATE SET
			calls = excluded.calls,
			input_chars = excluded.input_chars,
			result_chars = excluded.result_chars`,
	);
	// One transaction so a reader never sees the run with its costs deleted but
	// not yet rewritten. The DELETE runs first, so the write lock is taken on
	// the transaction's first statement and busy_timeout covers the wait — no
	// read-then-write upgrade, which busy_timeout would not retry.
	db.transaction(() => {
		db.prepare("DELETE FROM tool_costs WHERE run_id = ?").run(runId);
		// The DELETE means the ON CONFLICT above can only fire for duplicate
		// (kind, grp, label) tuples inside a single `costs` array; last wins.
		for (const c of costs) {
			insert.run(
				runId,
				c.kind,
				c.group,
				c.label,
				c.calls,
				c.inputChars,
				c.resultChars,
			);
		}
	})();
}

export interface ToolCostRollup {
	kind: string;
	grp: string;
	label: string;
	sessions: number;
	calls: number;
	inputChars: number;
	resultChars: number;
}

export interface ToolCostFilter {
	agent?: string | null;
	kind?: string | null;
	limit: number;
}

/**
 * Cross-session tool-cost rollup over real-work runs (task_hash IS NULL),
 * grouped by (kind, group, label) and ordered by total footprint. Optional
 * filters narrow to one agent or one kind.
 */
export function toolCostRollup(
	db: WardenDb,
	filter: ToolCostFilter,
): ToolCostRollup[] {
	return db
		.prepare<unknown[], ToolCostRollup>(
			`SELECT tc.kind AS kind, tc.grp AS grp, tc.label AS label,
				COUNT(DISTINCT tc.run_id) AS sessions,
				SUM(tc.calls) AS calls,
				SUM(tc.input_chars) AS inputChars,
				SUM(tc.result_chars) AS resultChars
			 FROM tool_costs tc
			 JOIN runs r ON r.id = tc.run_id
			 WHERE r.task_hash IS NULL
				AND (? IS NULL OR r.agent = ?)
				AND (? IS NULL OR tc.kind = ?)
			 GROUP BY tc.kind, tc.grp, tc.label
			 ORDER BY (SUM(tc.input_chars) + SUM(tc.result_chars)) DESC, tc.label ASC
			 LIMIT ?`,
		)
		.all(
			filter.agent ?? null,
			filter.agent ?? null,
			filter.kind ?? null,
			filter.kind ?? null,
			filter.limit,
		);
}

/**
 * A full verdict snapshot recorded when the selector decides a rule. Beyond
 * the token delta it captures the *quality* axis — per-task pass/fail and the
 * tool-call / file-reread activity with vs. without the rule — so a "false
 * economy" rule (cheap because it skipped necessary work) is visible, plus the
 * provenance needed to trust the receipt elsewhere (model, suite hash).
 */
export interface NewReceipt {
	ruleId: number;
	agent: string;
	decidedAt: string;
	status: string;
	kind: string;
	reason: string;
	model: string | null;
	fixtureHash: string | null;
	runs: number;
	delta: number | null;
	contextCost: number;
	standardError: number | null;
	regression: boolean;
	withTokens: number;
	withoutTokens: number;
	withToolCalls: number;
	withoutToolCalls: number;
	withFileRereads: number;
	withoutFileRereads: number;
	tasksTotal: number;
	tasksPassedWith: number;
	tasksPassedWithout: number;
}

export interface ReceiptRow {
	rule_id: number;
	agent: string;
	decided_at: string;
	status: string;
	kind: string;
	reason: string | null;
	model: string | null;
	fixture_hash: string | null;
	runs: number;
	delta: number | null;
	context_cost: number;
	standard_error: number | null;
	regression: number;
	with_tokens: number;
	without_tokens: number;
	with_tool_calls: number;
	without_tool_calls: number;
	with_file_rereads: number;
	without_file_rereads: number;
	tasks_total: number;
	tasks_passed_with: number;
	tasks_passed_without: number;
	/** The rule body, joined from `rules` for rendering. */
	body: string;
	/** Provenance digest of the rule's born-of session, joined from `rules`. */
	born_digest: string | null;
}

/**
 * Append a verdict receipt. One row per decision event (initial + each
 * re-audit), keyed by rule and timestamp — the audit trail of a rule.
 *
 * APPEND means append. This used to be `INSERT OR REPLACE`, so two decisions on
 * one rule bearing the same millisecond timestamp silently overwrote each other
 * — a lost entry in what this comment itself calls an audit trail, and lost in
 * the way this project keeps finding: no error, just one fewer row than there
 * were events.
 *
 * The primary key is `(rule_id, decided_at)` and migrations are append-only
 * history, so the collision is resolved here instead: advance the timestamp by
 * a millisecond until the row lands. That records the ORDER of two same-tick
 * decisions truthfully at the cost of at most a few milliseconds of absolute
 * precision, which is the right trade for an audit trail — losing the event
 * entirely is not recoverable, a 1 ms skew is not misleading.
 */
export function recordReceipt(db: WardenDb, receipt: NewReceipt): void {
	const insert = db.prepare(
		`INSERT INTO rule_receipts (
			rule_id, agent, decided_at, status, kind, reason, model, fixture_hash,
			runs, delta, context_cost, standard_error, regression,
			with_tokens, without_tokens, with_tool_calls, without_tool_calls,
			with_file_rereads, without_file_rereads,
			tasks_total, tasks_passed_with, tasks_passed_without
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const run = (decidedAt: string): void => {
		insert.run(
			receipt.ruleId,
			receipt.agent,
			decidedAt,
			receipt.status,
			receipt.kind,
			receipt.reason,
			receipt.model,
			receipt.fixtureHash,
			receipt.runs,
			receipt.delta,
			receipt.contextCost,
			receipt.standardError,
			receipt.regression ? 1 : 0,
			receipt.withTokens,
			receipt.withoutTokens,
			receipt.withToolCalls,
			receipt.withoutToolCalls,
			receipt.withFileRereads,
			receipt.withoutFileRereads,
			receipt.tasksTotal,
			receipt.tasksPassedWith,
			receipt.tasksPassedWithout,
		);
	};

	let stamp = receipt.decidedAt;
	// Bounded: a handful of same-millisecond decisions on ONE rule is already an
	// edge case, and an unbounded loop in the write path is worse than the
	// collision it guards. Past the cap the original timestamp is used, which
	// restores the old overwrite rather than throwing away the caller's write.
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			run(stamp);
			return;
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			stamp = new Date(new Date(stamp).getTime() + 1).toISOString();
		}
	}
	db.prepare(
		"DELETE FROM rule_receipts WHERE rule_id = ? AND decided_at = ?",
	).run(receipt.ruleId, receipt.decidedAt);
	run(receipt.decidedAt);
}

/** A primary-key collision, as distinct from any other database failure —
 * which must still propagate rather than be retried into a nudged timestamp. */
function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Error &&
		/UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(error.message)
	);
}

/** The most recent receipt per rule for an agent, joined with the rule body,
 * best measured savings first. */
export function latestReceipts(db: WardenDb, agent: string): ReceiptRow[] {
	return db
		.prepare<unknown[], ReceiptRow>(
			`SELECT rc.*, r.body AS body, r.born_digest AS born_digest
			 FROM rule_receipts rc
			 JOIN rules r ON r.id = rc.rule_id
			 WHERE rc.agent = ?
				AND rc.decided_at = (
					SELECT MAX(decided_at) FROM rule_receipts WHERE rule_id = rc.rule_id
				)
			 ORDER BY (rc.delta IS NULL), rc.delta DESC, rc.rule_id ASC`,
		)
		.all(agent);
}

/** Pending candidate counts per agent — the SessionStart nudge. */
export function candidateCounts(
	db: WardenDb,
): { agent: string; pending: number }[] {
	return db
		.prepare<unknown[], { agent: string; pending: number }>(
			`SELECT agent, COUNT(*) AS pending FROM rules
			 WHERE status = 'candidate' GROUP BY agent ORDER BY pending DESC`,
		)
		.all();
}

export interface QuestionCount {
	from_agent: string;
	asked: number;
	approved: number;
}

/** Outbound question volume per agent — high volume from an agent is a
 * distiller signal that its memory is missing something. */
export function questionCounts(db: WardenDb): QuestionCount[] {
	return db
		.prepare<unknown[], QuestionCount>(
			`SELECT from_agent,
				COUNT(*) AS asked,
				COALESCE(SUM(approved = 1), 0) AS approved
			 FROM questions GROUP BY from_agent ORDER BY asked DESC`,
		)
		.all();
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
