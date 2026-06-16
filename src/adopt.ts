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
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { insertRule, listRulesByAgent, openDb, type RuleRow } from "./db.js";
import { contextCost, trigramSimilarity } from "./distill.js";
import type { SharedRule } from "./share.js";
import { DOMAIN_AGENTS } from "./types.js";

/** Matches src/distill.ts's dedupe threshold so adoption and distillation
 * treat "the same rule" identically. */
const ADOPT_SIMILARITY = 0.85;

const ledgerSchema = z.object({
	agent: z.string(),
	exportedAt: z.string(),
	rules: z.array(
		z.object({
			body: z
				.string()
				.trim()
				.min(10)
				.max(200)
				// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
				.regex(/^[^\x00-\x1f\x7f]+$/),
			measuredDelta: z.number().nullable().catch(null),
			contextCost: z.number().catch(0),
			sourceRun: z.number().nullable().catch(null),
			createdAt: z.string().catch(""),
		}),
	),
});

export type ParsedLedger = z.infer<typeof ledgerSchema>;

/** Extract and validate the machine-readable ledger block from a shared
 * file. Returns null on a missing/invalid block — never throws. */
export function parseLedgerFile(content: string): ParsedLedger | null {
	const match = content.match(/```json\s*\n([\s\S]*?)\n```/);
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

function main(args: AdoptArgs): void {
	if (!existsSync(args.from)) {
		throw new Error(`ledger file not found: ${args.from}`);
	}
	const ledger = parseLedgerFile(readFileSync(args.from, "utf8"));
	if (ledger === null) {
		throw new Error(`no valid token-warden ledger block found in ${args.from}`);
	}
	if (!(DOMAIN_AGENTS as readonly string[]).includes(ledger.agent)) {
		throw new Error(
			`ledger names agent "${ledger.agent}", not one of: ${DOMAIN_AGENTS.join(", ")}`,
		);
	}

	const db = openDb();
	try {
		const existing = listRulesByAgent(db, ledger.agent);
		const { adopt, skipped } = planImport(existing, ledger.rules);
		const now = new Date().toISOString();
		for (const rule of adopt) {
			// Recompute rent locally; discard the foreign delta — the selector
			// re-measures from scratch on this machine's golden suite.
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
