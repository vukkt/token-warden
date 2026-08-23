/**
 * Read-only status report backing the /warden-status command.
 *
 * CLI: npx tsx src/status.ts
 *
 * Renders, per agent: collected runs, rule counts by status, current
 * golden-suite total vs the frozen run1 baseline, a learning curve of
 * golden-run costs over time, and the rule ledger (active rules plus the
 * last 5 evictions with reasons).
 *
 * SAFETY INVARIANT — this module is strictly read-only. It imports only
 * SELECT-side helpers from db.ts and issues only SELECT statements; nothing
 * here writes, decides, evicts, or recompiles memory. `gatherStatus` is the
 * only function that touches the database; `formatStatus` is pure, so the
 * whole report is assertable without a DB. Keep it that way: a new section
 * adds a field to `StatusData`, never a write.
 *
 * SECURITY — rule bodies and eviction reasons are model-generated, and project
 * paths and tool/skill/MCP names come from the environment. Every one of them
 * is rendered through `displayText`, which strips ANSI escapes and control
 * characters and collapses newlines, so collected data can never forge a
 * report line or a section header.
 */
import { runCli } from "./cli.js";
import {
	getActiveRules,
	getRulesetVersion,
	lastEvictions,
	type ProjectCurvePoint,
	type ProjectUsage,
	projectUsage,
	type RealWorkPoint,
	RUN_TOTAL_TOKENS_SQL,
	realWorkCurveByAgent,
	realWorkCurveByProject,
	type ToolCostRollup,
	toolCostRollup,
	type WardenDb,
	withDb,
} from "./db.js";
import { formatNumber as fmt, pctChange } from "./format.js";
import { knownAgents } from "./registry.js";
import { displayText } from "./sanitize.js";
import { CHARS_PER_TOKEN } from "./stats.js";

const TOTAL_SQL = RUN_TOTAL_TOKENS_SQL;

/** Projects and tool costs shown in the report. */
const PROJECT_LIMIT = 5;
const TOOL_COST_LIMIT = 8;
/** Evictions listed per agent. */
const EVICTION_LIMIT = 5;

/** Signed percent change of current vs baseline, e.g. "-5.7%". */
export interface SuiteComparison {
	taskCount: number;
	currentTotal: number;
	run1Total: number;
	bestTotal: number;
}

/** Sum the latest completed golden-run cost per baselined task and compare
 * with the frozen run1 totals. Null when the agent has no baselines. */
export function suiteComparison(
	db: WardenDb,
	agent: string,
): SuiteComparison | null {
	const baselines = db
		.prepare<
			unknown[],
			{ task_hash: string; run1_tokens: number; best_tokens: number }
		>(
			"SELECT task_hash, run1_tokens, best_tokens FROM baselines WHERE agent = ?",
		)
		.all(agent);
	if (baselines.length === 0) return null;

	let currentTotal = 0;
	let run1Total = 0;
	let bestTotal = 0;
	const latestStmt = db.prepare<unknown[], { total: number }>(
		`SELECT ${TOTAL_SQL} AS total FROM runs
		 WHERE agent = ? AND task_hash = ? AND completed = 1 AND config = 'active'
		 ORDER BY ts DESC LIMIT 1`,
	);
	for (const baseline of baselines) {
		const latest = latestStmt.get(agent, baseline.task_hash);
		currentTotal += latest?.total ?? baseline.run1_tokens;
		run1Total += baseline.run1_tokens;
		bestTotal += baseline.best_tokens;
	}
	return { taskCount: baselines.length, currentTotal, run1Total, bestTotal };
}

interface RunCounts {
	real: number;
	golden: number;
}

function runCounts(db: WardenDb, agent: string): RunCounts {
	// "golden" counts the agent's own golden-suite history only. A/B
	// comparison runs (modelbench/promptbench) also carry a task_hash but are
	// not history, so the golden count whitelists the history configs — new
	// comparison kinds are then excluded automatically.
	const row = db
		.prepare<unknown[], { real: number; golden: number }>(
			`SELECT
				COALESCE(SUM(task_hash IS NULL), 0) AS real,
				COALESCE(SUM(task_hash IS NOT NULL
					AND config IN ('active', 'candidate', 'audit')), 0) AS golden
			 FROM runs WHERE agent = ?`,
		)
		.get(agent);
	return row ?? { real: 0, golden: 0 };
}

interface RuleCounts {
	active: number;
	candidate: number;
	evicted: number;
}

function ruleCounts(db: WardenDb, agent: string): RuleCounts {
	const counts: RuleCounts = { active: 0, candidate: 0, evicted: 0 };
	const rows = db
		.prepare<unknown[], { status: string; n: number }>(
			"SELECT status, COUNT(*) AS n FROM rules WHERE agent = ? GROUP BY status",
		)
		.all(agent);
	for (const row of rows) {
		if (row.status === "active") counts.active = row.n;
		else if (row.status === "candidate") counts.candidate = row.n;
		else if (row.status === "evicted") counts.evicted = row.n;
	}
	return counts;
}

interface CurvePoint {
	day: string;
	runs: number;
	avgTokens: number;
}

function learningCurve(db: WardenDb, agent: string): CurvePoint[] {
	return db
		.prepare<unknown[], CurvePoint>(
			`SELECT substr(ts, 1, 10) AS day,
				COUNT(*) AS runs,
				CAST(AVG(${TOTAL_SQL}) AS INTEGER) AS avgTokens
			 FROM runs
			 WHERE agent = ? AND task_hash IS NOT NULL AND completed = 1
				AND config = 'active'
			 GROUP BY day ORDER BY day`,
		)
		.all(agent);
}

/* ------------------------------------------------------------------ *
 * Data model — everything the report needs, gathered once, so that
 * formatting is a pure function of plain data.
 * ------------------------------------------------------------------ */

/** One row of the per-agent summary table. */
interface AgentSummary {
	agent: string;
	runs: RunCounts;
	rules: RuleCounts;
	suite: SuiteComparison | null;
}

/** One agent's golden-run learning curve (only agents with history appear). */
interface AgentCurve {
	agent: string;
	rulesetVersion: number;
	points: CurvePoint[];
}

/** An active rule as the ledger shows it. */
interface ActiveRuleEntry {
	agent: string;
	id: number;
	delta: number | null;
	rent: number;
	sourceRun: number | null;
	body: string;
}

/** An evicted rule as the ledger shows it. */
interface EvictionEntry {
	agent: string;
	id: number;
	delta: number | null;
	reason: string | null;
	body: string;
	/** True when the eviction was decided by the WIDTH of the measurement, not
	 * by its point estimate: the rule may be proposed again and re-measured.
	 * Surfaced because "we could not tell" and "it does not earn" are very
	 * different facts to read off the same line. */
	underpowered: boolean;
	/** Runs per side that verdict was decided at; a re-measurement needs more. */
	recoveryRuns: number | null;
}

/** One agent's real-work learning curve (only agents with sessions appear). */
interface AgentRealWork {
	agent: string;
	points: RealWorkPoint[];
}

/** The complete, DB-free input to `formatStatus`. */
export interface StatusData {
	agents: AgentSummary[];
	curves: AgentCurve[];
	activeRules: ActiveRuleEntry[];
	evictions: EvictionEntry[];
	realWork: AgentRealWork[];
	projectCurves: ProjectCurvePoint[];
	projects: ProjectUsage[];
	toolCosts: ToolCostRollup[];
}

/** Read every figure the report needs. SELECT-only: see the module invariant. */
export function gatherStatus(db: WardenDb): StatusData {
	const agents = knownAgents();
	const curves: AgentCurve[] = [];
	const activeRules: ActiveRuleEntry[] = [];
	const evictions: EvictionEntry[] = [];
	const realWork: AgentRealWork[] = [];

	for (const agent of agents) {
		const points = learningCurve(db, agent);
		if (points.length > 0) {
			curves.push({
				agent,
				rulesetVersion: getRulesetVersion(db, agent),
				points,
			});
		}
		for (const rule of getActiveRules(db, agent)) {
			activeRules.push({
				agent,
				id: rule.id,
				delta: rule.measured_delta,
				rent: rule.context_cost,
				sourceRun: rule.source_run,
				body: rule.body,
			});
		}
		for (const rule of lastEvictions(db, agent, EVICTION_LIMIT)) {
			evictions.push({
				agent,
				id: rule.id,
				delta: rule.measured_delta,
				reason: rule.decided_reason,
				body: rule.body,
				underpowered: rule.underpowered === 1,
				recoveryRuns: rule.recovery_runs,
			});
		}
		const realPoints = realWorkCurveByAgent(db, agent);
		if (realPoints.length > 0) realWork.push({ agent, points: realPoints });
	}

	return {
		// 'main' has a run/rule row but never rules of its own, so it is only
		// part of the summary table.
		agents: [...agents, "main"].map((agent) => ({
			agent,
			runs: runCounts(db, agent),
			rules: ruleCounts(db, agent),
			suite: suiteComparison(db, agent),
		})),
		curves,
		activeRules,
		evictions,
		realWork,
		projectCurves: realWorkCurveByProject(db, PROJECT_LIMIT),
		projects: projectUsage(db, PROJECT_LIMIT),
		toolCosts: toolCostRollup(db, { limit: TOOL_COST_LIMIT }),
	};
}

/* ------------------------------------------------------------------ *
 * Formatting — pure.
 * ------------------------------------------------------------------ */

/** A measured delta with an explicit sign, or "n/a" when never measured
 * (protected human-authored rules are active without a token measurement). */
function signedDelta(delta: number | null): string {
	if (delta === null) return "n/a";
	return delta > 0 ? `+${delta}` : String(delta);
}

/** "v0 48,770 (n=3) → v2 31,002 (n=5)  [-36.4% vs v0]" */
export function formatRealWorkCurve(points: RealWorkPoint[]): string {
	const sequence = points
		.map((p) => `v${p.rulesetVersion} ${fmt(p.avgTokens)} (n=${p.runs})`)
		.join(" → ");
	const first = points[0];
	const last = points[points.length - 1];
	if (points.length < 2 || first === undefined || last === undefined) {
		return sequence;
	}
	return `${sequence}  [${pctChange(last.avgTokens, first.avgTokens)} vs v${first.rulesetVersion}]`;
}

/** Blank line, heading, then the body — or a single placeholder when empty.
 * The one place section shape is decided, so every section matches. */
function section(title: string, body: string[], whenEmpty: string): string[] {
	return ["", title, ...(body.length > 0 ? body : [whenEmpty])];
}

function summaryTable(agents: AgentSummary[]): string[] {
	return [
		"agent     | runs real/golden | rules act/cand/evict | suite now vs run1 (frozen)",
		"----------|------------------|----------------------|---------------------------",
		...agents.map(({ agent, runs, rules, suite }) => {
			const suiteText = suite
				? `${fmt(suite.currentTotal)} vs ${fmt(suite.run1Total)} (${pctChange(suite.currentTotal, suite.run1Total)}, best ${fmt(suite.bestTotal)})`
				: "no baselines";
			const counts = `${rules.active}/${rules.candidate}/${rules.evicted}`;
			return `${agent.padEnd(9)} | ${String(runs.real).padStart(6)} / ${String(runs.golden).padEnd(6)} | ${counts.padEnd(20)} | ${suiteText}`;
		}),
	];
}

/** Group per-project curve points by project, preserving query order. */
function groupByProject(
	points: ProjectCurvePoint[],
): Map<string, RealWorkPoint[]> {
	const byProject = new Map<string, RealWorkPoint[]>();
	for (const point of points) {
		const key = point.project ?? "(unknown)";
		const list = byProject.get(key) ?? [];
		list.push(point);
		byProject.set(key, list);
	}
	return byProject;
}

/** Render the whole report from gathered data. Pure — no DB, no clock. */
export function formatStatus(data: StatusData): string {
	return [
		"token-warden status",
		"",
		...summaryTable(data.agents),

		...section(
			"Learning curve (avg completed golden-run tokens by day):",
			data.curves.map((c) => {
				const points = c.points
					.map((p) => `${p.day}: ${fmt(p.avgTokens)} (n=${p.runs})`)
					.join("  |  ");
				return `  ${c.agent} (ruleset v${c.rulesetVersion}): ${points}`;
			}),
			"  no golden runs recorded yet",
		),

		...section(
			"Active rules:",
			data.activeRules.map((r) => {
				const provenance =
					r.sourceRun !== null ? ` born-of=run#${r.sourceRun}` : "";
				return `  [${r.agent} #${r.id}] delta=${signedDelta(r.delta)} rent=${r.rent}${provenance} "${displayText(r.body)}"`;
			}),
			"  none",
		),

		...section(
			"Last evictions (max 5 per agent):",
			data.evictions.map((r) => {
				// An underpowered eviction is not a rejection, and the ledger must
				// not read like one: the effect was there, the evidence was not.
				const recoverable = r.underpowered
					? ` [UNDERPOWERED: not falsified, re-measurable at >${r.recoveryRuns ?? "?"} runs/side]`
					: "";
				return `  [${r.agent} #${r.id}] delta=${r.delta ?? "n/a"}${recoverable} — ${displayText(r.reason ?? "no reason recorded")} — "${displayText(r.body)}"`;
			}),
			"  none",
		),

		...section(
			"Real-work learning (avg completed session tokens per ruleset version; domain agents only — rules never apply to 'main'):",
			data.realWork.map(
				(w) => `  ${w.agent}: ${formatRealWorkCurve(w.points)}`,
			),
			"  no completed real-work sessions from domain agents yet",
		),

		...section(
			"Real-work learning by project (domain agents pooled):",
			[...groupByProject(data.projectCurves)].map(
				([project, points]) =>
					`  ${displayText(project)}: ${formatRealWorkCurve(points)}`,
			),
			"  none recorded yet",
		),

		...section(
			"Real-work tokens by project:",
			data.projects.map(
				(usage) =>
					`  ${displayText(usage.project ?? "(unknown)")} — ${usage.runs} session(s), ${fmt(usage.tokens)} tokens`,
			),
			"  none recorded",
		),

		...section(
			"Top tool / skill / MCP costs (real-work footprint, ≈tokens):",
			data.toolCosts.map((c) => {
				const estTokens = Math.round(
					(c.inputChars + c.resultChars) / CHARS_PER_TOKEN,
				);
				const where =
					c.kind === "builtin"
						? c.label
						: `${displayText(c.grp, 24)}/${c.label}`;
				return `  ${displayText(c.kind, 12).padEnd(7)} ${displayText(where, 40).padEnd(40)} ≈${fmt(estTokens)} tok (${c.calls} call(s), ${c.sessions} session(s))`;
			}),
			"  none recorded yet",
		),
	].join("\n");
}

export function renderStatus(db: WardenDb): string {
	return formatStatus(gatherStatus(db));
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	return withDb((db) => {
		console.log(renderStatus(db));
	});
});
/* v8 ignore stop */
