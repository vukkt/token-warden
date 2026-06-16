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
];

/** Current schema version — what `PRAGMA user_version` reads after openDb. */
export const MIGRATION_COUNT = MIGRATIONS.length;

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

/** Which rule configuration produced a run: 'real' for collected work
 * sessions, 'active' for plain active-set golden runs (the only kind that
 * feeds baselines and learning curves), 'candidate'/'audit' for selector
 * measurement runs. */
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
				completed, ruleset_version, ts, config, project, model
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				model = excluded.model
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
	decided_reason: string | null;
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
	if (row === undefined) throw new Error("bumpRulesetVersion produced no row");
	return row.version;
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
	if (row === undefined) throw new Error("insertQuestion produced no row");
	return row.id;
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
	// COALESCE so NULL-project rows group as "(unknown)" instead of being
	// silently dropped by IN's three-valued NULL semantics.
	return db
		.prepare<unknown[], ProjectCurvePoint>(
			`SELECT COALESCE(project, '(unknown)') AS project,
				ruleset_version AS rulesetVersion,
				COUNT(*) AS runs,
				CAST(AVG(${RUN_TOTAL_TOKENS_SQL}) AS INTEGER) AS avgTokens
			 FROM runs
			 WHERE task_hash IS NULL AND completed = 1 AND agent != 'main'
				AND COALESCE(project, '(unknown)') IN (
					SELECT COALESCE(project, '(unknown)') FROM runs
					WHERE task_hash IS NULL AND completed = 1 AND agent != 'main'
					GROUP BY COALESCE(project, '(unknown)')
					ORDER BY SUM(${RUN_TOTAL_TOKENS_SQL}) DESC
					LIMIT ?
				)
			 GROUP BY COALESCE(project, '(unknown)'), ruleset_version
			 ORDER BY project, ruleset_version`,
		)
		.all(limit);
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
	db.transaction(() => {
		db.prepare("DELETE FROM tool_costs WHERE run_id = ?").run(runId);
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
}

/** Append a verdict receipt. One row per decision event (initial + each
 * re-audit), keyed by rule and timestamp — the audit trail of a rule. */
export function recordReceipt(db: WardenDb, receipt: NewReceipt): void {
	db.prepare(
		`INSERT OR REPLACE INTO rule_receipts (
			rule_id, agent, decided_at, status, kind, reason, model, fixture_hash,
			runs, delta, context_cost, standard_error, regression,
			with_tokens, without_tokens, with_tool_calls, without_tool_calls,
			with_file_rereads, without_file_rereads,
			tasks_total, tasks_passed_with, tasks_passed_without
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		receipt.ruleId,
		receipt.agent,
		receipt.decidedAt,
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
}

/** The most recent receipt per rule for an agent, joined with the rule body,
 * best measured savings first. */
export function latestReceipts(db: WardenDb, agent: string): ReceiptRow[] {
	return db
		.prepare<unknown[], ReceiptRow>(
			`SELECT rc.*, r.body AS body
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
