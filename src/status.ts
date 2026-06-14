/**
 * Read-only status report backing the /warden-status command.
 *
 * CLI: npx tsx src/status.ts
 *
 * Renders, per agent: collected runs, rule counts by status, current
 * golden-suite total vs the frozen run1 baseline, a learning curve of
 * golden-run costs over time, and the rule ledger (active rules plus the
 * last 5 evictions with reasons). Writes nothing.
 */
import { pathToFileURL } from "node:url";
import {
	getActiveRules,
	getRulesetVersion,
	lastEvictions,
	openDb,
	projectUsage,
	questionCounts,
	type RealWorkPoint,
	realWorkCurveByAgent,
	realWorkCurveByProject,
	type WardenDb,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

const TOTAL_SQL = "input_tokens + output_tokens + cache_creation + cache_read";

/**
 * Neutralize untrusted strings before rendering: rule bodies and eviction
 * reasons are model-generated, project paths and question senders come from
 * the environment. Stripping ANSI/control characters and collapsing
 * newlines means collected data cannot fake report lines or sections;
 * clamping keeps one weird value from flooding the report.
 */
export function displayText(value: string, max = 300): string {
	const cleaned = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
		.replace(/\x1b\[[0-9;]*[A-Za-z]|[\x00-\x1f\x7f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/** Signed percent change of current vs baseline, e.g. "-5.7%". */
export function pctChange(current: number, baseline: number): string {
	if (baseline === 0) return "n/a";
	const change = ((current - baseline) / baseline) * 100;
	const sign = change > 0 ? "+" : "";
	return `${sign}${change.toFixed(1)}%`;
}

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

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

/** "v0 48,770 (n=3) → v2 31,002 (n=5)  [-36.4% vs v0]" */
export function formatRealWorkCurve(points: RealWorkPoint[]): string {
	const sequence = points
		.map(
			(p) => `v${p.rulesetVersion} ${formatTokens(p.avgTokens)} (n=${p.runs})`,
		)
		.join(" → ");
	const first = points[0];
	const last = points[points.length - 1];
	if (points.length < 2 || first === undefined || last === undefined) {
		return sequence;
	}
	return `${sequence}  [${pctChange(last.avgTokens, first.avgTokens)} vs v${first.rulesetVersion}]`;
}

export function renderStatus(db: WardenDb): string {
	const lines: string[] = [];
	lines.push("token-warden status");
	lines.push("");

	lines.push(
		"agent     | runs real/golden | rules act/cand/evict | suite now vs run1 (frozen)",
	);
	lines.push(
		"----------|------------------|----------------------|---------------------------",
	);
	for (const agent of [...DOMAIN_AGENTS, "main"]) {
		const runs = runCounts(db, agent);
		const rules = ruleCounts(db, agent);
		const suite = suiteComparison(db, agent);
		const suiteText = suite
			? `${formatTokens(suite.currentTotal)} vs ${formatTokens(suite.run1Total)} (${pctChange(suite.currentTotal, suite.run1Total)}, best ${formatTokens(suite.bestTotal)})`
			: "no baselines";
		lines.push(
			`${agent.padEnd(9)} | ${String(runs.real).padStart(6)} / ${String(runs.golden).padEnd(6)} | ${`${rules.active}/${rules.candidate}/${rules.evicted}`.padEnd(20)} | ${suiteText}`,
		);
	}

	lines.push("");
	lines.push("Learning curve (avg completed golden-run tokens by day):");
	let anyCurve = false;
	for (const agent of DOMAIN_AGENTS) {
		const curve = learningCurve(db, agent);
		if (curve.length === 0) continue;
		anyCurve = true;
		const points = curve
			.map((p) => `${p.day}: ${formatTokens(p.avgTokens)} (n=${p.runs})`)
			.join("  |  ");
		lines.push(
			`  ${agent} (ruleset v${getRulesetVersion(db, agent)}): ${points}`,
		);
	}
	if (!anyCurve) lines.push("  no golden runs recorded yet");

	lines.push("");
	lines.push("Active rules:");
	let anyActive = false;
	for (const agent of DOMAIN_AGENTS) {
		for (const rule of getActiveRules(db, agent)) {
			anyActive = true;
			const provenance =
				rule.source_run !== null ? ` born-of=run#${rule.source_run}` : "";
			lines.push(
				`  [${agent} #${rule.id}] delta=+${rule.measured_delta} rent=${rule.context_cost}${provenance} "${displayText(rule.body)}"`,
			);
		}
	}
	if (!anyActive) lines.push("  none");

	lines.push("");
	lines.push("Last evictions (max 5 per agent):");
	let anyEvicted = false;
	for (const agent of DOMAIN_AGENTS) {
		for (const rule of lastEvictions(db, agent, 5)) {
			anyEvicted = true;
			lines.push(
				`  [${agent} #${rule.id}] delta=${rule.measured_delta ?? "n/a"} — ${displayText(rule.decided_reason ?? "no reason recorded")} — "${displayText(rule.body)}"`,
			);
		}
	}
	if (!anyEvicted) lines.push("  none");

	lines.push("");
	lines.push(
		"Real-work learning (avg completed session tokens per ruleset version; domain agents only — rules never apply to 'main'):",
	);
	let anyRealWork = false;
	for (const agent of DOMAIN_AGENTS) {
		const curve = realWorkCurveByAgent(db, agent);
		if (curve.length === 0) continue;
		anyRealWork = true;
		lines.push(`  ${agent}: ${formatRealWorkCurve(curve)}`);
	}
	if (!anyRealWork) {
		lines.push("  no completed real-work sessions from domain agents yet");
	}

	lines.push("");
	lines.push("Real-work learning by project (domain agents pooled):");
	const projectCurves = realWorkCurveByProject(db, 5);
	if (projectCurves.length === 0) {
		lines.push("  none recorded yet");
	} else {
		const byProject = new Map<string, RealWorkPoint[]>();
		for (const point of projectCurves) {
			const key = point.project ?? "(unknown)";
			const list = byProject.get(key) ?? [];
			list.push(point);
			byProject.set(key, list);
		}
		for (const [project, points] of byProject) {
			lines.push(`  ${displayText(project)}: ${formatRealWorkCurve(points)}`);
		}
	}

	lines.push("");
	lines.push("Real-work tokens by project:");
	const projects = projectUsage(db, 5);
	if (projects.length === 0) {
		lines.push("  none recorded");
	} else {
		for (const usage of projects) {
			lines.push(
				`  ${displayText(usage.project ?? "(unknown)")} — ${usage.runs} session(s), ${formatTokens(usage.tokens)} tokens`,
			);
		}
	}

	lines.push("");
	lines.push(
		"Cross-agent questions (high volume = that agent's memory is missing something):",
	);
	const counts = questionCounts(db);
	if (counts.length === 0) {
		lines.push("  none recorded");
	} else {
		for (const count of counts) {
			lines.push(
				`  ${displayText(count.from_agent, 60)}: asked ${count.asked}, approved ${count.approved}`,
			);
		}
	}

	return lines.join("\n");
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		const db = openDb();
		try {
			console.log(renderStatus(db));
		} finally {
			db.close();
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
