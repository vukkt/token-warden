/**
 * Validation-harness self-test (spends NO claude tokens).
 *
 * Seeds an isolated DB with a synthetic before/after — expensive real-work
 * sessions at ruleset v0, then cheaper ones at v1 after a rule was compiled,
 * plus a golden suite whose current cost is below the frozen run1 — and prints
 * the report. If the learning curve bends down and the suite shows a negative
 * "% vs run1", the measurement + reporting machinery correctly detects and
 * surfaces savings. That validates the HARNESS; only validation/run.sh with
 * real `claude` runs validates the THESIS.
 *
 * Run: npx tsx validation/selftest.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NewRun, openDb, recordBaseline, upsertRun } from "../src/db.js";
import { renderStatus } from "../src/status.js";

const dir = mkdtempSync(join(tmpdir(), "warden-validation-selftest-"));
const db = openDb(join(dir, "warden.db"));
const agent = "sql";

function realRun(sessionId: string, total: number, version: number): NewRun {
	return {
		agent,
		sessionId,
		taskHash: null, // real work
		inputTokens: total,
		outputTokens: 0,
		cacheCreation: 0,
		cacheRead: 0,
		toolCalls: 6,
		fileRereads: 2,
		completed: true,
		rulesetVersion: version,
		ts: "2026-06-16T00:00:00Z",
		config: "real",
		project: "/some/real/project",
	};
}

// Real-work learning curve: 5 expensive sessions before any rule (v0), then 5
// cheaper sessions after a rule was compiled (v1) — a ~33% drop.
for (let i = 0; i < 5; i++) upsertRun(db, realRun(`v0-${i}`, 12_000, 0));
for (let i = 0; i < 5; i++) upsertRun(db, realRun(`v1-${i}`, 8_000, 1));

// Golden suite: freeze run1, then record a cheaper active run so "now vs run1"
// shows the gain the rule bought.
for (const task of ["sql-01", "sql-02", "sql-03"]) {
	recordBaseline(db, agent, task, 10_000, "t1");
	upsertRun(db, {
		agent,
		sessionId: `golden-${task}`,
		taskHash: task,
		inputTokens: 7_000,
		outputTokens: 0,
		cacheCreation: 0,
		cacheRead: 0,
		toolCalls: 4,
		fileRereads: 0,
		completed: true,
		rulesetVersion: 1,
		ts: "2026-06-16T01:00:00Z",
		config: "active",
	});
}

console.log(renderStatus(db));
console.log(
	"\n[selftest] If 'sql' shows a negative '% vs run1' and the real-work curve" +
		"\n[selftest] reads v0 12,000 → v1 8,000, the harness measures savings correctly.",
);
db.close();
