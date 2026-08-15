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
import { homedir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.js";
import { assertKnownAgent } from "./registry.js";
import { trigramSimilarity } from "./rules.js";
import { displayText } from "./sanitize.js";

/** Two prompts within this trigram similarity are treated as the same task. */
const DEDUP_THRESHOLD = 0.6;
/** Prompts shorter than this are noise (acks, one-word follow-ups). */
const MIN_PROMPT_CHARS = 24;
/** Hard cap on a drafted prompt, applied after redaction. */
const MAX_PROMPT_CHARS = 600;

/**
 * Credential shapes that turn up pasted into real prompts. Each is replaced
 * wholesale with `[REDACTED]`; a false positive costs a human one edit in a
 * review stub, a false negative writes a live secret into a file the user is
 * being invited to commit into `benchmarks/`.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	// Anthropic / OpenAI / Stripe style `sk-...`, `sk-ant-...`, `rk_live_...`.
	/\b(?:sk|rk|pk)[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]{16,}\b/g,
	// GitHub tokens (classic, fine-grained, app, OAuth, refresh).
	/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	// AWS access key ids and Google API keys.
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}\b/g,
	// Slack tokens.
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
	// JSON Web Tokens.
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	// `Authorization: Bearer <blob>` and private-key PEM headers.
	/\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
	// `api_key: v`, `token=v`, `secret=v`, `DB_PASSWORD=v`. The surrounding
	// `[A-Za-z0-9_.-]*` deliberately absorbs prefixes and suffixes (`DB_`,
	// `_VALUE`) so a namespaced env-var name still trips the match.
	/[A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret|password|passwd|pwd|token)[A-Za-z0-9_]*\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
	/-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Strip identifying and secret material out of a real user prompt before it is
 * written to disk.
 *
 * These prompts come verbatim out of the user's OWN session transcripts, and
 * the drafts land under `benchmarks/<agent>/drafts/` — a path inside the
 * user's repo that they are explicitly told to review and promote, i.e. a path
 * that gets committed and pushed. Without this step, `--from ~/.claude/projects`
 * would happily copy `/Users/<real name>/...`, a pasted API key, or a
 * colleague's email address straight into version control.
 *
 * Home directories collapse to `~` rather than being redacted: the shape of the
 * path is useful context for writing a golden task, the username is not.
 */
export function redactSensitive(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	// This machine's actual home directory first (it may not match the generic
	// shapes below, e.g. a relocated $HOME), then the conventional layouts.
	const home = homedir();
	if (home && home !== "/") {
		out = out.split(home).join("~");
	}
	out = out.replace(/\/(?:Users|home)\/[^/\s"']+/g, "~");
	out = out.replace(/\/(?:var\/)?root\b/g, "~");
	// Email addresses identify the user and their colleagues.
	out = out.replace(
		/\b[^\s@,;<>"']+@[^\s@,;<>"']+\.[A-Za-z]{2,}\b/g,
		"[EMAIL]",
	);
	return out;
}

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

/**
 * Turn a raw transcript prompt into a value that is safe to write inside a
 * double-quoted frontmatter scalar: neutralized (ANSI/control characters
 * stripped, whitespace collapsed), redacted, then made quote- and
 * backslash-safe, and only then clamped.
 *
 * Redaction happens BEFORE the length clamp so a secret can never survive by
 * being cut in half. Backslashes become `/` because the value is emitted
 * between double quotes: a trailing `\` would escape the closing quote and
 * leave the whole file unparseable, and these drafts are Windows-path noise at
 * worst — a human rewrites the prompt during review anyway.
 */
export function sanitizeDraftPrompt(prompt: string): string {
	const neutral = displayText(prompt, MAX_PROMPT_CHARS * 4);
	return redactSensitive(neutral)
		.replace(/"/g, "'")
		.replace(/\\/g, "/")
		.slice(0, MAX_PROMPT_CHARS)
		.trim();
}

/** Render a draft as a golden-task file with the success check left for a human
 * to write — never auto-frozen. */
export function renderDraft(
	agent: string,
	index: number,
	draft: TaskDraft,
): string {
	const id = `${agent}-draft-${String(index).padStart(2, "0")}`;
	// The session id is a filename off disk, so it is environment-derived exactly
	// like the prompt. It is emitted inside an HTML comment: displayText removes
	// the newline that would end the comment line early, and "-->" is defused
	// because it would close the comment outright and inject markdown into a file
	// the user is being invited to commit.
	const session = displayText(draft.sourceSession, 120).replace(/--+>/g, "->");
	return [
		"---",
		`id: "${id}"`,
		`agent: "${agent}"`,
		`prompt: "${sanitizeDraftPrompt(draft.prompt)}"`,
		'success_check: "TODO — write a deterministic check, then move out of drafts/ to freeze"',
		"---",
		"",
		"<!-- UNVERIFIED DRAFT — NOT part of the golden suite. -->",
		`<!-- Sampled from real session ${session}; the prompt is machine-extracted and only`,
		"     best-effort redacted (home paths -> ~, credential-shaped strings -> [REDACTED], addresses",
		"     -> [EMAIL]). Re-read it for anything private before this file goes anywhere. -->",
		"<!-- To promote: write a deterministic success_check, delete this banner, and move the file up",
		`     into benchmarks/${agent}/ as golden-NN.md. Loading only ever picks up golden-NN.md, so a`,
		"     draft left here can never enter a measurement by accident. -->",
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
	assertKnownAgent(agent);
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
runCli(import.meta.url, () => {
	return main(process.argv.slice(2));
});
/* v8 ignore stop */
