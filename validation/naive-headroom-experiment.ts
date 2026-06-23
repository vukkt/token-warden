/**
 * NAIVE-HEADROOM EXPERIMENT — the cleanest path to the project's first
 * *surviving* rule (spends REAL claude tokens; gated behind --yes).
 *
 * Why: every rule the burns tested was evicted because the shipped agents are
 * already optimized — their prompts already say "grep before reading, never
 * re-read, plan first", so an obvious efficiency rule duplicates the prompt
 * (zero behaviour change + context rent + noise → net negative). See
 * FINDINGS.md and the 2026-06 dogfood.
 *
 * This removes that confound by measuring against a DELIBERATELY NAIVE sql
 * agent (validation/naive-sql.md) whose prompt lacks the efficiency guidance,
 * so the agent genuinely wastes tokens and a "grep before reading" rule has
 * real headroom to save. It runs the suite WITHOUT and WITH the rule using the
 * real runSuite + the real assessDelta verdict math (definitionOverride — no
 * shipped code is touched), against an isolated DB.
 *
 * If the rule SURVIVES here (delta >= 2x rent, no regression, not within
 * noise), the full collect -> distill -> bench -> select loop is demonstrated
 * end-to-end banking a measured rule.
 *
 * Run (spends tokens):
 *   npx tsx validation/naive-headroom-experiment.ts --yes [--runs 2]
 * Dry run (default, no tokens) just prints the plan and cost estimate.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentDefinition,
	loadGoldenTasks,
	parseAgentDefinition,
	runSuite,
} from "../src/bench.js";
import { insertRule, openDb, type RuleRow } from "../src/db.js";
import { assessDelta, effectiveRent } from "../src/select.js";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT = "sql";
const CANDIDATE =
	"Use Grep or Glob to locate the relevant symbol or file before reading whole files.";

function parseArgs(argv: string[]): { runs: number; yes: boolean } {
	let runs = 2;
	let yes = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--yes") yes = true;
		else if (argv[i] === "--runs") runs = Number(argv[++i]);
	}
	if (!Number.isInteger(runs) || runs < 1)
		throw new Error("--runs must be >= 1");
	return { runs, yes };
}

function main(): void {
	const { runs, yes } = parseArgs(process.argv.slice(2));
	const tasks = loadGoldenTasks(AGENT);
	const sessions = tasks.length * runs * 2; // without + with
	const rent = Math.ceil(CANDIDATE.length / 4);

	console.log("═══ naive-headroom experiment ═══");
	console.log(`agent: ${AGENT} (NAIVE def: validation/naive-sql.md)`);
	console.log(`candidate rule (rent=${rent}): "${CANDIDATE}"`);
	console.log(`tasks: ${tasks.map((t) => t.id).join(", ")}`);
	console.log(
		`plan: ${tasks.length} tasks x ${runs} runs x 2 configs = ${sessions} sessions`,
	);
	console.log(
		`rough cost: ~${(sessions * 70).toLocaleString()}k–${(sessions * 100).toLocaleString()}k tokens (naive agent runs heavier than the optimized one)`,
	);

	if (!yes) {
		console.log(
			"\nDRY RUN — no tokens spent. Re-run with --yes to execute. Watch /usage; you are the circuit breaker.",
		);
		return;
	}

	const naive: AgentDefinition = parseAgentDefinition(
		readFileSync(join(here, "naive-sql.md"), "utf8"),
		join(here, "naive-sql.md"),
	);
	const db = openDb();
	const ruleId = insertRule(db, {
		agent: AGENT,
		body: CANDIDATE,
		contextCost: rent,
		sourceRun: null,
		createdAt: new Date().toISOString(),
	});
	const rule = db
		.prepare<[number], RuleRow>("SELECT * FROM rules WHERE id = ?")
		.get(ruleId);
	if (!rule) throw new Error("failed to load inserted candidate");

	console.log("\n── measuring WITHOUT the rule (naive baseline) ──");
	const without = runSuite(db, AGENT, tasks, {
		rules: [],
		runs,
		recordBaselines: false,
		rulesetVersion: 0,
		label: "without",
		config: "candidate",
		definitionOverride: naive,
	});

	console.log("\n── measuring WITH the rule ──");
	const withRule = runSuite(db, AGENT, tasks, {
		rules: [rule],
		runs,
		recordBaselines: false,
		rulesetVersion: 1,
		label: "with-rule",
		config: "candidate",
		definitionOverride: naive,
	});

	const assessment = assessDelta(without, withRule, rent);
	const threshold = Math.round(2 * effectiveRent(rent));

	console.log("\n═══ VERDICT ═══");
	console.log("per task: without → with");
	for (const w of without) {
		const m = withRule.find((x) => x.taskId === w.taskId);
		const d = m ? w.meanCompletedTokens - m.meanCompletedTokens : null;
		console.log(
			`  ${w.taskId}: ${w.meanCompletedTokens} → ${m?.meanCompletedTokens ?? "—"}  ${d === null ? "(incomplete)" : `delta=${d > 0 ? "+" : ""}${d}`}`,
		);
	}
	console.log(
		`\nmean delta=${assessment.delta} tok/run  rent=${rent}  threshold(2x cache-aware)=${threshold}  stderr=${assessment.standardError?.toFixed(0) ?? "n/a"} (${assessment.standardErrorBasis ?? "—"})`,
	);
	if (assessment.regression) {
		console.log("[EVICT] the rule broke a task (regression).");
	} else if (
		assessment.delta !== null &&
		assessment.delta >= threshold &&
		!assessment.uncertain
	) {
		console.log(
			`[SURVIVES] saved ${assessment.delta} tok/run >= 2x rent (${threshold}). The loop banks its first measured rule.`,
		);
	} else if (assessment.uncertain) {
		console.log(
			"[INCONCLUSIVE] within noise — point estimate near the threshold; the real selector would spend a top-up pass. Re-run with more --runs.",
		);
	} else {
		console.log(
			`[EVICT] ${assessment.delta} tok/run did not clear 2x rent (${threshold}).`,
		);
	}
	db.close();
}

main();
