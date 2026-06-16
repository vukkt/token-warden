/**
 * No-token DRESS REHEARSAL of the full burn pipeline (spends NO claude tokens).
 *
 * Drives the entire loop with a SIMULATED agent instead of real `claude`:
 * expensive v0 sessions → distill trigger → a candidate → the real selector
 * (with a fake suite runner) keeps it → compile → receipts → cheaper v1
 * sessions → the v0→v1 learning curve. Everything except the `claude`
 * subprocess is the real plugin code, on a throwaway DB.
 *
 * This proves the machinery is wired and shows the report shape the REAL burn
 * (validation/run.sh, or warden-burn-sql/RUNBOOK.md) will produce. It does NOT
 * validate the thesis — only real `claude` runs measure real token savings.
 *
 * Run: npx tsx validation/dress-rehearsal.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSummary } from "../src/bench.js";
import {
	insertRule,
	type NewRun,
	openDb,
	type RuleRow,
	recordBaseline,
	upsertRun,
} from "../src/db.js";
import { shouldDistill } from "../src/distill.js";
import { renderReceipts } from "../src/receipt.js";
import { type SuiteRunner, selectForAgent } from "../src/select.js";
import { renderStatus } from "../src/status.js";

const dir = mkdtempSync(join(tmpdir(), "warden-dress-rehearsal-"));
process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
const db = openDb(join(dir, "warden.db"));
const agent = "sql";

const log = (s: string) => console.log(s);
const realRun = (
	sessionId: string,
	total: number,
	version: number,
): NewRun => ({
	agent,
	sessionId,
	taskHash: null,
	inputTokens: total,
	outputTokens: 0,
	cacheCreation: 0,
	cacheRead: 0,
	toolCalls: 6,
	fileRereads: 2,
	completed: true,
	rulesetVersion: version,
	ts: new Date().toISOString(),
	config: "real",
	project: "/projects/warden-burn-sql",
});
const summary = (taskId: string, tokens: number): TaskSummary => ({
	taskId,
	results: [{ sessionId: `${taskId}-s`, tokens, completed: true }],
	meanCompletedTokens: tokens,
	highVariance: false,
});

log("════ token-warden dress rehearsal (simulated agent, 0 tokens) ════\n");

// Phase 0 — features 1–6 collected as expensive v0 real-work sessions.
log("Phase 0 · collect 6 v0 sessions (features 1–6, no rules yet)");
for (let i = 1; i <= 5; i++) upsertRun(db, realRun(`feat-${i}`, 12_000, 0));
const spike = upsertRun(db, realRun("feat-6", 30_000, 0));
log(`  feature 6 spiked to 30,000 tokens.`);
log(
	`  distiller trigger (real shouldDistill): ${shouldDistill(db, agent, spike, 30_000)} ` +
		"→ a candidate would be distilled.\n",
);

// The distiller would propose this; inject it as a candidate.
const body =
	"Use Grep or Glob to find the symbol or schema before reading whole files.";
const candidate = insertRule(db, {
	agent,
	body,
	contextCost: Math.ceil(body.length / 4),
	sourceRun: spike,
	createdAt: new Date().toISOString(),
});
log(`Phase 1 · select — candidate #${candidate} measured on the golden suite`);

// Freeze suite baselines (run1) so the suite-vs-run1 line renders too.
for (const t of ["sql-01", "sql-02", "sql-03"])
	recordBaseline(db, agent, t, 10_000, "t");

// Real selector, fake suite runner (no claude): the rule saves ~3k/run.
const runner: SuiteRunner = (rules: RuleRow[]) => {
	const cost = rules.some((r) => r.id === candidate) ? 7_000 : 10_000;
	return [
		summary("sql-01", cost),
		summary("sql-02", cost),
		summary("sql-03", cost),
	];
};
const report = selectForAgent(db, agent, runner, {
	measuredModel: "sonnet (simulated)",
	fixtureHash: "rehearsal",
});
for (const d of report.decisions) {
	log(`  rule #${d.rule.id} → ${d.status.toUpperCase()} (delta=${d.delta})`);
}
// Record the post-rule golden run so "now vs run1" reflects the win.
for (const t of ["sql-01", "sql-02", "sql-03"]) {
	upsertRun(db, {
		...realRun(`golden-${t}`, 7_000, report.rulesetVersion ?? 1),
		taskHash: t,
		config: "active",
	});
}

// Phase 2 — features 7–10 collected as cheaper v1 sessions (rule in memory).
log("\nPhase 2 · collect 4 v1 sessions (features 7–10, rule active)");
for (let i = 7; i <= 10; i++) {
	upsertRun(db, realRun(`feat-${i}`, 8_000, report.rulesetVersion ?? 1));
}

log("\n════ REPORT (what your real Checkpoint B will look like) ════\n");
log(renderStatus(db));
log(`\n${renderReceipts(db, agent)}`);

rmSync(dir, { recursive: true, force: true });
