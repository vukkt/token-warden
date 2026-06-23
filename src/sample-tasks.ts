/**
 * Production-sampled golden-task drafts.
 *
 * CLI: npx tsx src/sample-tasks.ts --agent <name> --from <dir|file> [--out <dir>]
 *
 * A hand-curated golden suite is real upfront work, and it can only measure
 * waste on the cases someone thought to encode. This drafts candidate golden
 * tasks from REAL session transcripts — it pulls the initiating user prompt out
 * of each session, de-duplicates near-identical ones, and writes review stubs
 * (prompt filled in, `success_check` left as TODO). It deliberately does NOT add
 * them to the frozen suite: a human writes the success check and freezes the
 * task, preserving the baseline-immutability invariant. Spends no tokens.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { trigramSimilarity } from "./distill.js";
import { DOMAIN_AGENTS } from "./types.js";

/** Two prompts within this trigram similarity are treated as the same task. */
const DEDUP_THRESHOLD = 0.6;
/** Prompts shorter than this are noise (acks, one-word follow-ups). */
const MIN_PROMPT_CHARS = 24;

export interface TaskDraft {
	prompt: string;
	sourceSession: string;
}

/** Pull the first substantive user-message text out of a session transcript
 * (JSONL). Returns null when there is no usable opening prompt. */
export function extractFirstUserPrompt(jsonl: string): string | null {
	for (const line of jsonl.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof row !== "object" || row === null) continue;
		const rec = row as { type?: unknown; message?: unknown };
		if (
			rec.type !== "user" ||
			typeof rec.message !== "object" ||
			!rec.message
		) {
			continue;
		}
		const msg = rec.message as { role?: unknown; content?: unknown };
		if (msg.role !== "user") continue;
		let text: string;
		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = msg.content
				.filter(
					(p): p is { type: string; text: string } =>
						typeof p === "object" &&
						p !== null &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string",
				)
				.map((p) => p.text)
				.join("\n");
		} else {
			continue;
		}
		const trimmed = text.trim();
		// Skip tool-result envelopes and command noise; keep real instructions.
		if (trimmed.length < MIN_PROMPT_CHARS) continue;
		if (trimmed.startsWith("<") || trimmed.startsWith("Caveat:")) continue;
		return trimmed.replace(/\s+/g, " ");
	}
	return null;
}

/** Extract de-duplicated task drafts from a set of transcripts. */
export function extractTaskDrafts(
	transcripts: { sessionId: string; jsonl: string }[],
): TaskDraft[] {
	const drafts: TaskDraft[] = [];
	for (const t of transcripts) {
		const prompt = extractFirstUserPrompt(t.jsonl);
		if (!prompt) continue;
		const dup = drafts.some(
			(d) => trigramSimilarity(d.prompt, prompt) > DEDUP_THRESHOLD,
		);
		if (dup) continue;
		drafts.push({ prompt, sourceSession: t.sessionId });
	}
	return drafts;
}

/** Render a draft as a golden-task file with the success check left for a human
 * to write — never auto-frozen. */
export function renderDraft(
	agent: string,
	index: number,
	draft: TaskDraft,
): string {
	const id = `${agent}-draft-${String(index).padStart(2, "0")}`;
	const safePrompt = draft.prompt.replace(/"/g, "'").slice(0, 600);
	return [
		"---",
		`id: "${id}"`,
		`agent: "${agent}"`,
		`prompt: "${safePrompt}"`,
		'success_check: "TODO — write a deterministic check, then move out of drafts/ to freeze"',
		"---",
		"",
		`<!-- Drafted from real session ${draft.sourceSession}. Review before adding to the frozen suite. -->`,
		"",
	].join("\n");
}

function readTranscripts(from: string): { sessionId: string; jsonl: string }[] {
	if (!existsSync(from)) {
		throw new Error(`--from path not found: ${from}`);
	}
	const stat = statSync(from);
	const files = stat.isDirectory()
		? readdirSync(from)
				.filter((n) => n.endsWith(".jsonl"))
				.map((n) => join(from, n))
		: [from];
	return files.map((f) => ({
		sessionId: f.replace(/^.*\//, "").replace(/\.jsonl$/, ""),
		jsonl: readFileSync(f, "utf8"),
	}));
}

interface SampleArgs {
	agent: string;
	from: string;
	out: string;
}

export function parseSampleArgs(argv: string[]): SampleArgs {
	let agent = "";
	let from = "";
	let out = "";
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") agent = argv[++i] ?? "";
		else if (flag === "--from") from = argv[++i] ?? "";
		else if (flag === "--out") out = argv[++i] ?? "";
		else throw new Error(`unknown flag: ${flag}`);
	}
	if (!(DOMAIN_AGENTS as readonly string[]).includes(agent)) {
		throw new Error(`--agent must be one of: ${DOMAIN_AGENTS.join(", ")}`);
	}
	if (!from) throw new Error("--from <dir|file> is required");
	return {
		agent,
		from,
		out: out || join(process.cwd(), "benchmarks", agent, "drafts"),
	};
}

export function main(argv: string[]): number {
	const args = parseSampleArgs(argv);
	const drafts = extractTaskDrafts(readTranscripts(args.from));
	if (drafts.length === 0) {
		console.log("No usable task prompts found in the given transcripts.");
		return 0;
	}
	mkdirSync(args.out, { recursive: true });
	drafts.forEach((draft, i) => {
		const file = join(
			args.out,
			`${args.agent}-draft-${String(i + 1).padStart(2, "0")}.md`,
		);
		writeFileSync(file, renderDraft(args.agent, i + 1, draft));
	});
	console.log(
		`Wrote ${drafts.length} task draft(s) to ${args.out}. Add a success_check to each and move it into benchmarks/${args.agent}/ to freeze it into the suite.`,
	);
	return 0;
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
