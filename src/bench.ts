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
	statSync,
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
	RUN_TOTAL_TOKENS_SQL,
	type RuleRow,
	type RunConfig,
	recordBaseline,
	upsertRun,
	type WardenDb,
	withDb,
} from "./db.js";
import { compileMemoryMd } from "./memory.js";
import { knownAgents, userAgentsDir, userBenchmarksDir } from "./registry.js";
import { parseTranscript } from "./transcript.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(pluginRoot, "benchmarks", "fixture");

const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TURNS = 60;
/** Captured stdout/stderr cap for BOTH benchmark subprocesses. Exceeding a
 * spawnSync maxBuffer kills the child and returns status=null with an ENOBUFS
 * error, which the success-check path used to read as "the task failed" — an
 * infrastructure limit silently recorded as a measurement. Both spawns now
 * share the same generous cap and both check for a non-run. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Two same-config runs differing by more than this fraction of their mean
 * get a variance warning in the output (LLM variance is real). Shared with
 * /warden-health's per-task variance ranking so "noisy" means one thing. */
export const VARIANCE_WARN_RATIO = 0.25;
/** A failed run below this token count is an environment failure (quota
 * exhaustion, API error, crash) rather than a rule-caused regression: the
 * cheapest genuine golden run observed is ~34k tokens, and even a rule-broken
 * run burns thousands attempting the task, while quota-death runs parse to ~0.
 * Zero tokens = the environment died; tokens = the rule broke the task. */
export const ENV_FAILURE_TOKEN_FLOOR = 1_000;
/** Consecutive environment failures that abort a suite pass early. A single
 * broken run (claude crash, vanished transcript) must not abort the suite;
 * the real quota deaths ran 46 and 72 consecutive zero-token failures. */
export const ENV_FAILURE_STREAK = 4;
/** Minimum environment-failure count before a pass-level majority check can
 * trip, so 1-2 transient crashes in a small pass never abort. */
export const ENV_FAILURE_MIN_COUNT = 3;

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
	if (args.agent !== "all" && !knownAgents().includes(args.agent)) {
		throw new Error(
			`--agent must be one of: ${knownAgents().join(", ")}, all (got "${args.agent}")`,
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
	/** Distribution weight of this task in the suite (positive, finite; default
	 * 1). A task standing in for a rarer-but-costlier production case can be
	 * up-weighted so the measured saving reflects real-work value; the verdict
	 * estimators weight the mean and its standard error by this. */
	weight: number;
}

/** A golden task's `id` and `agent` are pasted straight into filesystem paths
 * (`mkdtemp(warden-bench-<id>-…)`, `.claude/agents/<agent>.md`,
 * `.claude/agent-memory/<agent>/`) and into the `runs.task_hash` key. Task files
 * are model- or user-authored (TOKEN_WARDEN_BENCHMARKS_DIR), so a value
 * containing a separator or `..` would write outside the temp workdir. Restrict
 * both to a filename-safe slug: leading alphanumeric, then `[A-Za-z0-9._-]`.
 * Every bundled task id ("sql-01") and agent ("sql") already matches. */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Crash early on a task field that is not safe to build a path from. */
export function assertSafePathSegment(
	value: string,
	field: string,
	source: string,
): void {
	if (!SAFE_PATH_SEGMENT.test(value)) {
		throw new Error(
			`${source}: "${field}" must be a filename-safe slug ` +
				`(alphanumeric, then [A-Za-z0-9._-], max 64 chars) — got "${value}"`,
		);
	}
}

/** Longest accepted `success_check` / `prompt`. Bundled tasks sit well under
 * this; the cap exists so a pathological suite file cannot build a multi-megabyte
 * argv or shell command. */
const MAX_TASK_FIELD_CHARS = 4000;

/** True if the value contains a C0 control (tab and newline included), DEL, or
 * a C1 control. A golden task field is a single-line frontmatter value, so any
 * of these is either a malformed file or an attempt to smuggle structure past a
 * reviewer. Written as a code-point scan rather than a regex so the source never
 * carries the bytes it guards against. */
function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/** The `success_check` is executed as `bash -c <value>` inside the throwaway
 * fixture copy, so it is arbitrary shell BY DESIGN — that is the contract a
 * golden suite needs. What is validated here is only that it is a single,
 * bounded, control-character-free line: a suite from TOKEN_WARDEN_BENCHMARKS_DIR
 * is user- or model-authored, and a reviewer reading the file must see the same
 * bytes bash will run. Anyone pointing that variable at untrusted content is
 * granting code execution regardless; see SECURITY.md. */
export function assertSafeSuccessCheck(value: string, source: string): void {
	if (value.length > MAX_TASK_FIELD_CHARS) {
		throw new Error(
			`${source}: "success_check" exceeds ${MAX_TASK_FIELD_CHARS} characters`,
		);
	}
	if (hasControlChar(value)) {
		throw new Error(
			`${source}: "success_check" must not contain control characters`,
		);
	}
}

/** The prompt is passed as the value of `-p` to the benchmarked `claude`.
 * `-p`/`--print` takes an OPTIONAL value, so a prompt beginning with `-` is
 * parsed by the child CLI as a new flag rather than as the prompt — which would
 * let a suite file change the child's permission mode and defeat the scoped
 * `acceptEdits` invocation the whole benchmark depends on. Reject it at the
 * parse chokepoint rather than trusting argv ordering. */
export function assertSafePrompt(value: string, source: string): void {
	if (value.length > MAX_TASK_FIELD_CHARS) {
		throw new Error(
			`${source}: "prompt" exceeds ${MAX_TASK_FIELD_CHARS} characters`,
		);
	}
	if (hasControlChar(value)) {
		throw new Error(`${source}: "prompt" must not contain control characters`);
	}
	if (value.startsWith("-")) {
		throw new Error(
			`${source}: "prompt" must not start with "-" — it would be read as a ` +
				`flag by the benchmarked CLI rather than as the prompt`,
		);
	}
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
	// Both fields become path segments downstream; validate at the parse
	// chokepoint so nothing further along has to trust them.
	assertSafePathSegment(fields.get("id") as string, "id", file);
	assertSafePathSegment(fields.get("agent") as string, "agent", file);
	assertSafeSuccessCheck(fields.get("success_check") as string, file);
	assertSafePrompt(fields.get("prompt") as string, file);
	// Optional distribution weight: absent -> 1. A present value must parse to a
	// positive finite number; 0, negative, NaN and non-numeric strings throw so a
	// typo can never silently zero out a task's contribution to the verdict.
	let weight = 1;
	const weightRaw = fields.get("weight");
	if (weightRaw !== undefined) {
		const parsed = Number(weightRaw);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			throw new Error(
				`${file}: "weight" must be a positive finite number (got "${weightRaw}")`,
			);
		}
		weight = parsed;
	}
	return {
		id: fields.get("id") as string,
		agent: fields.get("agent") as string,
		prompt: fields.get("prompt") as string,
		successCheck: fields.get("success_check") as string,
		file,
		weight,
	};
}

export function loadGoldenTasks(agent: string): GoldenTask[] {
	const bundledDir = join(pluginRoot, "benchmarks", agent);
	const userDir = join(userBenchmarksDir(), agent);
	// Bundled suite wins; a user suite is only consulted when no bundled dir
	// exists for this agent (custom agents), and neither existing is an error.
	let dir = bundledDir;
	if (!existsSync(bundledDir)) {
		if (!existsSync(userDir)) {
			throw new Error(
				`no golden suite for agent "${agent}": looked in ${bundledDir} and ${userDir}`,
			);
		}
		dir = userDir;
	}
	const files = readdirSync(dir)
		.filter((name) => /^golden-\d+\.md$/.test(name))
		.sort();
	// A directory with no golden-NN.md files used to yield an empty suite, and
	// an empty suite runs zero benchmark runs and produces an empty summary
	// list — from which the selector would happily build a verdict about a rule
	// nothing measured. Say so instead of measuring nothing quietly.
	if (files.length === 0) {
		throw new Error(
			`no golden tasks for agent "${agent}": ${dir} contains no golden-NN.md files`,
		);
	}
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

/** Copy predicate for the frozen fixture: excluded names and any `*.db` file
 * stay behind (node_modules is symlinked instead of copied; BUGS.md would hand
 * the agent the answers; a stray .db is state, not fixture). */
export function shouldCopyFixtureEntry(source: string): boolean {
	const name = basename(source);
	return !COPY_EXCLUDES.has(name) && !name.endsWith(".db");
}

function copyFixture(dest: string): void {
	cpSync(fixtureDir, dest, {
		recursive: true,
		filter: shouldCopyFixtureEntry,
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
		// status is also null when npm is missing or the install timed out;
		// carry the reason rather than a bare "failed".
		const why = result.error
			? `: ${result.error.message}`
			: result.signal
				? ` (killed by ${result.signal})`
				: ` (exit ${result.status})`;
		throw new Error(`fixture npm install failed${why}`);
	}
}

/**
 * Temp fixture copies that exist right now.
 *
 * `runOnce` removes its own directory in a `finally`, which covers return,
 * throw and the spawn timeout — but a SIGINT/SIGTERM landing during a
 * 15-minute `claude` run unwinds no `finally` at all, so an interrupted burn
 * would leave one full fixture copy per run behind in $TMPDIR. The registry
 * exists so the signal and exit handlers can sweep whatever is still live.
 */
const liveWorkDirs = new Set<string>();

/** Track a temp fixture copy so an interrupt can still remove it. */
export function registerWorkDir(dir: string): void {
	liveWorkDirs.add(dir);
}

/** Remove one tracked temp fixture copy (the normal `finally` path). */
export function releaseWorkDir(dir: string): void {
	liveWorkDirs.delete(dir);
	rmSync(dir, { recursive: true, force: true });
}

/** Remove every still-live temp fixture copy; returns how many were removed.
 * Never throws: it runs from signal/exit handlers, where a throw would mask
 * the cause of the shutdown. */
export function cleanupWorkDirs(): number {
	let removed = 0;
	for (const dir of [...liveWorkDirs]) {
		liveWorkDirs.delete(dir);
		try {
			rmSync(dir, { recursive: true, force: true });
			removed++;
		} catch {
			// Best effort: one undeletable directory must not stop the sweep.
		}
	}
	return removed;
}

/** Signals that should sweep temp fixture copies before the process dies. */
const CLEANUP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

let uninstallWorkDirCleanup: (() => void) | null = null;

/**
 * Install the interrupt/exit sweep for temp fixture copies. Idempotent —
 * repeated calls return the same uninstall function and add no listeners.
 *
 * The signal handlers deliberately re-raise after cleaning up: an interrupted
 * benchmark must still exit as "killed by <signal>", never as a clean exit
 * that a caller could mistake for a completed pass.
 */
export function installWorkDirCleanup(): () => void {
	if (uninstallWorkDirCleanup) return uninstallWorkDirCleanup;
	const onExit = (): void => {
		cleanupWorkDirs();
	};
	const handlers = new Map<NodeJS.Signals, () => void>();
	for (const signal of CLEANUP_SIGNALS) {
		const handler = (): void => {
			cleanupWorkDirs();
			process.removeListener(signal, handler);
			process.kill(process.pid, signal);
		};
		handlers.set(signal, handler);
		process.on(signal, handler);
	}
	process.on("exit", onExit);
	uninstallWorkDirCleanup = (): void => {
		process.removeListener("exit", onExit);
		for (const [signal, handler] of handlers) {
			process.removeListener(signal, handler);
		}
		uninstallWorkDirCleanup = null;
	};
	return uninstallWorkDirCleanup;
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
	const bundledPath = join(pluginRoot, "agents", `${agent}.md`);
	const path = existsSync(bundledPath)
		? bundledPath
		: join(userAgentsDir(), `${agent}.md`);
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
		// `workDir/node_modules` is a SYMLINK to the shared, persistent
		// `benchmarks/fixture/node_modules` — the temp copy is thrown away but
		// the link target is not, and `releaseWorkDir` unlinks rather than
		// following it. A benchmarked agent running with `acceptEdits` that
		// writes under node_modules would therefore mutate the shared tree, and
		// the allowlist above lets the NEXT benchmark of ANY agent execute it
		// via `npx vitest` / `npm test`. Nothing a golden task legitimately does
		// writes into a dependency, so denying it costs no measurement.
		deny: ["Write(./node_modules/**)", "Edit(./node_modules/**)"],
	},
};

/** Materialize the agent definition, scoped permissions, and compiled
 * MEMORY.md inside a temp fixture copy. `agent` is a path segment, so it is
 * asserted safe here too — this is the last point before it becomes a
 * filename, and `installAgent` is reachable from callers that never went
 * through `parseGoldenTask`. */
export function installAgent(
	workDir: string,
	agent: string,
	definition: AgentDefinition,
	rules: readonly RuleRow[],
): void {
	assertSafePathSegment(agent, "agent", "installAgent");
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

/** Locate the JSONL transcript the spawned `claude` wrote for `sessionId`.
 * `projectsDir` is injectable so the lookup is testable without a real
 * ~/.claude tree; production always uses the default. */
export function findTranscript(
	sessionId: string,
	projectsDir: string = join(homedir(), ".claude", "projects"),
): string | null {
	if (!existsSync(projectsDir)) return null;
	for (const entry of readdirSync(projectsDir)) {
		const candidate = join(projectsDir, entry, `${sessionId}.jsonl`);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Locate the transcript of a run whose session id never reached us — the
 * `claude` timeout path, where the JSON summary carrying `session_id` is
 * printed only at the end and the kill destroyed it.
 *
 * Attribution is the whole risk here (binding a run to the WRONG transcript is
 * how the 30.4M-token false baseline happened), so the match is deliberately
 * narrow: Claude Code names a project directory after the session's cwd with
 * non-alphanumeric characters replaced by "-", and this run's cwd is a fresh
 * `mkdtemp` path no other session on the machine can share. We do not depend on
 * the full encoding — only that the directory name ENDS WITH the encoded form
 * of that unique basename. No match, no recovery; we never fall back to
 * "newest transcript anywhere".
 */
export function findTranscriptForWorkDir(
	workDir: string,
	projectsDir: string = join(homedir(), ".claude", "projects"),
): string | null {
	if (!existsSync(projectsDir)) return null;
	const marker = basename(workDir).replace(/[^A-Za-z0-9]/g, "-");
	// A short marker could collide with an unrelated directory; mkdtemp's
	// 6-char suffix alone clears this, so this only rejects absurd inputs.
	if (marker.length < 8) return null;
	let newest: { path: string; mtimeMs: number } | null = null;
	for (const entry of readdirSync(projectsDir)) {
		if (!entry.endsWith(marker)) continue;
		let names: string[];
		try {
			names = readdirSync(join(projectsDir, entry));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(projectsDir, entry, name);
			try {
				const { mtimeMs } = statSync(path);
				if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
			} catch {
				// Racing cleanup; skip this candidate.
			}
		}
	}
	return newest?.path ?? null;
}

/** True when spawnSync killed the child because `timeout` elapsed, rather than
 * the child exiting on its own or failing to start. */
export function isSpawnTimeout(result: SpawnResult): boolean {
	return (
		(result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
	);
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
	/** The run hit CLAUDE_TIMEOUT_MS and was killed mid-task. Advisory: for
	 * progress output and diagnostics ONLY. The environment-failure guard keys
	 * on token spend and must never read this — a timeout that burned real
	 * tokens is rule evidence, a timeout that burned none is an environment
	 * stall, and the existing token floor already separates the two. */
	timedOut?: boolean;
}

/**
 * Environment for the spawned benchmark `claude`, hermetically detached from
 * any parent Claude Code session. When the benchmark runs INSIDE a Claude
 * Code session (a /warden-* command, or a remote/cloud session), the child
 * CLI can bind to the parent session and report the PARENT's session id —
 * findTranscript then parses the parent's multi-megatoken transcript as the
 * run's cost (observed live 2026-07-10: a golden run "measured" 30.4M tokens,
 * and recordBaseline would have frozen that as run1). Stripping the
 * session-identity variables forces a fresh child session whose transcript is
 * the run's own. TOKEN_WARDEN_NO_DISTILL serves the same hermeticity goal for
 * the Stop hook.
 */
/** Session-identity variables stripped from the benchmark child's environment.
 * Exported for the hermeticity test: this list IS the fix for the 30.4M-token
 * false baseline, so a silent shortening of it must fail a test. */
export const SESSION_ENV_KEYS = [
	"CLAUDECODE",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_REMOTE_SESSION_ID",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SESSION_INGRESS_TOKEN_FILE",
	"CLAUDE_SESSION_INGRESS_TOKEN_FILE",
] as const;

export function benchChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TOKEN_WARDEN_NO_DISTILL: "1",
	};
	for (const key of SESSION_ENV_KEYS) {
		delete env[key];
	}
	return env;
}

/**
 * Variables the success check is allowed to see. Everything else — every API
 * key, cloud credential and token in the parent environment — is withheld.
 *
 * The check runs as `bash -c <success_check>` and a success check is arbitrary
 * shell from a golden-suite file, which under BYOA
 * (TOKEN_WARDEN_BENCHMARKS_DIR) may be third-party. It used to inherit
 * `process.env` verbatim, so "run a check" also meant "read ANTHROPIC_API_KEY
 * and every cloud credential". The check needs to locate tools and run the
 * fixture's test runner, nothing more, so this is an allowlist rather than a
 * denylist: a credential variable nobody has thought of yet is excluded by
 * default instead of leaking until someone adds it to a blocklist.
 */
export const CHECK_ENV_ALLOWLIST = [
	// Locating bash, node, npx, grep and friends.
	"PATH",
	// npx/npm resolve their cache and config under HOME; without it `npx
	// vitest` cannot run, and every bundled success check ends in one.
	"HOME",
	// Scratch space for npm/vitest.
	"TMPDIR",
	"TEMP",
	"TMP",
	// Locale affects `grep -i` and other text matching in success checks, so
	// it must match what the maintainer saw when the task was written.
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	// Some toolchains (nvm shims, corepack) key off these.
	"NODE_PATH",
	"SHELL",
	"USER",
	"LOGNAME",
] as const;

/**
 * Minimal environment for the `bash -c <success_check>` subprocess: the
 * allowlist above, plus a marker so a check can tell it is running under the
 * benchmark. Nothing else crosses the boundary.
 */
export function checkChildEnv(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { TOKEN_WARDEN_BENCH: "1" };
	for (const key of CHECK_ENV_ALLOWLIST) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** The subset of `spawnSync`'s contract `runOnce` depends on. Narrowing it to
 * an injectable function is what makes the run path testable without spawning
 * a real `claude`; `defaultRunOnceDeps.spawn` is `spawnSync` verbatim. */
export interface SpawnResult {
	status: number | null;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export interface BenchSpawnOptions {
	cwd: string;
	encoding: "utf8";
	timeout: number;
	maxBuffer: number;
	env?: NodeJS.ProcessEnv;
}

export type SpawnFn = (
	command: string,
	args: string[],
	options: BenchSpawnOptions,
) => SpawnResult;

/** Every side effect `runOnce` performs, injectable so the orchestration
 * (argv construction, output parsing, failure classification, persistence,
 * temp-dir disposal) can be tested without processes or a real fixture. */
export interface RunOnceDeps {
	spawn: SpawnFn;
	makeWorkDir: (task: GoldenTask) => string;
	disposeWorkDir: (dir: string) => void;
	copyFixture: (dest: string) => void;
	installAgent: (
		workDir: string,
		agent: string,
		definition: AgentDefinition,
		rules: readonly RuleRow[],
	) => void;
	findTranscript: (sessionId: string) => string | null;
	/** Transcript recovery for a run whose session id never arrived (timeout). */
	findTranscriptForWorkDir: (workDir: string) => string | null;
	readTranscript: (path: string) => string;
	now: () => string;
}

export const defaultRunOnceDeps: RunOnceDeps = {
	spawn: (command, args, options) => spawnSync(command, args, options),
	makeWorkDir: (task) => {
		// Installed here rather than at import time: only a real run creates a
		// temp copy, so only a real run needs the interrupt sweep.
		installWorkDirCleanup();
		const dir = mkdtempSync(join(tmpdir(), `warden-bench-${task.id}-`));
		registerWorkDir(dir);
		return dir;
	},
	disposeWorkDir: releaseWorkDir,
	copyFixture,
	installAgent,
	findTranscript: (sessionId) => findTranscript(sessionId),
	findTranscriptForWorkDir: (workDir) => findTranscriptForWorkDir(workDir),
	readTranscript: (path) => readFileSync(path, "utf8"),
	now: () => new Date().toISOString(),
};

export function runOnce(
	db: WardenDb,
	task: GoldenTask,
	definition: AgentDefinition,
	rules: readonly RuleRow[],
	options: SuiteOptions,
	deps: RunOnceDeps = defaultRunOnceDeps,
): RunResult {
	const workDir = deps.makeWorkDir(task);
	try {
		deps.copyFixture(workDir);
		deps.installAgent(workDir, task.agent, definition, rules);

		const model = options.model ?? definition.model;
		const claude = deps.spawn(
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
				maxBuffer: MAX_OUTPUT_BYTES,
				// Hermetic child session: no distiller off golden runs, and no
				// binding to a parent Claude Code session (see benchChildEnv).
				env: benchChildEnv(),
			},
		);
		if (claude.error) {
			// BUG FIX (2026-07): a 15-minute timeout was laundered into an
			// ENVIRONMENT failure. This threw, runSuite synthesized
			// { tokens: 0, completed: false }, and the <1,000-token discriminator
			// read that as quota death — so a candidate rule that sent the agent
			// into an exploration loop was indistinguishable from the API dying:
			// four such runs aborted the decision and requeued the rule, forever.
			// The worst possible rule could never be evicted.
			//
			// The discriminator is NOT the bug and is NOT touched. The bug is that
			// this path reported ZERO tokens for a run that spent fifteen minutes.
			// The transcript is on disk; only the session id was lost, because the
			// JSON summary prints at the end and the kill destroyed it. Recover it
			// from the workdir-derived project directory and report the run's real
			// cost. The existing token floor then classifies it correctly with no
			// change in meaning: a hang that burned tokens is rule evidence, a
			// hang that burned nothing (an API stall) is still an environment
			// failure. If nothing is recoverable we degrade to the old behavior.
			const recovered = isSpawnTimeout(claude)
				? deps.findTranscriptForWorkDir(workDir)
				: null;
			if (recovered) {
				const parsed = parseTranscript(deps.readTranscript(recovered));
				const timedOutTs = deps.now();
				// completed is false unconditionally and the success check is NOT
				// run: the agent was killed mid-task, and a half-mutated fixture
				// could pass a check it did not earn. A false run never reaches
				// recordBaseline either.
				upsertRun(db, {
					agent: task.agent,
					sessionId: basename(recovered, ".jsonl"),
					taskHash: task.id,
					inputTokens: parsed.inputTokens,
					outputTokens: parsed.outputTokens,
					cacheCreation: parsed.cacheCreation,
					cacheRead: parsed.cacheRead,
					toolCalls: parsed.toolCalls,
					fileRereads: parsed.fileRereads,
					completed: false,
					rulesetVersion: options.rulesetVersion,
					ts: timedOutTs,
					config: options.config,
					model: options.model ?? definition.model,
					durationMs: null,
				});
				return {
					sessionId: basename(recovered, ".jsonl"),
					tokens: totalTokens(parsed),
					completed: false,
					toolCalls: parsed.toolCalls,
					fileRereads: parsed.fileRereads,
					timedOut: true,
				};
			}
			throw claude.error;
		}
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

		const check = deps.spawn("bash", ["-c", task.successCheck], {
			cwd: workDir,
			encoding: "utf8",
			timeout: CHECK_TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
			// Allowlisted environment only: a success check is arbitrary shell
			// from a suite file and must never see the parent's credentials.
			env: checkChildEnv(),
		});
		// BUG FIX (2026-07): the success check's own failure to RUN used to be
		// recorded as the task failing. `bash` unavailable, the 5-minute check
		// timeout, and an output overrun all yield status===null (plus an
		// error), and `check.status === 0` quietly turned every one of them into
		// completed=false — an infrastructure failure entering the corpus as a
		// measurement, and (because the run burned real tokens) one that
		// isEnvironmentFailure cannot catch downstream. A check that did not run
		// produced no evidence: throw, so runSuite records a RUN-ERROR instead.
		// A genuine check failure always exits non-zero WITH a status.
		if (check.error) {
			throw new Error(
				`success check for ${task.id} could not run: ${check.error.message}`,
			);
		}
		if (check.status === null) {
			throw new Error(
				`success check for ${task.id} was killed before it could report` +
					` (signal ${check.signal ?? "unknown"}; timeout ${CHECK_TIMEOUT_MS}ms)`,
			);
		}
		const completed = check.status === 0;

		const transcriptPath = deps.findTranscript(sessionId);
		if (!transcriptPath) {
			throw new Error(`transcript not found for session ${sessionId}`);
		}
		const parsed = parseTranscript(deps.readTranscript(transcriptPath));
		const tokens = totalTokens(parsed);
		const ts = deps.now();

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
		// Every exit path — return, throw, spawn timeout — drops the fixture
		// copy. Interrupts unwind no finally at all; installWorkDirCleanup
		// covers those.
		deps.disposeWorkDir(workDir);
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
	/** Distribution weight carried through from the golden task (default 1). The
	 * weighted verdict estimators in src/select.ts read it off the summaries. */
	weight: number;
}

export function summarizeTask(
	taskId: string,
	results: RunResult[],
	weight = 1,
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
	return { taskId, results, meanCompletedTokens: avg, highVariance, weight };
}

/** True when a run's failure is environmental (quota death, API error, crash)
 * rather than evidence about the rule: it failed AND burned essentially no
 * tokens. Failed runs with real token spend stay regression signal. */
export function isEnvironmentFailure(result: RunResult): boolean {
	return !result.completed && result.tokens < ENV_FAILURE_TOKEN_FLOOR;
}

/** Pass-level environment-failure check: a measurement pass whose runs are
 * majority environment failures (with a minimum count so a couple of
 * transient crashes never trip it) cannot support any verdict. */
export function passEnvironmentFailure(summaries: TaskSummary[]): {
	envFailed: number;
	total: number;
	tripped: boolean;
} {
	const results = summaries.flatMap((s) => s.results);
	const envFailed = results.filter(isEnvironmentFailure).length;
	const total = results.length;
	return {
		envFailed,
		total,
		tripped: envFailed >= ENV_FAILURE_MIN_COUNT && envFailed * 2 > total,
	};
}

/**
 * Thrown when a measurement pass dies environmentally (quota exhaustion, API
 * outage) instead of producing evidence about a rule. Callers must NOT
 * finalize any verdict from it: the two real quota-death burns finalized
 * garbage evictions from the surviving handful of runs (FINDINGS.md, 2026-07).
 */
export class EnvironmentFailureError extends Error {
	readonly info: {
		agent: string;
		/** Which measurement pass died. */
		label: string;
		/** Zero-token failed runs observed in the pass. */
		envFailed: number;
		/** Runs observed in the pass before the abort. */
		total: number;
		/** Consecutive-failure count when the streak abort fired; null when the
		 * pass-level majority check fired instead. */
		streak: number | null;
		/** Summaries built before the abort — diagnostics only (raw rows are
		 * already recorded in `runs`). */
		partial: TaskSummary[];
	};

	constructor(info: EnvironmentFailureError["info"]) {
		super(
			`environment failure during ${info.label}: ${info.envFailed} of ` +
				`${info.total} runs failed with ~0 tokens — quota exhausted?`,
		);
		this.name = "EnvironmentFailureError";
		this.info = info;
	}
}

export interface SuiteOptions {
	/** Exact rule set to compile into the agent's MEMORY.md for these runs. */
	rules: readonly RuleRow[];
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
	single: typeof runOnce = runOnce,
): TaskSummary[] {
	// Design by contract. Both of these used to return an empty or partial
	// summary list that reads downstream exactly like a legitimately measured
	// pass — the selector cannot tell "no evidence" from "no difference", so an
	// empty pass is a silent path to a verdict about an unmeasured rule.
	if (tasks.length === 0) {
		throw new Error(
			`runSuite [${options.label}]: no golden tasks for agent "${agent}" —` +
				" a verdict cannot be built from an empty suite",
		);
	}
	if (!Number.isInteger(options.runs) || options.runs < 1) {
		throw new Error(
			`runSuite [${options.label}]: runs must be a positive integer (got ${options.runs})`,
		);
	}
	// Fixture deps are only needed by the real runner; an injected fake
	// (tests) must not trigger an npm install.
	if (single === runOnce) ensureFixtureDeps();
	const definition = options.definitionOverride ?? loadAgentDefinition(agent);
	const summaries: TaskSummary[] = [];
	// Consecutive environment failures (zero-token failed runs) span task
	// boundaries: a quota death kills every subsequent run regardless of task,
	// and continuing would burn the rest of the pass producing no evidence.
	let envStreak = 0;
	let envFailed = 0;
	let total = 0;
	const abort = (task: GoldenTask, results: RunResult[]): never => {
		console.log(
			`ENVIRONMENT FAILURE: ${envStreak} consecutive zero-token failed runs` +
				` — quota exhausted? aborting [${options.label}]`,
		);
		throw new EnvironmentFailureError({
			agent,
			label: options.label,
			envFailed,
			total,
			streak: envStreak,
			partial: [...summaries, summarizeTask(task.id, results, task.weight)],
		});
	};
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
				result = single(db, task, definition, options.rules, options);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				console.log(`RUN-ERROR ${detail.split("\n")[0]}`);
				result = { sessionId: "run-error", tokens: 0, completed: false };
				results.push(result);
				total++;
				envFailed++;
				envStreak++;
				if (envStreak >= ENV_FAILURE_STREAK) abort(task, results);
				continue;
			}
			results.push(result);
			total++;
			console.log(
				`${
					result.completed ? "ok" : result.timedOut ? "TIMEOUT" : "FAILED-CHECK"
				} ${result.tokens} tokens (${result.sessionId})`,
			);
			if (isEnvironmentFailure(result)) {
				envFailed++;
				envStreak++;
				if (envStreak >= ENV_FAILURE_STREAK) abort(task, results);
			} else {
				envStreak = 0;
			}
		}
		const summary = summarizeTask(task.id, results, task.weight);
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
	/** True when benchmarking exceeded 10% of the week's real-work tokens.
	 * Only ever true when there IS a ratio: with no real work collected the
	 * overhead fraction is unknowable, not large. */
	warn: boolean;
}

/** The optimizer reporting on its own overhead (spec §4.2). */
export function metaCost(
	benchTokens: number,
	realWorkTokens: number,
): MetaCost {
	if (realWorkTokens <= 0) {
		// No denominator: "exceeded 10% of the week's real-work tokens" is a
		// quantitative claim that cannot be made here. Every fresh install
		// printed it, directly under the correct "no real-work tokens
		// collected" line, which is the line that actually says something.
		return {
			benchTokens,
			realWorkTokens: 0,
			ratio: null,
			warn: false,
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

	// Copy, never push into what the query returned: the active set is the
	// input to compileMemoryMd, and this was the one in-place mutator on that
	// path. A caller that reused the returned array would silently get the
	// candidate rule compiled into its own MEMORY.md.
	const activeRules = getActiveRules(db, agent);
	const rules: RuleRow[] = [...activeRules];
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
	withDb((db) => {
		const agents = args.agent === "all" ? knownAgents() : [args.agent];
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
	});
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
