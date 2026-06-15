/**
 * Automated prompt evolution: propose a token-cheaper rewrite of an agent's
 * system prompt, measure it on the golden suite, and recommend it only if it
 * provably wins. The feed-forward analog of the rule distiller, aimed at the
 * agent's base instructions instead of its appended memory.
 *
 * CLI: npx tsx src/evolve.ts --agent <name> [--runs <n>] [--top-up <n>]
 *
 * One haiku-tier call proposes a variant of agents/<name>.md (frontmatter —
 * name, tools, model, memory — preserved exactly; only the body is
 * tightened). The variant is benchmarked against the shipped prompt via the
 * shared comparison engine, rules and model held constant. Verdict:
 *  - regression (a golden task that passed now fails) → reject;
 *  - within noise / no positive saving → reject;
 *  - measurably cheaper → write the winning variant to a proposals file and
 *    recommend it. NEVER auto-applied: agents/<name>.md is committed source,
 *    not a generated artifact, and three golden tasks cannot fully capture an
 *    agent's behavior — the human reviews and applies.
 */
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type AgentDefinition,
	assertPosixPlatform,
	type GoldenTask,
	loadGoldenTasks,
	parseAgentDefinition,
	runSuite,
	type TaskSummary,
} from "./bench.js";
import { formatComparison, reportMetaCost, runComparison } from "./compare.js";
import {
	defaultDbPath,
	getActiveRules,
	getRulesetVersion,
	openDb,
	type RuleRow,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROPOSE_TIMEOUT_MS = 2 * 60 * 1000;

function logLine(message: string): void {
	try {
		const logPath = join(dirname(defaultDbPath()), "evolve.log");
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never take evolution down.
	}
}

/** Frontmatter fields that define the agent's identity, permissions, and
 * delegation scope — a prompt rewrite must not touch them. `description`
 * controls when Claude routes work to the agent, so a changed description is
 * scope drift, not a token-efficiency edit. */
const PROTECTED_FIELDS = [
	"name",
	"description",
	"tools",
	"model",
	"memory",
] as const;

// Control characters (excluding tab/newline/carriage-return) — including ANSI
// escape (\x1b). A proposal body carrying these is rejected: they have no
// place in a prompt and enable terminal-escape tricks when the file is viewed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars is the point
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function frontmatterField(raw: string, field: string): string | null {
	const match = raw.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m"));
	return match?.[1] ?? null;
}

export interface ProposalCheck {
	ok: boolean;
	reason: string;
}

/**
 * Validate a proposed agent definition against the original: it must parse,
 * keep every protected frontmatter field identical, and have a non-trivial
 * body. Returns the failure reason when rejected.
 */
export function checkProposal(
	original: string,
	proposed: string,
): ProposalCheck {
	try {
		// Throws if the proposal is not a well-formed agent definition.
		parseAgentDefinition(proposed, "proposal");
	} catch (err) {
		return {
			ok: false,
			reason: `does not parse as an agent definition: ${String(err)}`,
		};
	}
	for (const field of PROTECTED_FIELDS) {
		const before = frontmatterField(original, field);
		const after = frontmatterField(proposed, field);
		if (before !== after) {
			return {
				ok: false,
				reason: `changed protected frontmatter "${field}" (${before} → ${after})`,
			};
		}
	}
	const body = proposed.replace(/^---[\s\S]*?---\s*/, "").trim();
	if (body.length < 40) {
		return { ok: false, reason: "body too short — likely truncated or empty" };
	}
	if (CONTROL_CHARS.test(proposed)) {
		return {
			ok: false,
			reason: "contains control/escape characters — refusing to write to disk",
		};
	}
	return { ok: true, reason: "ok" };
}

function buildProposalPrompt(agent: string, current: string): string {
	return [
		`Here is the full markdown definition of an AI coding subagent named "${agent}":`,
		"",
		current,
		"",
		"Rewrite ONLY the system-prompt body (the markdown after the closing frontmatter ---) to use FEWER tokens while preserving the agent's role, domain ownership, and every behavioral constraint and guard rail. Tighten wording; do not remove any capability, instruction, or guard. Keep the YAML frontmatter (name, description, tools, model, memory) byte-for-byte identical.",
		"",
		"Return ONLY the complete rewritten markdown file (frontmatter + new body), nothing else — no commentary, no code fence.",
	].join("\n");
}

/** Strip a stray markdown code fence if the model wrapped its output. */
function stripFence(text: string): string {
	return text
		.trim()
		.replace(/^```(?:markdown|md)?\s*\n?/i, "")
		.replace(/\n?```$/, "")
		.trim();
}

/** Ask a haiku-tier model to propose a cheaper prompt variant. Returns the
 * validated proposal, or null (with a logged reason) on any failure — never
 * throws, never retries. */
function proposeVariant(agent: string, current: string): string | null {
	const claude = spawnSync(
		"claude",
		[
			"-p",
			buildProposalPrompt(agent, current),
			"--model",
			"haiku",
			"--max-turns",
			"1",
			"--output-format",
			"json",
		],
		{
			cwd: pluginRoot,
			encoding: "utf8",
			timeout: PROPOSE_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	if (claude.error) {
		logLine(`propose error: ${claude.error.message}`);
		return null;
	}
	let result: string;
	try {
		result = (JSON.parse(claude.stdout) as { result?: string }).result ?? "";
	} catch {
		logLine("propose: unparseable model output");
		return null;
	}
	const proposed = stripFence(result);
	const check = checkProposal(current, proposed);
	if (!check.ok) {
		logLine(`propose rejected: ${check.reason}`);
		return null;
	}
	return proposed;
}

interface EvolveArgs {
	agent: string;
	runs: number;
	topUp: number;
}

export function parseEvolveArgs(argv: string[]): EvolveArgs {
	const args: EvolveArgs = { agent: "", runs: 2, topUp: 1 };
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		switch (argv[i]) {
			case "--agent":
				args.agent = value ?? "";
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
			default:
				throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	if (!(DOMAIN_AGENTS as readonly string[]).includes(args.agent)) {
		throw new Error(
			`--agent must be one of: ${DOMAIN_AGENTS.join(", ")} (got "${args.agent}")`,
		);
	}
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isInteger(args.topUp) || args.topUp < 0) {
		throw new Error("--top-up must be a non-negative integer");
	}
	return args;
}

function main(args: EvolveArgs): void {
	const agentPath = join(pluginRoot, "agents", `${args.agent}.md`);
	const current = readFileSync(agentPath, "utf8");

	console.log(
		`Evolving the ${args.agent} prompt — proposing a cheaper variant…`,
	);
	const proposed = proposeVariant(args.agent, current);
	if (proposed === null) {
		console.log(
			"No valid variant proposed (see evolve.log) — nothing measured, nothing changed.",
		);
		return;
	}

	const variant = parseAgentDefinition(proposed, "proposal");
	const baseDef = parseAgentDefinition(current, agentPath);

	const db = openDb();
	try {
		const tasks: GoldenTask[] = loadGoldenTasks(args.agent);
		const rules: RuleRow[] = getActiveRules(db, args.agent);
		const run = (
			label: string,
			definitionOverride: AgentDefinition,
		): TaskSummary[] =>
			runSuite(db, args.agent, tasks, {
				rules,
				runs: args.runs,
				recordBaselines: false,
				rulesetVersion: getRulesetVersion(db, args.agent),
				label,
				config: "promptbench",
				model: baseDef.model,
				definitionOverride,
			});

		console.log(
			`Measuring the proposed variant vs the current prompt` +
				` (model ${baseDef.model}, runs=${args.runs} per prompt, top-up ${args.topUp})`,
		);
		const { comparison, benchTokens } = runComparison(db, {
			subject: args.agent,
			dimension: "prompt",
			baselineLabel: "current",
			candidateLabel: "proposed",
			topUp: args.topUp,
			runBaseline: (label) => run(label, baseDef),
			runCandidate: (label) => run(label, variant),
		});

		console.log("");
		console.log(formatComparison(comparison));

		const wins =
			!comparison.regression &&
			!comparison.uncertain &&
			comparison.comparableTasks >= 2 &&
			(comparison.delta ?? 0) > 0;

		console.log("");
		if (wins) {
			const proposalsDir = join(dirname(defaultDbPath()), "proposals");
			mkdirSync(proposalsDir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const outPath = join(proposalsDir, `${args.agent}-${stamp}.md`);
			writeFileSync(outPath, proposed);
			logLine(
				`accepted variant for ${args.agent}: ${comparison.pct} → ${outPath}`,
			);
			console.log(
				`✓ Proposed variant is measurably cheaper (${comparison.pct} processing tokens, no regressions).`,
			);
			console.log(`  Written to: ${outPath}`);
			console.log(
				`  Review it, then apply by hand if you accept:  diff "${agentPath}" "${outPath}"`,
			);
			console.log(
				"  (Not auto-applied — agents/<name>.md is committed source, and three golden tasks can't fully capture the agent's behavior.)",
			);
		} else {
			logLine(`rejected variant for ${args.agent}: verdict not a clear win`);
			console.log(
				"✗ Proposed variant is not a measurable improvement — discarded, nothing changed.",
			);
		}

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
		main(parseEvolveArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
