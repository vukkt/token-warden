/**
 * Zero-token falsification: does an active rule contradict the repo's own
 * conventions (CLAUDE.md)?
 *
 * CLI: npx tsx src/contradict.ts [--agent <name>] [--file <path>] [--gate]
 *
 * A rule that the golden suite happens to reward but that the repository
 * explicitly forbids is a false rule — and catching it needs no benchmark run,
 * just the project's stated conventions. This is a best-effort lexical check
 * (shared topic + opposite polarity, or an explicit antonym pair on a shared
 * topic); it FLAGS for human review and never auto-evicts (the controlled
 * fixture stays the only authority that removes a rule, per governance). `--gate`
 * exits non-zero when any contradiction is found so CI can surface it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getActiveRules, openDb } from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

const STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"to",
	"of",
	"in",
	"on",
	"for",
	"and",
	"or",
	"but",
	"if",
	"is",
	"are",
	"be",
	"it",
	"this",
	"that",
	"with",
	"you",
	"your",
	"any",
	"as",
	"at",
	"by",
	"from",
	"into",
	"then",
	"than",
	"so",
	"do",
	"does",
	"use",
	"using",
	"when",
	"before",
	"after",
	"first",
	"once",
	"each",
	"every",
	"should",
	"must",
	"can",
	"will",
	"we",
	"our",
	"they",
]);

/** Tokens that mark a directive as a prohibition / negative polarity. */
const NEGATIONS = new Set([
	"never",
	"not",
	"no",
	"dont",
	"don't",
	"avoid",
	"without",
	"shouldnt",
	"shouldn't",
	"cannot",
	"cant",
	"can't",
	"stop",
	"skip",
	"refrain",
]);

/** Affirmation markers — paired against their negations as direct antonyms. */
const ANTONYMS: readonly [string, string][] = [
	["always", "never"],
	["all", "none"],
	["whole", "partial"],
	["full", "partial"],
	["every", "no"],
];

export interface Contradiction {
	ruleId: number;
	ruleBody: string;
	conflictingLine: string;
	reason: string;
}

function words(text: string): string[] {
	return (text.toLowerCase().match(/[a-z']+/g) ?? []).filter(
		(w) => w.length > 1,
	);
}

function contentWords(text: string): Set<string> {
	return new Set(
		words(text).filter((w) => !STOPWORDS.has(w) && !NEGATIONS.has(w)),
	);
}

function isNegated(text: string): boolean {
	return words(text).some((w) => NEGATIONS.has(w));
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
	let n = 0;
	for (const w of a) if (b.has(w)) n++;
	return n;
}

/** Split CLAUDE.md into candidate directive lines: list items, sentences, and
 * non-empty lines, with markdown bullet/heading noise stripped. */
function directiveLines(claudeMd: string): string[] {
	return claudeMd
		.split(/\r?\n|(?<=[.!?])\s+/)
		.map((l) => l.replace(/^[\s>#*\-\d.)]+/, "").trim())
		.filter((l) => l.length > 0);
}

/**
 * Best-effort lexical contradiction detection between active rules and the
 * repo's CLAUDE.md directives. A pair conflicts when they share a topic
 * (≥2 content words) with opposite polarity, or share ≥1 content word and an
 * explicit antonym pair spans them (e.g. "always" here, "never" there).
 */
export function findContradictions(
	rules: { id: number; body: string }[],
	claudeMd: string,
): Contradiction[] {
	// Tokenize each directive line once, not once per rule.
	const lines = directiveLines(claudeMd).map((text) => ({
		text,
		content: contentWords(text),
		negated: isNegated(text),
		all: new Set(words(text)),
	}));
	const found: Contradiction[] = [];
	for (const rule of rules) {
		const rw = contentWords(rule.body);
		const rNeg = isNegated(rule.body);
		const rWords = new Set(words(rule.body));
		for (const line of lines) {
			const shared = intersectionSize(rw, line.content);
			let reason: string | null = null;
			if (shared >= 2 && rNeg !== line.negated) {
				reason = `shares ${shared} key terms with an opposite-polarity directive`;
			} else if (shared >= 1) {
				for (const [a, b] of ANTONYMS) {
					const conflict =
						(rWords.has(a) && line.all.has(b)) ||
						(rWords.has(b) && line.all.has(a));
					if (conflict) {
						reason = `uses "${a}"/"${b}" against a shared-topic directive`;
						break;
					}
				}
			}
			if (reason) {
				found.push({
					ruleId: rule.id,
					ruleBody: rule.body,
					conflictingLine: line.text,
					reason,
				});
				break; // one flag per rule is enough to prompt review
			}
		}
	}
	return found;
}

export function renderContradictions(
	agent: string,
	contradictions: Contradiction[],
): string {
	if (contradictions.length === 0) {
		return `${agent}: no rules contradict CLAUDE.md.`;
	}
	const lines = contradictions.map(
		(c) =>
			`  rule ${c.ruleId}: "${c.ruleBody}"\n    ${c.reason}\n    CLAUDE.md: "${c.conflictingLine}"`,
	);
	return [
		`${agent}: ${contradictions.length} rule(s) may contradict CLAUDE.md (review recommended — not auto-evicted):`,
		...lines,
	].join("\n");
}

interface ContradictArgs {
	agent: string | null;
	file: string;
	gate: boolean;
}

export function parseContradictArgs(argv: string[]): ContradictArgs {
	// The slash command cd's into the plugin root, so process.cwd() would read
	// token-warden's own CLAUDE.md. Claude Code exposes the user's project root as
	// CLAUDE_PROJECT_DIR — prefer it so the check runs against the user's repo.
	const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
	const args: ContradictArgs = {
		agent: null,
		file: join(projectDir, "CLAUDE.md"),
		gate: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") args.agent = argv[++i] ?? null;
		else if (flag === "--file") args.file = argv[++i] ?? args.file;
		else if (flag === "--gate") args.gate = true;
		else throw new Error(`unknown flag: ${flag}`);
	}
	if (
		args.agent &&
		!(DOMAIN_AGENTS as readonly string[]).includes(args.agent)
	) {
		throw new Error(`--agent must be one of: ${DOMAIN_AGENTS.join(", ")}`);
	}
	return args;
}

export function main(argv: string[]): number {
	const args = parseContradictArgs(argv);
	let claudeMd: string;
	try {
		claudeMd = readFileSync(args.file, "utf8");
	} catch {
		console.log(`No CLAUDE.md found at ${args.file}; nothing to check.`);
		return 0;
	}
	const agents = args.agent ? [args.agent] : [...DOMAIN_AGENTS];
	const db = openDb();
	try {
		let any = false;
		const blocks = agents.map((agent) => {
			const rules = getActiveRules(db, agent);
			const contradictions = findContradictions(rules, claudeMd);
			if (contradictions.length > 0) any = true;
			return renderContradictions(agent, contradictions);
		});
		console.log(blocks.join("\n\n"));
		return args.gate && any ? 1 : 0;
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
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
