/**
 * Rule-ledger export — team-shared rule ledgers, increment 1.
 *
 * CLI: npx tsx src/share.ts --agent <name> [--out <path>]
 *
 * Writes an agent's ACTIVE rules — body, measured delta, context rent, and
 * provenance — to a committed, reviewable artifact (default
 * `.warden/<agent>.rules.md` in the current directory) so a team can version
 * and review measured agent memory like code. Read-only on the ledger; it
 * touches no other feature, so it cannot break the collect/distill/select
 * loop. Importing and RE-verifying a shared ledger against the importer's own
 * golden suite (never trusting a foreign delta) is a later increment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getActiveRules, openDb, type RuleRow } from "./db.js";
import { assertKnownAgent } from "./registry.js";

export interface SharedRule {
	body: string;
	measuredDelta: number | null;
	contextCost: number;
	sourceRun: number | null;
	createdAt: string;
}

export interface SharedLedger {
	agent: string;
	exportedAt: string;
	rules: SharedRule[];
}

/** Marker line preceding the machine-readable block (an importer keys on it). */
export const LEDGER_MARKER =
	"<!-- token-warden:ledger — machine-readable; do not hand-edit the block below -->";

export function toSharedLedger(
	agent: string,
	rules: RuleRow[],
	exportedAt: string,
): SharedLedger {
	return {
		agent,
		exportedAt,
		rules: rules.map((r) => ({
			body: r.body,
			measuredDelta: r.measured_delta,
			contextCost: r.context_cost,
			sourceRun: r.source_run,
			createdAt: r.created_at,
		})),
	};
}

/**
 * Render the shareable artifact: a human-reviewable header and bullet list,
 * then a machine-readable JSON block so a later import can re-verify each
 * delta. Both representations describe the same rules, so a PR diff is
 * readable AND parseable.
 */
export function formatLedger(ledger: SharedLedger): string {
	const lines: string[] = [];
	lines.push(`# token-warden rules — ${ledger.agent}`);
	lines.push("");
	lines.push(
		`${ledger.rules.length} active rule(s), each kept because it measurably earned ` +
			`at least 2× its context rent on the golden suite. Exported ${ledger.exportedAt}.`,
	);
	lines.push("");
	if (ledger.rules.length === 0) {
		lines.push("_No active rules yet._");
	}
	for (const r of ledger.rules) {
		const delta = r.measuredDelta === null ? "n/a" : `+${r.measuredDelta}`;
		lines.push(`- **${delta} tokens/run** (rent ${r.contextCost}): ${r.body}`);
	}
	lines.push("");
	lines.push(LEDGER_MARKER);
	lines.push("```json");
	lines.push(JSON.stringify(ledger, null, 2));
	lines.push("```");
	lines.push("");
	return lines.join("\n");
}

interface ShareArgs {
	agent: string;
	out: string | null;
}

export function parseShareArgs(argv: string[]): ShareArgs {
	const args: ShareArgs = { agent: "", out: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--agent") {
			args.agent = argv[i + 1] ?? "";
			i++;
		} else if (argv[i] === "--out") {
			args.out = argv[i + 1] ?? null;
			i++;
		} else {
			throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	assertKnownAgent(args.agent);
	return args;
}

export function main(args: ShareArgs): void {
	const db = openDb();
	try {
		const rules = getActiveRules(db, args.agent);
		const ledger = toSharedLedger(args.agent, rules, new Date().toISOString());
		const outPath =
			args.out ?? join(process.cwd(), ".warden", `${args.agent}.rules.md`);
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, formatLedger(ledger));
		console.log(
			`Wrote ${rules.length} active ${args.agent} rule(s) → ${outPath}`,
		);
		if (rules.length === 0) {
			console.log(
				"(no active rules yet — run the selector to measure candidates first)",
			);
		} else {
			console.log("Commit it to share measured memory with your team.");
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
		main(parseShareArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
