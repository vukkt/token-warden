/**
 * Rule-ledger import — team-shared rule ledgers, increment 2.
 *
 * CLI: npx tsx src/adopt.ts --from <path>
 *
 * Reads a shared ledger (written by src/share.ts) and queues its rules as
 * CANDIDATES in the local ledger. It NEVER trusts the foreign measured delta
 * or context cost: the claimed delta is discarded, the rent is recomputed
 * locally, and by invariant #1 a candidate is not injected into agent memory
 * until the local selector re-measures it on THIS machine's golden suite. So
 * an adopted rule must earn its place here exactly like a locally-distilled
 * one — "measured, not claimed" holds across machines. Near-duplicates of any
 * existing rule (trigram > 0.85, including evicted ones) are skipped, so a
 * rule already falsified locally cannot be re-adopted.
 *
 * THREAT MODEL: the file is authored on someone else's machine and is treated
 * as fully hostile. Everything it carries is either discarded (deltas, rent,
 * source run) or validated at the boundary BEFORE use — size, rule count,
 * agent-name slug, and a rule body that must be one line of visible text. What
 * this file cannot check is the *meaning* of a rule body: a shared rule is by
 * construction an instruction that will be put in front of a model, so a
 * malicious ledger is a prompt-injection vector no schema can close. The
 * mitigations are that a body is short, single-line, free of invisible or
 * bidi-reordering characters (so PR review sees exactly what is imported), and
 * that it lands as a CANDIDATE that must survive local measurement first.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { insertRule, listRulesByAgent, openDb, type RuleRow } from "./db.js";
import { contextCost, trigramSimilarity } from "./distill.js";
import { isValidAgentName, knownAgents } from "./registry.js";
import { LEDGER_MARKER, type SharedRule } from "./share.js";

/** Matches src/distill.ts's dedupe threshold so adoption and distillation
 * treat "the same rule" identically. */
const ADOPT_SIMILARITY = 0.85;

/** Hard cap on a ledger file. A real ledger is a handful of one-line rules
 * (kilobytes); anything larger is a mistake or a resource-exhaustion attempt,
 * and the file is read whole into memory before it is validated. */
export const MAX_LEDGER_BYTES = 1024 * 1024;

/** Hard cap on rules per ledger. Deduplication is O(incoming x existing)
 * trigram comparisons and every survivor becomes a DB row, so an unbounded
 * array is both a CPU and a storage amplifier. An agent's active set is
 * single digits in practice; 500 is far above any honest export. */
export const MAX_LEDGER_RULES = 500;

/**
 * Characters an imported rule body may never contain. The old check rejected
 * only C0 controls and DEL, which let through a second class of text that is
 * invisible or reorders what a reviewer sees:
 *
 * - C1 controls (U+0080-U+009F), which include the 8-bit CSI U+009B that some
 *   terminals honour exactly like `ESC [`;
 * - bidi overrides/isolates and the Arabic letter mark, which can make the
 *   rendered rule read differently from the bytes that reach the model;
 * - zero-width, soft-hyphen, invisible-operator and BOM code points, which
 *   hide text inside a body that looks innocuous in review;
 * - LINE/PARAGRAPH SEPARATOR, which break the one-rule-per-line contract of
 *   the compiled MEMORY.md;
 * - Unicode tag characters (U+E0000-U+E007F), the classic channel for
 *   smuggling an entirely invisible instruction into a reviewed string.
 *
 * The ledger's whole premise is that a human reviews the file in a PR diff, so
 * "what is rendered is what is imported" is a security property, not polish.
 */
const UNSAFE_BODY_CHARS =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control and invisible characters is the point
	/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u;

const ledgerSchema = z.object({
	// The agent name is a path component and a subprocess argument everywhere
	// downstream, so it is slug-validated at the boundary — before it can be
	// interpolated into an error message or matched against knownAgents().
	agent: z.string().refine(isValidAgentName),
	exportedAt: z.string().max(64).catch(""),
	rules: z
		.array(
			z.object({
				body: z
					.string()
					.trim()
					.min(10)
					.max(200)
					.refine((body) => !UNSAFE_BODY_CHARS.test(body)),
				measuredDelta: z.number().nullable().catch(null),
				contextCost: z.number().catch(0),
				sourceRun: z.number().nullable().catch(null),
				createdAt: z.string().max(64).catch(""),
			}),
		)
		.max(MAX_LEDGER_RULES),
});

export type ParsedLedger = z.infer<typeof ledgerSchema>;

/** Extract and validate the machine-readable ledger block from a shared
 * file. Returns null on a missing/invalid block — never throws. Oversized
 * content is rejected before the regex scan and the JSON parse, so neither
 * runs over attacker-chosen megabytes. */
export function parseLedgerFile(content: string): ParsedLedger | null {
	if (content.length > MAX_LEDGER_BYTES) return null;
	// Scan from the marker when there is one: a rule body may legitimately end
	// in "```json", and matching the FIRST fence in the file would then latch
	// onto a bullet line in the prose and mis-slice the real block. Files
	// without a marker keep the old first-fence behaviour.
	const markerIndex = content.indexOf(LEDGER_MARKER);
	const scope = markerIndex >= 0 ? content.slice(markerIndex) : content;
	const match = scope.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!match?.[1]) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(match[1]);
	} catch {
		return null;
	}
	const result = ledgerSchema.safeParse(raw);
	return result.success ? result.data : null;
}

export interface ImportPlan {
	adopt: SharedRule[];
	skipped: { body: string; reason: string }[];
}

/**
 * Decide which incoming rules to adopt as candidates: skip any that are a
 * near-duplicate of an existing rule for the agent (active, candidate, OR
 * evicted) or of one already chosen in this batch. Pure — no DB, no I/O.
 */
export function planImport(
	existing: RuleRow[],
	incoming: SharedRule[],
): ImportPlan {
	const adopt: SharedRule[] = [];
	const skipped: { body: string; reason: string }[] = [];
	for (const rule of incoming) {
		const dupExisting = existing.find(
			(e) => trigramSimilarity(rule.body, e.body) > ADOPT_SIMILARITY,
		);
		if (dupExisting) {
			skipped.push({
				body: rule.body,
				reason: `near-duplicate of existing rule #${dupExisting.id} (${dupExisting.status})`,
			});
			continue;
		}
		const dupBatch = adopt.find(
			(a) => trigramSimilarity(rule.body, a.body) > ADOPT_SIMILARITY,
		);
		if (dupBatch) {
			skipped.push({ body: rule.body, reason: "duplicate within the import" });
			continue;
		}
		adopt.push(rule);
	}
	return { adopt, skipped };
}

interface AdoptArgs {
	from: string;
}

export function parseAdoptArgs(argv: string[]): AdoptArgs {
	const args: AdoptArgs = { from: "" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--from") {
			args.from = argv[i + 1] ?? "";
			i++;
		} else {
			throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	if (args.from.trim() === "") {
		throw new Error("--from <path to a .rules.md ledger> is required");
	}
	return args;
}

/** Read a ledger file, refusing anything that is not a regular file of sane
 * size. Guards against `--from /dev/zero` (a character device reads forever)
 * and against loading an arbitrarily large file into memory before any
 * validation can run. */
function readLedgerFile(path: string): string {
	if (!existsSync(path)) {
		throw new Error(`ledger file not found: ${path}`);
	}
	const stat = statSync(path);
	if (!stat.isFile()) {
		throw new Error(`not a regular file: ${path}`);
	}
	if (stat.size > MAX_LEDGER_BYTES) {
		throw new Error(
			`ledger file too large: ${stat.size} bytes (max ${MAX_LEDGER_BYTES})`,
		);
	}
	return readFileSync(path, "utf8");
}

export function main(args: AdoptArgs): void {
	const ledger = parseLedgerFile(readLedgerFile(args.from));
	if (ledger === null) {
		throw new Error(`no valid token-warden ledger block found in ${args.from}`);
	}
	const agents = knownAgents();
	if (!agents.includes(ledger.agent)) {
		throw new Error(
			`ledger names agent "${ledger.agent}", not one of: ${agents.join(", ")}`,
		);
	}

	const db = openDb();
	try {
		const existing = listRulesByAgent(db, ledger.agent);
		const { adopt, skipped } = planImport(existing, ledger.rules);
		const now = new Date().toISOString();
		for (const rule of adopt) {
			// Recompute rent locally; discard the foreign delta — the selector
			// re-measures from scratch on this machine's golden suite. insertRule
			// is the ONLY write this file makes and it hardcodes status
			// 'candidate' with a null measured_delta, so there is no code path
			// from an imported ledger to an active rule (and hence to a compiled
			// MEMORY.md) that does not go through local measurement. Asserted in
			// test/adopt.test.ts, "cannot bypass local measurement".
			insertRule(db, {
				agent: ledger.agent,
				body: rule.body,
				contextCost: contextCost(rule.body),
				sourceRun: null,
				createdAt: now,
			});
		}
		console.log(
			`Adopted ${adopt.length} rule(s) from ${ledger.agent} as candidates;` +
				` skipped ${skipped.length} duplicate(s).`,
		);
		for (const s of skipped) {
			console.log(`  skip: ${s.reason}`);
		}
		if (adopt.length > 0) {
			console.log(
				"These are UNVERIFIED here — run the selector to re-measure them on" +
					" your own golden suite before they enter memory.",
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
		main(parseAdoptArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
