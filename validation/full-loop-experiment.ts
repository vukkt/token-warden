/**
 * FULL AUTONOMOUS-LOOP EXPERIMENT — does the system's OWN distilled rule survive?
 *
 * The naive-headroom experiment proved the engine banks a *curated* rule. This
 * proves the half that's still unproven on real tokens: the **distiller**. It
 * runs the real distiller logic (buildPrompt + the haiku call + parseRulesJson)
 * on a wasteful session transcript to get a rule the SYSTEM proposed, then
 * benchmarks that rule on the naive agent (real runSuite + assessDelta). If the
 * distilled rule survives, the autonomous collect -> distill -> bench -> select
 * loop is demonstrated end-to-end.
 *
 * Spends REAL tokens (one haiku distill call + the benchmark sessions); gated
 * behind --yes. Dry run by default.
 *
 * Input: a transcript from a wasteful (naive-agent) session. The easiest way to
 * produce one is to run `validation/naive-headroom-experiment.ts --yes` first
 * and point --transcript at one of the resulting session transcripts under
 * ~/.claude/projects/. Then:
 *
 *   npx tsx validation/full-loop-experiment.ts --transcript <path> --yes
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentDefinition,
	loadGoldenTasks,
	parseAgentDefinition,
	runSuite,
} from "../src/bench.js";
import { insertRule, openDb, type RuleRow, type RunRow } from "../src/db.js";
import { buildPrompt, contextCost, parseRulesJson } from "../src/distill.js";
import { assessDelta } from "../src/select.js";
import { digestTranscript } from "../src/transcript.js";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT = "sql";
const MAX_DIGEST_CHARS = 8000;

function parseArgs(argv: string[]): {
	transcript: string | null;
	runs: number;
	yes: boolean;
} {
	let transcript: string | null = null;
	let runs = 2;
	let yes = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--transcript") transcript = argv[++i] ?? null;
		else if (argv[i] === "--runs") runs = Number(argv[++i]);
		else if (argv[i] === "--yes") yes = true;
		else throw new Error(`unknown flag: ${argv[i]}`);
	}
	if (!Number.isInteger(runs) || runs < 1)
		throw new Error("--runs must be >= 1");
	return { transcript, runs, yes };
}

/** Run the real distiller pipeline on a transcript; return its proposed rule. */
function distillRule(transcriptPath: string): string | null {
	const digest = digestTranscript(
		readFileSync(transcriptPath, "utf8"),
		MAX_DIGEST_CHARS,
	);
	// The waste stats are context for the model; the digest is the real signal.
	const synthRun = {
		id: 0,
		agent: AGENT,
		session_id: "full-loop",
		task_hash: null,
		input_tokens: 80_000,
		output_tokens: 2_000,
		cache_creation: 0,
		cache_read: 0,
		tool_calls: 20,
		file_rereads: 4,
		completed: 1,
		ruleset_version: 0,
		ts: new Date().toISOString(),
		config: "real",
		project: null,
		model: null,
	} as unknown as RunRow;
	const prompt = buildPrompt(synthRun, digest, []);
	const model = process.env.TOKEN_WARDEN_DISTILL_MODEL ?? "sonnet";
	const claude = spawnSync(
		"claude",
		[
			"-p",
			prompt,
			"--model",
			model,
			"--max-turns",
			"1",
			"--output-format",
			"json",
		],
		{ encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
	);
	if (claude.error) throw claude.error;
	const out = JSON.parse(claude.stdout) as { result?: string };
	const rules = parseRulesJson(out.result ?? "");
	return rules && rules.length > 0 ? (rules[0]?.body ?? null) : null;
}

function main(): number {
	const { transcript, runs, yes } = parseArgs(process.argv.slice(2));
	const tasks = loadGoldenTasks(AGENT);
	const benchSessions = tasks.length * runs * 2;

	console.log("=== full autonomous-loop experiment ===");
	console.log(`agent: ${AGENT} (NAIVE def: validation/naive-sql.md)`);
	console.log(
		`plan: 1 haiku distill call + ${benchSessions} benchmark sessions (${tasks.length} tasks x ${runs} runs x 2 configs)`,
	);

	if (!yes) {
		console.log(
			"\nDRY RUN — no tokens spent. Provide --transcript <wasteful session> and --yes to execute.",
		);
		console.log(
			"Get a wasteful transcript by running naive-headroom-experiment.ts --yes first.",
		);
		return 0;
	}
	if (!transcript) {
		throw new Error("--transcript <path> is required with --yes");
	}

	console.log(
		"\n-- distilling a rule from the session (the system proposes) --",
	);
	const body = distillRule(transcript);
	if (!body) {
		console.log(
			"The distiller proposed no rule for this transcript. Try a more wasteful session.",
		);
		return 0;
	}
	console.log(`distiller proposed: "${body}"`);

	const naive: AgentDefinition = parseAgentDefinition(
		readFileSync(join(here, "naive-sql.md"), "utf8"),
		join(here, "naive-sql.md"),
	);
	const rent = contextCost(body);
	const db = openDb();
	const ruleId = insertRule(db, {
		agent: AGENT,
		body,
		contextCost: rent,
		sourceRun: null,
		createdAt: new Date().toISOString(),
	});
	const rule = db
		.prepare<[number], RuleRow>("SELECT * FROM rules WHERE id = ?")
		.get(ruleId);
	if (!rule) throw new Error("failed to load the distilled rule");

	console.log("\n-- measuring WITHOUT the rule (naive baseline) --");
	const without = runSuite(db, AGENT, tasks, {
		rules: [],
		runs,
		recordBaselines: false,
		rulesetVersion: 0,
		label: "without",
		config: "candidate",
		definitionOverride: naive,
	});
	console.log("\n-- measuring WITH the distilled rule --");
	const withRule = runSuite(db, AGENT, tasks, {
		rules: [rule],
		runs,
		recordBaselines: false,
		rulesetVersion: 1,
		label: "with-distilled",
		config: "candidate",
		definitionOverride: naive,
	});

	const a = assessDelta(without, withRule, rent);
	const threshold = 2 * rent;
	console.log("\n=== VERDICT (system-distilled rule) ===");
	console.log(
		`mean delta=${a.delta} tok/run  rent=${rent}  threshold(2x)=${threshold}  stderr=${a.standardError?.toFixed(0) ?? "n/a"} (${a.standardErrorBasis ?? "—"})`,
	);
	if (a.regression) {
		console.log("[EVICT] the distilled rule broke a task (regression).");
	} else if (a.delta !== null && a.delta >= threshold && !a.uncertain) {
		console.log(
			`[SURVIVES] the system's own distilled rule cleared 2x rent. Full autonomous loop demonstrated.`,
		);
	} else if (a.uncertain) {
		console.log("[INCONCLUSIVE] within noise — re-run with more --runs.");
	} else {
		console.log(
			`[EVICT] ${a.delta} tok/run did not clear 2x rent (${threshold}).`,
		);
	}
	db.close();
	return 0;
}

process.exit(main());
