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
import { numericFlag, runCli } from "./cli.js";
import { formatComparison, reportMetaCost, runComparison } from "./compare.js";
import {
	getActiveRules,
	getRulesetVersion,
	type RuleRow,
	withDb,
} from "./db.js";
import { assertKnownAgent } from "./registry.js";

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
				args.runs = numericFlag(value);
				i++;
				break;
			case "--top-up":
				args.topUp = numericFlag(value);
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
	assertKnownAgent(args.agent);
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

/** The `name:` frontmatter field of an agent definition, if it declares one. */
export function agentDefinitionName(raw: string): string | null {
	return raw.match(/^name:\s*(\S+)\s*$/m)?.[1] ?? null;
}

/**
 * The variant is installed as `.claude/agents/<agent>.md` and then invoked as
 * `claude --agent <agent>`. Claude Code resolves a subagent by its `name:`
 * frontmatter, so a variant that renames the agent is not discoverable under
 * `<agent>` — EVERY candidate run fails to start while the baseline runs fine.
 * That reads out as "the variant regressed every task", i.e. a confound that
 * manufactures a false regression verdict out of a typo, after paying for a
 * full baseline pass. Warn loudly rather than throw: the definition format is
 * Claude Code's, not ours, and a hard failure here would be us guessing at its
 * resolution order.
 */
function warnOnAgentNameMismatch(
	agent: string,
	variantPath: string,
	rawVariant: string,
): void {
	const declared = agentDefinitionName(rawVariant);
	if (declared !== null && declared !== agent) {
		console.log(
			`WARNING: ${basename(variantPath)} declares "name: ${declared}" but this is an A/B for agent "${agent}".` +
				` The variant is installed as ${agent}.md and invoked as --agent ${agent}; if Claude Code resolves` +
				" the subagent by its name field, every candidate run will fail to start and report as a REGRESSION" +
				` rather than a prompt result. Set "name: ${agent}" in the variant to compare prompts only.`,
		);
	}
}

export function main(args: PromptbenchArgs): void {
	if (!existsSync(args.variant)) {
		throw new Error(`variant file not found: ${args.variant}`);
	}
	const rawVariant = readFileSync(args.variant, "utf8");
	const variant: AgentDefinition = parseAgentDefinition(
		rawVariant,
		args.variant,
	);

	// CONTROL ARM: the baseline prompt is read from disk exactly once, here,
	// and pinned for every baseline pass (initial AND top-up). Leaving it to
	// runSuite's `loadAgentDefinition` fallback re-read `agents/<name>.md` on
	// each pass, which is asymmetric — the candidate variant was always read
	// once — and would silently turn a mid-benchmark edit of the shipped agent
	// into a second varied dimension.
	const baseline: AgentDefinition = loadAgentDefinition(args.agent);
	warnOnAgentNameMismatch(args.agent, args.variant, rawVariant);

	withDb((db) => {
		// Hold the model constant (the agent's current model) so the prompt is
		// the only variable, even if the variant file names a different model.
		const baseModel = baseline.model;
		const candidateLabel = basename(args.variant);

		let tasks: GoldenTask[] = loadGoldenTasks(args.agent);
		if (args.task !== null) {
			tasks = tasks.filter((t) => t.id === args.task);
			if (tasks.length === 0) throw new Error(`no task with id ${args.task}`);
		}
		const rules: RuleRow[] = getActiveRules(db, args.agent);
		const rulesetVersion = getRulesetVersion(db, args.agent);

		const run = (
			label: string,
			definitionOverride: AgentDefinition,
		): TaskSummary[] =>
			runSuite(db, args.agent, tasks, {
				rules,
				runs: args.runs,
				recordBaselines: false,
				rulesetVersion,
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
			runBaseline: (label) => run(label, baseline),
			runCandidate: (label) => run(label, variant),
		});

		console.log("");
		console.log(formatComparison(comparison));
		reportMetaCost(db, benchTokens);
	});
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	assertPosixPlatform();
	main(parsePromptbenchArgs(process.argv.slice(2)));
});
/* v8 ignore stop */
