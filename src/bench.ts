/**
 * Golden-suite benchmark runner.
 *
 * CLI: npx tsx src/bench.ts --agent <name> [--rule <id>] [--runs <n>] [--task <id>]
 *
 * Per golden task: copy the frozen fixture to a temp dir, install the agent
 * definition there (memory scope rewritten to `project` so benchmarks never
 * touch real ~/.claude/agent-memory), compile a MEMORY.md from active rules
 * (plus the candidate when --rule is given), run `claude -p --agent` headless
 * in the temp dir, run the task's success_check, parse the transcript, and
 * record a `runs` row. Baselines are written only for completed runs without
 * a candidate rule; run1_tokens is frozen forever.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	getActiveRules,
	getBaseline,
	getRuleById,
	getRulesetVersion,
	openDb,
	RUN_TOTAL_TOKENS_SQL,
	type RuleRow,
	type RunConfig,
	recordBaseline,
	upsertRun,
	type WardenDb,
} from "./db.js";
import { parseTranscript } from "./transcript.js";
import { DOMAIN_AGENTS } from "./types.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(pluginRoot, "benchmarks", "fixture");

const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TURNS = 60;
/** Two same-config runs differing by more than this fraction of their mean
 * get a variance warning in the output (LLM variance is real). Shared with
 * /warden-health's per-task variance ranking so "noisy" means one thing. */
export const VARIANCE_WARN_RATIO = 0.25;

export interface BenchArgs {
	agent: string;
	rule: number | null;
	runs: number;
	task: string | null;
}

export function parseArgs(argv: string[]): BenchArgs {
	// Default 3 (not 2): LLM run-to-run variance on the golden suite ran >25%
	// in real burns, which buries modest real savings under noise; a third run
	// tightens the standard error enough for the selector to keep good rules.
	const args: BenchArgs = { agent: "", rule: null, runs: 3, task: null };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--agent":
				args.agent = value ?? "";
				i++;
				break;
			case "--rule":
				args.rule = Number(value);
				i++;
				break;
			case "--runs":
				args.runs = Number(value);
				i++;
				break;
			case "--task":
				args.task = value ?? null;
				i++;
				break;
			default:
				throw new Error(`unknown flag: ${flag}`);
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
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (args.rule !== null && !Number.isInteger(args.rule)) {
		throw new Error("--rule must be an integer rule id");
	}
	if (args.agent === "all" && args.rule !== null) {
		throw new Error("--rule requires a specific --agent (rules are per-agent)");
	}
	if (args.agent === "all" && args.task !== null) {
		throw new Error(
			"--task requires a specific --agent (task ids are per-agent)",
		);
	}
	return args;
}

export interface GoldenTask {
	id: string;
	agent: string;
	prompt: string;
	successCheck: string;
	file: string;
}

/** Parse the single-line `key: "value"` frontmatter of a golden task file. */
export function parseGoldenTask(text: string, file: string): GoldenTask {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match || match[1] === undefined) {
		throw new Error(`${file}: missing frontmatter`);
	}
	const fields = new Map<string, string>();
	for (const line of match[1].split(/\r?\n/)) {
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		const key = line.slice(0, sep).trim();
		let value = line.slice(sep + 1).trim();
		if (value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		fields.set(key, value);
	}
	const required = ["id", "agent", "prompt", "success_check"] as const;
	for (const key of required) {
		if (!fields.get(key)) throw new Error(`${file}: missing "${key}"`);
	}
	return {
		id: fields.get("id") as string,
		agent: fields.get("agent") as string,
		prompt: fields.get("prompt") as string,
		successCheck: fields.get("success_check") as string,
		file,
	};
}

export function loadGoldenTasks(agent: string): GoldenTask[] {
	const dir = join(pluginRoot, "benchmarks", agent);
	const files = readdirSync(dir)
		.filter((name) => /^golden-\d+\.md$/.test(name))
		.sort();
	return files.map((name) =>
		parseGoldenTask(readFileSync(join(dir, name), "utf8"), join(dir, name)),
	);
}

/**
 * A short, deterministic identity for an agent's golden suite — a hash of each
 * task's id, prompt, and success check. Recorded into a rule receipt so the
 * measurement is attributable to a specific suite definition; a different
 * value means the rule was measured against a different benchmark.
 */
export function goldenSuiteHash(agent: string): string {
	const hash = createHash("sha256");
	for (const task of loadGoldenTasks(agent)) {
		hash.update(`${task.id}\0${task.prompt}\0${task.successCheck}\0`);
	}
	return hash.digest("hex").slice(0, 12);
}

/** Compile rule bodies into the MEMORY.md injected into the agent's prompt.
 * Overwritten wholesale by the selector — never hand-edited (invariant #2). A
 * scoped rule is rendered with a "(when <scope>)" prefix so the agent applies it
 * only in that context; unscoped rules are always-on. */
export function compileMemoryMd(
	rules: (Pick<RuleRow, "body"> & { scope?: string | null })[],
): string {
	const lines = rules.map((rule) =>
		rule.scope ? `- (when ${rule.scope}) ${rule.body}` : `- ${rule.body}`,
	);
	return [
		"<!-- GENERATED BY token-warden — do not hand-edit -->",
		"# Efficiency rules",
		"",
		...lines,
		"",
	].join("\n");
}

export function totalTokens(parsed: {
	inputTokens: number;
	outputTokens: number;
	cacheCreation: number;
	cacheRead: number;
}): number {
	return (
		parsed.inputTokens +
		parsed.outputTokens +
		parsed.cacheCreation +
		parsed.cacheRead
	);
}

/** Fixture files that must never reach the agent's working copy. */
const COPY_EXCLUDES = new Set(["node_modules", "BUGS.md", ".git"]);

function copyFixture(dest: string): void {
	cpSync(fixtureDir, dest, {
		recursive: true,
		filter: (source) => {
			const name = basename(source);
			return !COPY_EXCLUDES.has(name) && !name.endsWith(".db");
		},
	});
	symlinkSync(
		join(fixtureDir, "node_modules"),
		join(dest, "node_modules"),
		"dir",
	);
}

function ensureFixtureDeps(): void {
	if (existsSync(join(fixtureDir, "node_modules"))) return;
	console.log("Installing fixture dependencies (first run only)…");
	const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
		cwd: fixtureDir,
		stdio: "inherit",
		timeout: CHECK_TIMEOUT_MS,
	});
	if (result.status !== 0) {
		throw new Error("fixture npm install failed");
	}
}

export interface AgentDefinition {
	content: string;
	model: string;
}

/** Parse a raw agent-definition markdown into a benchable definition.
 * Benchmarks must not read or write real ~/.claude/agent-memory, so the
 * memory scope is rewritten to `project` (MEMORY.md then resolves inside the
 * temp dir). Used for both the shipped agents and prompt-variant files. */
export function parseAgentDefinition(
	raw: string,
	source: string,
): AgentDefinition {
	const content = raw.replace(/^memory:\s*\w+\s*$/m, "memory: project");
	if (!content.includes("memory: project")) {
		throw new Error(`${source} has no "memory:" frontmatter field to rewrite`);
	}
	const model = raw.match(/^model:\s*(\S+)\s*$/m)?.[1] ?? "sonnet";
	return { content, model };
}

export function loadAgentDefinition(agent: string): AgentDefinition {
	const path = join(pluginRoot, "agents", `${agent}.md`);
	return parseAgentDefinition(readFileSync(path, "utf8"), path);
}

/** Bash commands golden-task agents legitimately need. Everything else is
 * denied: bench agents run scoped (acceptEdits + this allowlist), never with
 * bypassPermissions. */
const BENCH_PERMISSIONS = {
	permissions: {
		allow: [
			"Bash(npx vitest:*)",
			"Bash(npm test:*)",
			"Bash(npm run test:*)",
			"Bash(npx tsc:*)",
			"Bash(npm run typecheck:*)",
			"Bash(ls:*)",
		],
	},
};

function installAgent(
	workDir: string,
	agent: string,
	definition: AgentDefinition,
	rules: RuleRow[],
): void {
	const claudeDir = join(workDir, ".claude");
	const agentsDir = join(claudeDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, `${agent}.md`), definition.content);
	writeFileSync(
		join(claudeDir, "settings.json"),
		`${JSON.stringify(BENCH_PERMISSIONS, null, "\t")}\n`,
	);
	if (rules.length > 0) {
		const memoryDir = join(claudeDir, "agent-memory", agent);
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "MEMORY.md"), compileMemoryMd(rules));
	}
}

function findTranscript(sessionId: string): string | null {
	const projectsDir = join(homedir(), ".claude", "projects");
	if (!existsSync(projectsDir)) return null;
	for (const entry of readdirSync(projectsDir)) {
		const candidate = join(projectsDir, entry, `${sessionId}.jsonl`);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export interface RunResult {
	sessionId: string;
	tokens: number;
	completed: boolean;
	/** Distinct tool calls in the run; absent for synthetic/failed runs (read
	 * as 0). The "did this rule skip work" signal for rule receipts. */
	toolCalls?: number;
	/** Files read 2+ times in the run; absent for synthetic/failed runs. */
	fileRereads?: number;
}

function runOnce(
	db: WardenDb,
	task: GoldenTask,
	definition: AgentDefinition,
	rules: RuleRow[],
	options: SuiteOptions,
): RunResult {
	const workDir = mkdtempSync(join(tmpdir(), `warden-bench-${task.id}-`));
	try {
		copyFixture(workDir);
		installAgent(workDir, task.agent, definition, rules);

		const model = options.model ?? definition.model;
		const claude = spawnSync(
			"claude",
			[
				"-p",
				task.prompt,
				"--agent",
				task.agent,
				"--model",
				model,
				"--permission-mode",
				"acceptEdits",
				"--max-turns",
				String(MAX_TURNS),
				"--output-format",
				"json",
			],
			{
				cwd: workDir,
				encoding: "utf8",
				timeout: CLAUDE_TIMEOUT_MS,
				maxBuffer: 64 * 1024 * 1024,
				// If the plugin is installed globally, its Stop hook fires
				// inside this benchmark session; this stops that hook from
				// spawning haiku distillers off golden runs.
				env: { ...process.env, TOKEN_WARDEN_NO_DISTILL: "1" },
			},
		);
		if (claude.error) throw claude.error;
		let sessionId: string;
		let durationMs: number | null = null;
		try {
			const output = JSON.parse(claude.stdout) as {
				session_id?: string;
				duration_ms?: number;
			};
			if (!output.session_id) throw new Error("no session_id in output");
			sessionId = output.session_id;
			// Advisory latency axis — reported, never a keep/evict gate input.
			durationMs =
				typeof output.duration_ms === "number" ? output.duration_ms : null;
		} catch (err) {
			throw new Error(
				`claude exited ${claude.status}; unparseable output: ` +
					`${String(err)}\nstderr: ${claude.stderr.slice(0, 2000)}`,
			);
		}

		const check = spawnSync("bash", ["-c", task.successCheck], {
			cwd: workDir,
			encoding: "utf8",
			timeout: CHECK_TIMEOUT_MS,
		});
		const completed = check.status === 0;

		const transcriptPath = findTranscript(sessionId);
		if (!transcriptPath) {
			throw new Error(`transcript not found for session ${sessionId}`);
		}
		const parsed = parseTranscript(readFileSync(transcriptPath, "utf8"));
		const tokens = totalTokens(parsed);
		const ts = new Date().toISOString();

		upsertRun(db, {
			agent: task.agent,
			sessionId,
			taskHash: task.id,
			inputTokens: parsed.inputTokens,
			outputTokens: parsed.outputTokens,
			cacheCreation: parsed.cacheCreation,
			cacheRead: parsed.cacheRead,
			toolCalls: parsed.toolCalls,
			fileRereads: parsed.fileRereads,
			completed,
			rulesetVersion: options.rulesetVersion,
			ts,
			config: options.config,
			model,
			durationMs,
		});

		// Only the plain active-set configuration touches baselines: the
		// frozen run1/best numbers must describe the active ruleset alone.
		if (completed && options.recordBaselines) {
			recordBaseline(db, task.agent, task.id, tokens, ts);
		}

		return {
			sessionId,
			tokens,
			completed,
			toolCalls: parsed.toolCalls,
			fileRereads: parsed.fileRereads,
		};
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export interface TaskSummary {
	taskId: string;
	results: RunResult[];
	meanCompletedTokens: number;
	highVariance: boolean;
}

export function summarizeTask(
	taskId: string,
	results: RunResult[],
): TaskSummary {
	const completedTokens = results
		.filter((r) => r.completed)
		.map((r) => r.tokens);
	const avg = mean(completedTokens);
	let highVariance = false;
	if (completedTokens.length >= 2 && avg > 0) {
		const spread = Math.max(...completedTokens) - Math.min(...completedTokens);
		highVariance = spread / avg > VARIANCE_WARN_RATIO;
	}
	return { taskId, results, meanCompletedTokens: avg, highVariance };
}

export interface SuiteOptions {
	/** Exact rule set to compile into the agent's MEMORY.md for these runs. */
	rules: RuleRow[];
	runs: number;
	/** True only for the plain active-set configuration. */
	recordBaselines: boolean;
	rulesetVersion: number;
	/** Printed as a prefix on progress lines. */
	label: string;
	/** Stored on each runs row so status can separate active-set golden runs
	 * from candidate/audit measurement runs. */
	config: RunConfig;
	/** Override the model the agent runs under (defaults to the agent's
	 * frontmatter model). Used by model-migration benchmarking. */
	model?: string;
	/** Replace the agent definition installed for the run (defaults to the
	 * shipped agents/<name>.md). Used by prompt/agent-definition A/B testing
	 * to run a variant prompt. */
	definitionOverride?: AgentDefinition;
}

/**
 * Run the golden suite for one agent under an explicit rule configuration.
 * The selector calls this directly (baseline, per-candidate, re-audit
 * configurations); the bench CLI wraps it.
 */
export function runSuite(
	db: WardenDb,
	agent: string,
	tasks: GoldenTask[],
	options: SuiteOptions,
): TaskSummary[] {
	ensureFixtureDeps();
	const definition = options.definitionOverride ?? loadAgentDefinition(agent);
	const summaries: TaskSummary[] = [];
	for (const task of tasks) {
		const results: RunResult[] = [];
		for (let i = 1; i <= options.runs; i++) {
			process.stdout.write(
				`  [${options.label}] ${task.id} run ${i}/${options.runs}… `,
			);
			// One broken run (claude crash, vanished transcript, timeout) must
			// not abort the suite: record it as a failed result and move on.
			// Failed results are excluded from all savings math anyway.
			let result: RunResult;
			try {
				result = runOnce(db, task, definition, options.rules, options);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				console.log(`RUN-ERROR ${detail.split("\n")[0]}`);
				results.push({ sessionId: "run-error", tokens: 0, completed: false });
				continue;
			}
			results.push(result);
			console.log(
				`${result.completed ? "ok" : "FAILED-CHECK"} ${result.tokens} tokens (${result.sessionId})`,
			);
		}
		const summary = summarizeTask(task.id, results);
		console.log(
			`  [${options.label}] ${task.id}: mean(completed)=${summary.meanCompletedTokens}` +
				(summary.highVariance ? "  runs differ by >25%" : ""),
		);
		summaries.push(summary);
	}
	return summaries;
}

export interface MetaCost {
	benchTokens: number;
	realWorkTokens: number;
	/** benchTokens / realWorkTokens; null when no real work was collected. */
	ratio: number | null;
	/** True when benchmarking exceeded 10% of the week's real-work tokens. */
	warn: boolean;
}

/** The optimizer reporting on its own overhead (spec §4.2). */
export function metaCost(
	benchTokens: number,
	realWorkTokens: number,
): MetaCost {
	if (realWorkTokens <= 0) {
		return {
			benchTokens,
			realWorkTokens: 0,
			ratio: null,
			warn: benchTokens > 0,
		};
	}
	const ratio = benchTokens / realWorkTokens;
	return { benchTokens, realWorkTokens, ratio, warn: ratio > 0.1 };
}

export function realWorkTokensLast7Days(db: WardenDb): number {
	const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const row = db
		.prepare<unknown[], { total: number }>(
			`SELECT COALESCE(SUM(${RUN_TOTAL_TOKENS_SQL}), 0) AS total
			 FROM runs WHERE task_hash IS NULL AND ts >= ?`,
		)
		.get(since);
	return row?.total ?? 0;
}

/** Benchmark one agent; returns tokens spent benchmarking. `suite` exists so
 * tests can stub the spawn boundary while the orchestration runs for real. */
export function benchAgent(
	db: WardenDb,
	agent: string,
	args: BenchArgs,
	suite: typeof runSuite = runSuite,
): number {
	let tasks = loadGoldenTasks(agent);
	if (args.task !== null) {
		tasks = tasks.filter((t) => t.id === args.task);
		if (tasks.length === 0) throw new Error(`no task with id ${args.task}`);
	}

	const rules = getActiveRules(db, agent);
	if (args.rule !== null) {
		const candidate = getRuleById(db, args.rule);
		if (!candidate) throw new Error(`no rule with id ${args.rule}`);
		if (candidate.agent !== agent) {
			throw new Error(
				`rule ${args.rule} belongs to agent "${candidate.agent}"`,
			);
		}
		rules.push(candidate);
	}

	console.log(
		`Benching agent=${agent} tasks=${tasks.length} runs=${args.runs}` +
			` rules=${rules.length}${args.rule !== null ? ` (candidate ${args.rule})` : ""}`,
	);

	const summaries = suite(db, agent, tasks, {
		rules,
		runs: args.runs,
		recordBaselines: args.rule === null,
		rulesetVersion: getRulesetVersion(db, agent),
		label: args.rule === null ? "active-set" : `candidate-${args.rule}`,
		config: args.rule === null ? "active" : "candidate",
	});

	let benchTokens = 0;
	for (const summary of summaries) {
		for (const result of summary.results) benchTokens += result.tokens;
		const baseline = getBaseline(db, agent, summary.taskId);
		const baselineNote = baseline
			? `run1=${baseline.run1_tokens} (${pctOfRun1(summary.meanCompletedTokens, baseline.run1_tokens)})` +
				` best=${baseline.best_tokens}`
			: "no baseline (no completed run yet)";
		console.log(`  ${summary.taskId}: vs ${baselineNote}`);
	}
	return benchTokens;
}

function pctOfRun1(current: number, run1: number): string {
	if (run1 === 0 || current === 0) return "n/a";
	const change = ((current - run1) / run1) * 100;
	return `${change > 0 ? "+" : ""}${change.toFixed(1)}% vs run1`;
}

export function main(args: BenchArgs, suite: typeof runSuite = runSuite): void {
	const db = openDb();
	try {
		const agents = args.agent === "all" ? [...DOMAIN_AGENTS] : [args.agent];
		let benchTokens = 0;
		for (const agent of agents) {
			benchTokens += benchAgent(db, agent, args, suite);
		}

		const cost = metaCost(benchTokens, realWorkTokensLast7Days(db));
		const ratioText =
			cost.ratio === null
				? "no real-work tokens collected in the last 7 days"
				: `${(cost.ratio * 100).toFixed(1)}% of the week's real-work tokens (${cost.realWorkTokens.toLocaleString("en-US")})`;
		console.log(
			`Meta-cost: this benchmark session used ${cost.benchTokens.toLocaleString("en-US")} tokens — ${ratioText}.`,
		);
		if (cost.warn) {
			console.log(
				"WARNING: Benchmarking overhead exceeded 10% of the week's collected real-work tokens.",
			);
		}
	} finally {
		db.close();
	}
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

/** Benchmarks copy fixtures, symlink node_modules, and run success checks
 * via `bash -c` — POSIX only. Fail fast with a useful message on Windows. */
export function assertPosixPlatform(): void {
	if (process.platform === "win32") {
		throw new Error(
			"token-warden benchmarks require a POSIX environment (macOS/Linux); on Windows, run inside WSL",
		);
	}
}

if (invokedDirectly) {
	try {
		assertPosixPlatform();
		main(parseArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
