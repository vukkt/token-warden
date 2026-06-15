/**
 * Prompt / agent-definition A/B benchmarking: "does this proposed edit to an
 * agent's system prompt do the same work in fewer tokens?" — the same
 * measured discipline as rule selection and model migration, aimed at the
 * agent's base instructions.
 *
 * CLI: npx tsx src/promptbench.ts --agent <name> --variant <file.md>
 *      [--runs <n>] [--top-up <n>] [--task <id>]
 *
 * Runs the agent's golden suite under the shipped definition (baseline) and
 * the variant definition (candidate), holding the agent's active rules AND
 * model constant so only the prompt varies. The variant is a full agent
 * markdown file (same format as agents/<name>.md). Both passes are recorded
 * with config='promptbench', isolated from baselines, learning curves, p75,
 * and golden-run counts. Comparison and reporting are shared with model
 * benchmarking (compare.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentDefinition,
	assertPosixPlatform,
	type GoldenTask,
	loadAgentDefinition,
	loadGoldenTasks,
	parseAgentDefinition,
	runSuite,
	type TaskSummary,
} from "./bench.js";
import { formatComparison, reportMetaCost, runComparison } from "./compare.js";
import {
	getActiveRules,
	getRulesetVersion,
	openDb,
	type RuleRow,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

interface PromptbenchArgs {
	agent: string;
	variant: string;
	runs: number;
	topUp: number;
	task: string | null;
}

export function parsePromptbenchArgs(argv: string[]): PromptbenchArgs {
	const args: PromptbenchArgs = {
		agent: "",
		variant: "",
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
			case "--variant":
				args.variant = value ?? "";
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
	if (!(DOMAIN_AGENTS as readonly string[]).includes(args.agent)) {
		throw new Error(
			`--agent must be one of: ${DOMAIN_AGENTS.join(", ")} (got "${args.agent}")`,
		);
	}
	if (args.variant.trim() === "") {
		throw new Error("--variant <path to agent .md file> is required");
	}
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isInteger(args.topUp) || args.topUp < 0) {
		throw new Error("--top-up must be a non-negative integer");
	}
	return args;
}

function main(args: PromptbenchArgs): void {
	if (!existsSync(args.variant)) {
		throw new Error(`variant file not found: ${args.variant}`);
	}
	const variant: AgentDefinition = parseAgentDefinition(
		readFileSync(args.variant, "utf8"),
		args.variant,
	);

	const db = openDb();
	try {
		// Hold the model constant (the agent's current model) so the prompt is
		// the only variable, even if the variant file names a different model.
		const baseModel = loadAgentDefinition(args.agent).model;
		const candidateLabel = basename(args.variant);

		let tasks: GoldenTask[] = loadGoldenTasks(args.agent);
		if (args.task !== null) {
			tasks = tasks.filter((t) => t.id === args.task);
			if (tasks.length === 0) throw new Error(`no task with id ${args.task}`);
		}
		const rules: RuleRow[] = getActiveRules(db, args.agent);

		const run = (
			label: string,
			definitionOverride?: AgentDefinition,
		): TaskSummary[] =>
			runSuite(db, args.agent, tasks, {
				rules,
				runs: args.runs,
				recordBaselines: false,
				rulesetVersion: getRulesetVersion(db, args.agent),
				label,
				config: "promptbench",
				model: baseModel,
				definitionOverride,
			});

		console.log(
			`Prompt-bench agent=${args.agent}: ${candidateLabel} vs current` +
				` (model ${baseModel}, runs=${args.runs} per prompt, top-up ${args.topUp})`,
		);

		const { comparison, benchTokens } = runComparison(db, {
			subject: args.agent,
			dimension: "prompt",
			baselineLabel: "current",
			candidateLabel,
			topUp: args.topUp,
			runBaseline: (label) => run(label),
			runCandidate: (label) => run(label, variant),
		});

		console.log("");
		console.log(formatComparison(comparison));
		reportMetaCost(db, benchTokens);
	} finally {
		db.close();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		assertPosixPlatform();
		main(parsePromptbenchArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
