/**
 * Distiller: turn one unusually expensive run into 0–2 candidate rules.
 *
 * CLI: npx tsx src/distill.ts --run <runs.id> --transcript <path>
 *
 * Spawned detached by collect.ts when a run's total tokens exceed the
 * agent's rolling p75 (minimum 5 prior runs). One headless haiku call,
 * strict-JSON output, zod-validated; invalid output is logged and dropped —
 * never retried (spec §3.1). Candidates land in SQLite with
 * context_cost = ceil(len/4); near-duplicates (>0.85 trigram similarity to
 * any existing rule for the agent) are skipped.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
	defaultDbPath,
	insertRule,
	listRulesByAgent,
	openDb,
	RUN_TOTAL_TOKENS_SQL,
	type RunRow,
	recentQuestionsFrom,
	type WardenDb,
} from "./db.js";
import { digestTranscript } from "./transcript.js";
import { DOMAIN_AGENTS } from "./types.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SIMILARITY_THRESHOLD = 0.85;
const MIN_PRIOR_RUNS = 5;
/** Rolling window of most recent runs used for the p75. */
const ROLLING_WINDOW = 50;
const MAX_DIGEST_CHARS = 8000;
const DISTILL_TIMEOUT_MS = 2 * 60 * 1000;

function logLine(message: string): void {
	try {
		const logPath = join(dirname(defaultDbPath()), "distill.log");
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never take the distiller down.
	}
}

/** Nearest-rank 75th percentile. */
export function p75(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.ceil(0.75 * sorted.length) - 1;
	return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Distill only when the run is expensive relative to the agent's recent
 * history: total above the rolling p75 of the last ROLLING_WINDOW runs,
 * with at least MIN_PRIOR_RUNS prior runs (otherwise there is no
 * meaningful distribution yet).
 */
export function shouldDistill(
	db: WardenDb,
	agent: string,
	runId: number,
	totalTokens: number,
): boolean {
	// Real-work sessions only: golden/bench runs have a different cost
	// profile and would drag the percentile, over- or under-triggering
	// distillation on ordinary sessions.
	const priors = db
		.prepare<unknown[], { total: number }>(
			`SELECT ${RUN_TOTAL_TOKENS_SQL} AS total
			 FROM runs WHERE agent = ? AND id != ? AND task_hash IS NULL
			 ORDER BY ts DESC LIMIT ?`,
		)
		.all(agent, runId, ROLLING_WINDOW)
		.map((row) => row.total);
	if (priors.length < MIN_PRIOR_RUNS) return false;
	return totalTokens > p75(priors);
}

/** Stop fires after every turn, so one long expensive session would spawn a
 * distiller per turn over the same transcript. Any rule already born from
 * this run is the persistent "been here" marker. */
export function alreadyDistilled(db: WardenDb, runId: number): boolean {
	const row = db
		.prepare<unknown[], { n: number }>(
			"SELECT COUNT(*) AS n FROM rules WHERE source_run = ?",
		)
		.get(runId);
	return (row?.n ?? 0) > 0;
}

function characterTrigrams(text: string): Set<string> {
	const normalized = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	const padded = `  ${normalized} `;
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= padded.length; i++) {
		grams.add(padded.slice(i, i + 3));
	}
	return grams;
}

/** Jaccard similarity over character trigrams, in [0, 1]. */
export function trigramSimilarity(a: string, b: string): number {
	const gramsA = characterTrigrams(a);
	const gramsB = characterTrigrams(b);
	if (gramsA.size === 0 || gramsB.size === 0) {
		return a.trim() === b.trim() ? 1 : 0;
	}
	let intersection = 0;
	for (const gram of gramsA) {
		if (gramsB.has(gram)) intersection++;
	}
	return intersection / (gramsA.size + gramsB.size - intersection);
}

const rulesSchema = z
	.array(
		z.object({
			// Single printable line: control characters (including newlines)
			// are rejected so a rule body can never fake structure in the
			// compiled MEMORY.md or the status report.
			body: z
				.string()
				.trim()
				.min(10)
				.max(200)
				// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
				.regex(/^[^\x00-\x1f\x7f]+$/),
		}),
	)
	.max(2);

/**
 * Parse the model's reply into rules. Strict: must be a JSON array of 0–2
 * `{body}` objects (a stray markdown fence is tolerated, content inside is
 * not). Returns null on anything else — the caller logs and drops, never
 * retries.
 */
export function parseRulesJson(text: string): { body: string }[] | null {
	const stripped = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	let raw: unknown;
	try {
		raw = JSON.parse(stripped);
	} catch {
		return null;
	}
	const result = rulesSchema.safeParse(raw);
	return result.success ? result.data : null;
}

export function contextCost(body: string): number {
	return Math.ceil(body.length / 4);
}

function buildPrompt(
	run: RunRow,
	digest: string,
	recentQuestions: string[] = [],
): string {
	const total =
		run.input_tokens + run.output_tokens + run.cache_creation + run.cache_read;
	const questionSection =
		recentQuestions.length > 0
			? [
					"Questions this agent recently had to ask other agents (a sign its own knowledge or approach has gaps):",
					...recentQuestions.map((q) => `- ${q}`),
					"",
				]
			: [];
	return [
		`An AI coding agent ("${run.agent}") just finished a session that used an unusually high number of tokens compared to its history.`,
		"",
		"Waste statistics:",
		`- total tokens processed: ${total}`,
		`- tool calls: ${run.tool_calls}`,
		`- files read two or more times: ${run.file_rereads}`,
		`- task completed: ${run.completed === 1 ? "yes" : "no"}`,
		"",
		...questionSection,
		"Action trace (truncated):",
		digest,
		"",
		"From this trace, extract at most 2 generalizable efficiency rules this agent could follow in FUTURE sessions to use fewer tokens. Each rule must be:",
		"- one imperative sentence under 200 characters",
		"- generalizable to other tasks (never mention specific files, symbols, or this task)",
		"- about working cheaper (navigation, reading discipline, planning, tool choice) — not about correctness",
		"",
		'Reply with ONLY a raw JSON array, no markdown fences, no commentary: [{"body": "..."}] or [] if no clear generalizable lesson exists.',
	].join("\n");
}

interface DistillArgs {
	runId: number;
	transcriptPath: string;
}

export function parseDistillArgs(argv: string[]): DistillArgs {
	let runId: number | null = null;
	let transcriptPath: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--run") {
			runId = Number(argv[i + 1]);
			i++;
		} else if (argv[i] === "--transcript") {
			transcriptPath = argv[i + 1] ?? null;
			i++;
		} else {
			throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	if (runId === null || !Number.isInteger(runId)) {
		throw new Error("--run <id> is required");
	}
	if (!transcriptPath) {
		throw new Error("--transcript <path> is required");
	}
	return { runId, transcriptPath };
}

export function distill(args: DistillArgs): void {
	const db = openDb();
	try {
		const run = db
			.prepare<unknown[], RunRow>("SELECT * FROM runs WHERE id = ?")
			.get(args.runId);
		if (!run) {
			logLine(`run ${args.runId} not found; nothing to distill`);
			return;
		}
		if (!(DOMAIN_AGENTS as readonly string[]).includes(run.agent)) {
			logLine(
				`run ${run.id}: agent "${run.agent}" has no golden suite; rules would be unmeasurable — skipping`,
			);
			return;
		}
		if (alreadyDistilled(db, run.id)) {
			logLine(`run ${run.id}: already distilled; skipping`);
			return;
		}
		const total =
			run.input_tokens +
			run.output_tokens +
			run.cache_creation +
			run.cache_read;
		if (!shouldDistill(db, run.agent, run.id, total)) {
			logLine(
				`run ${run.id} (${run.agent}, ${total} tokens) below rolling p75 or too few priors; skipping`,
			);
			return;
		}

		const digest = digestTranscript(
			readFileSync(args.transcriptPath, "utf8"),
			MAX_DIGEST_CHARS,
		);
		const prompt = buildPrompt(
			run,
			digest,
			recentQuestionsFrom(db, run.agent, 5),
		);

		const claude = spawnSync(
			"claude",
			[
				"-p",
				prompt,
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
				timeout: DISTILL_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
			},
		);
		if (claude.error) throw claude.error;
		const output = JSON.parse(claude.stdout) as { result?: string };
		const rules = parseRulesJson(output.result ?? "");
		if (rules === null) {
			logLine(
				`run ${run.id}: model returned invalid rules JSON; dropping (never retried). head: ${(output.result ?? "").slice(0, 200)}`,
			);
			return;
		}

		const existing = listRulesByAgent(db, run.agent);
		const ts = new Date().toISOString();
		for (const rule of rules) {
			const nearDuplicate = existing.find(
				(other) =>
					trigramSimilarity(rule.body, other.body) > SIMILARITY_THRESHOLD,
			);
			if (nearDuplicate) {
				logLine(
					`run ${run.id}: skipping near-duplicate of rule ${nearDuplicate.id}: "${rule.body}"`,
				);
				continue;
			}
			const id = insertRule(db, {
				agent: run.agent,
				body: rule.body,
				contextCost: contextCost(rule.body),
				sourceRun: run.id,
				createdAt: ts,
			});
			logLine(
				`run ${run.id}: new candidate ${id} for ${run.agent}: "${rule.body}"`,
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

if (invokedDirectly) {
	try {
		distill(parseDistillArgs(process.argv.slice(2)));
	} catch (err) {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		logLine(`distill error: ${detail}`);
	}
	process.exit(0);
}
/* v8 ignore stop */
