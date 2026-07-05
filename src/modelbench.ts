/**
 * Model-migration benchmarking: "is model B cheaper than model A on this
 * agent's golden suite?" — answered with the same measured rigor the rule
 * selector uses.
 *
 * CLI: npx tsx src/modelbench.ts --agent <name|all> --model <candidate>
 *      [--baseline <id>] [--runs <n>] [--top-up <n>] [--task <id>]
 *
 * Holds the agent's active rules constant and varies only the model. The
 * comparison engine lives in compare.ts (shared with prompt benchmarking and
 * prompt evolution); this module just runs the two model configurations. Both
 * passes are recorded with config='modelbench' (isolated from baselines,
 * learning curves, p75, and golden-run counts) and never touch the frozen
 * run1 baselines.
 *
 * --agent all runs every domain suite and closes with a per-category
 * regression roll-up (backend vs frontend vs sql vs testing) — a model
 * migration is a global change, so its safety must be judged per category,
 * not just on one agent's suite.
 */
import { pathToFileURL } from "node:url";
import {
	assertPosixPlatform,
	type GoldenTask,
	loadAgentDefinition,
	loadGoldenTasks,
	runSuite,
	type TaskSummary,
} from "./bench.js";
import {
	type Comparison,
	formatCategoryRegressions,
	formatComparison,
	reportMetaCost,
	runComparison,
} from "./compare.js";
import {
	getActiveRules,
	getRulesetVersion,
	openDb,
	type RuleRow,
	type WardenDb,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

interface ModelbenchArgs {
	agent: string;
	model: string;
	baseline: string | null;
	runs: number;
	topUp: number;
	task: string | null;
}

export function parseModelbenchArgs(argv: string[]): ModelbenchArgs {
	const args: ModelbenchArgs = {
		agent: "",
		model: "",
		baseline: null,
		runs: 2,
		topUp: 1,
		task: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		switch (argv[i]) {
			case "--agent":
				args.agent = value ?? "";
				i++;
				break;
			case "--model":
				args.model = value ?? "";
				i++;
				break;
			case "--baseline":
				args.baseline = value ?? null;
				i++;
				break;
			case "--runs":
				args.runs = Number(value);
				i++;
				break;
			case "--top-up":
				args.topUp = Number(value);
				i++;
				break;
			case "--task":
				args.task = value ?? null;
				i++;
				break;
			default:
				throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	if (
		args.agent !== "all" &&
		!(DOMAIN_AGENTS as readonly string[]).includes(args.agent)
	) {
		throw new Error(
			`--agent must be one of: ${DOMAIN_AGENTS.join(", ")}, all (got "${args.agent}")`,
		);
	}
	if (args.agent === "all" && args.task !== null) {
		throw new Error(
			"--task requires a specific --agent (task ids are per-agent)",
		);
	}
	if (args.model.trim() === "") {
		throw new Error("--model <candidate model id> is required");
	}
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isInteger(args.topUp) || args.topUp < 0) {
		throw new Error("--top-up must be a non-negative integer");
	}
	return args;
}

/** Bench one agent's suite: candidate model vs its baseline. Throws when the
 * two models are identical (single-agent mode surfaces that to the user; the
 * --agent all loop skips such agents instead of aborting the sweep). */
function benchOne(
	db: WardenDb,
	agent: string,
	args: ModelbenchArgs,
): { comparison: Comparison; benchTokens: number } {
	const baselineModel = args.baseline ?? loadAgentDefinition(agent).model;
	if (args.model === baselineModel) {
		throw new Error(
			`--model and baseline are both "${baselineModel}" — nothing to compare`,
		);
	}

	let tasks: GoldenTask[] = loadGoldenTasks(agent);
	if (args.task !== null) {
		tasks = tasks.filter((t) => t.id === args.task);
		if (tasks.length === 0) throw new Error(`no task with id ${args.task}`);
	}
	const rules: RuleRow[] = getActiveRules(db, agent);

	const runModel = (model: string, label: string): TaskSummary[] =>
		runSuite(db, agent, tasks, {
			rules,
			runs: args.runs,
			recordBaselines: false,
			rulesetVersion: getRulesetVersion(db, agent),
			label,
			config: "modelbench",
			model,
		});

	console.log(
		`Model-bench agent=${agent}: ${args.model} vs ${baselineModel}` +
			` (runs=${args.runs} per model, top-up ${args.topUp})`,
	);

	return runComparison(db, {
		subject: agent,
		dimension: "model",
		baselineLabel: baselineModel,
		candidateLabel: args.model,
		topUp: args.topUp,
		runBaseline: (label) => runModel(baselineModel, label),
		runCandidate: (label) => runModel(args.model, label),
	});
}

export function main(args: ModelbenchArgs): void {
	const db = openDb();
	try {
		if (args.agent !== "all") {
			const { comparison, benchTokens } = benchOne(db, args.agent, args);
			console.log("");
			console.log(formatComparison(comparison));
			reportMetaCost(db, benchTokens);
			return;
		}

		// Category sweep: one comparison per domain suite, then the roll-up.
		const comparisons: Comparison[] = [];
		let totalBenchTokens = 0;
		for (const agent of DOMAIN_AGENTS) {
			if (args.model === (args.baseline ?? loadAgentDefinition(agent).model)) {
				console.log(
					`Model-bench agent=${agent}: baseline already "${args.model}" — skipping (nothing to compare)`,
				);
				continue;
			}
			const { comparison, benchTokens } = benchOne(db, agent, args);
			comparisons.push(comparison);
			totalBenchTokens += benchTokens;
			console.log("");
			console.log(formatComparison(comparison));
			console.log("");
		}
		if (comparisons.length === 0) {
			throw new Error(
				`every agent's baseline is already "${args.model}" — nothing to compare`,
			);
		}
		console.log(formatCategoryRegressions(comparisons));
		reportMetaCost(db, totalBenchTokens);
	} finally {
		db.close();
	}
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		assertPosixPlatform();
		main(parseModelbenchArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
