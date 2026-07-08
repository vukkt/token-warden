/**
 * Rule-body compression A/B: propose a shorter body for a measured rule.
 *
 * CLI: npx tsx src/compress.ts --agent <name> --rule <id> [--dry-run]
 *
 * Rent is length/4, so halving a rule's characters halves its rent — if the
 * measured savings hold, marginal rules clear the 2x bar. One headless model
 * call rewrites the body at <= half the length preserving the exact behavioral
 * meaning; the rewrite is inserted as a NEW candidate carrying
 * `replaces = <original id>`, and the selector measures it as a SWAP — the
 * active set with the variant instead of the original — because benching it
 * on top of the semantically identical original would pin its delta at ~0.
 * It must clear 2x its own rent like any rule (invariant #1). The original is
 * never auto-removed: once the variant is active, the original is redundant
 * and exits through its own re-audits (two-strike).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
	getRuleById,
	insertRule,
	listRulesByAgent,
	openDb,
	type RuleRow,
	type WardenDb,
} from "./db.js";
import { contextCost, trigramSimilarity } from "./distill.js";
import { assertKnownAgent } from "./registry.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const COMPRESS_TIMEOUT_MS = 2 * 60 * 1000;
const COMPRESS_MODEL = process.env.TOKEN_WARDEN_DISTILL_MODEL ?? "sonnet";
/** A rewrite must not be a near-verbatim copy — otherwise there is nothing
 * to A/B and the dedupe machinery would rightly reject it downstream. */
const SIMILARITY_THRESHOLD = 0.85;

const rewriteSchema = z.object({
	// Same constraints as a distilled rule body: one printable line.
	body: z
		.string()
		.trim()
		.min(10)
		.max(200)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
		.regex(/^[^\x00-\x1f\x7f]+$/),
});

/** Parse the model's reply: a single JSON object {"body": "..."}. Strict —
 * null on anything else; the caller reports and stops, never retries. */
export function parseRewriteJson(text: string): { body: string } | null {
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
	const result = rewriteSchema.safeParse(raw);
	return result.success ? result.data : null;
}

export function buildCompressPrompt(rule: RuleRow): string {
	const budget = Math.max(10, Math.floor(rule.body.length / 2));
	return [
		"An AI coding agent carries this efficiency rule in its prompt every session:",
		"",
		`"${rule.body}"`,
		"",
		`Rewrite it in AT MOST ${budget} characters. The rewrite must:`,
		"- preserve the EXACT behavioral meaning — same trigger, same action, no weakening, no broadening",
		"- stay one imperative sentence, plain ASCII, no abbreviations a reader would stumble on",
		"- never add new advice or drop a qualifier that changes when the rule applies",
		"",
		'Reply with ONLY a raw JSON object, no markdown fences, no commentary: {"body": "..."}',
	].join("\n");
}

export interface CompressArgs {
	agent: string;
	rule: number;
	dryRun: boolean;
}

export function parseCompressArgs(argv: string[]): CompressArgs {
	let agent = "";
	let rule: number | null = null;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--agent") agent = argv[++i] ?? "";
		else if (argv[i] === "--rule") rule = Number(argv[++i]);
		else if (argv[i] === "--dry-run") dryRun = true;
		else throw new Error(`unknown flag: ${argv[i]}`);
	}
	assertKnownAgent(agent);
	if (rule === null || !Number.isInteger(rule)) {
		throw new Error("--rule <id> is required");
	}
	return { agent, rule, dryRun };
}

/** Ask the model for the rewrite. Split out so tests stub the spawn boundary
 * while runCompress exercises the real validation pipeline. */
export function requestRewrite(prompt: string): string {
	const claude = spawnSync(
		"claude",
		[
			"-p",
			prompt,
			"--model",
			COMPRESS_MODEL,
			"--max-turns",
			"1",
			"--output-format",
			"json",
		],
		{
			cwd: pluginRoot,
			encoding: "utf8",
			timeout: COMPRESS_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	if (claude.error) throw claude.error;
	// Exit code, not output, is the failure signal (error-ledger rule): a
	// non-zero exit with empty stdout must not surface as a JSON parse error.
	if (claude.status !== 0) {
		throw new Error(
			`claude exited ${claude.status}: ${(claude.stderr ?? "").slice(0, 200)}`,
		);
	}
	const output = JSON.parse(claude.stdout) as { result?: string };
	return output.result ?? "";
}

export function runCompress(
	db: WardenDb,
	args: CompressArgs,
	rewrite: (prompt: string) => string = requestRewrite,
): string {
	const rule = getRuleById(db, args.rule);
	if (!rule || rule.agent !== args.agent) {
		throw new Error(`no rule ${args.rule} for agent ${args.agent}`);
	}
	if (rule.status !== "active") {
		throw new Error(
			`rule ${args.rule} is ${rule.status} — only an active (measured) rule is worth compressing`,
		);
	}

	const reply = rewrite(buildCompressPrompt(rule));
	const parsed = parseRewriteJson(reply);
	if (parsed === null) {
		throw new Error(
			`model returned invalid rewrite JSON; dropping (never retried). head: ${reply.slice(0, 200)}`,
		);
	}
	if (parsed.body.length > Math.floor(rule.body.length / 2)) {
		throw new Error(
			`rewrite is ${parsed.body.length} chars — not within half of the original ${rule.body.length}; nothing gained`,
		);
	}
	const nearDuplicate = listRulesByAgent(db, args.agent).find(
		(other) =>
			trigramSimilarity(parsed.body, other.body) > SIMILARITY_THRESHOLD,
	);
	if (nearDuplicate) {
		throw new Error(
			`rewrite is a near-duplicate of rule ${nearDuplicate.id}; nothing to A/B`,
		);
	}

	const oldRent = rule.context_cost;
	const newRent = contextCost(parsed.body);
	if (args.dryRun) {
		return [
			`Proposed rewrite of rule ${rule.id} (rent ${oldRent} -> ${newRent}):`,
			`  "${parsed.body}"`,
			"Dry run: nothing inserted. Re-run without --dry-run to queue it as a candidate.",
		].join("\n");
	}

	const id = insertRule(db, {
		agent: args.agent,
		body: parsed.body,
		contextCost: newRent,
		sourceRun: rule.source_run,
		createdAt: new Date().toISOString(),
		bornDigest: `compressed variant of rule ${rule.id} (rent ${oldRent} -> ${newRent}): "${rule.body}"`,
		// Swap provenance: the selector measures this candidate against the
		// active set MINUS the original — benching it on top of the semantically
		// identical original would pin its marginal delta at ~0 and guarantee
		// eviction (the A/B would be unwinnable by construction).
		replaces: rule.id,
	});
	return [
		`Queued candidate ${id}: compressed variant of rule ${rule.id} (rent ${oldRent} -> ${newRent}).`,
		`  "${parsed.body}"`,
		`Run /warden-select ${args.agent} to measure it: the variant is benched as a SWAP`,
		`(active set with it instead of rule ${rule.id}) and must clear 2x its own rent.`,
		`If it survives, the redundant original will fail its next re-audits and exit via`,
		`the normal two-strike path — this command never removes a measured rule itself.`,
	].join("\n");
}

export function main(argv: string[]): number {
	const args = parseCompressArgs(argv);
	const db = openDb();
	try {
		console.log(runCompress(db, args));
		return 0;
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
