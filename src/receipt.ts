/**
 * Rule receipts — the per-rule verdict card.
 *
 * CLI: npx tsx src/receipt.ts [--agent <name>] [--json]
 *
 * A receipt is the evidence behind a keep/evict decision, consolidated into one
 * portable card: the token economics (savings vs. context rent, with variance),
 * the *quality* axis (per-task pass/fail and the tool-call / file-reread profile
 * with vs. without the rule — so a rule that looked cheap because it skipped
 * necessary work is visible), and the provenance to trust it elsewhere (the
 * model it was measured under and a hash of the golden suite).
 *
 * Read-only. The verdict itself is made by the selector; this only renders the
 * snapshot the selector recorded. Receipts are the natural payload for sharing a
 * rule — "my delta is evidence, not authority for your repo."
 */
import { pathToFileURL } from "node:url";
import {
	agentTokenMix,
	latestReceipts,
	openDb,
	type ReceiptRow,
	type WardenDb,
} from "./db.js";
import { blendedDollarsPerToken, priceFor } from "./pricing.js";
import { displayText } from "./sanitize.js";
import { DOMAIN_AGENTS } from "./types.js";

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

/** Savings as a multiple of context rent (the rule must clear 2×). */
function roi(delta: number | null, contextCost: number): string {
	if (delta === null || contextCost <= 0) return "n/a";
	return `${(delta / contextCost).toFixed(1)}×`;
}

/**
 * Percent change of an activity counter with vs. without the rule, e.g.
 * " (-57%)". Surfaced for transparency, NOT as a verdict: a big drop in tool
 * calls or file re-reads is often the legitimate point of an efficiency rule,
 * so the receipt shows the number and lets a human judge — the binding safety
 * gate is the per-task pass/fail regression, which evicts on its own.
 */
function pctDelta(withV: number, withoutV: number): string {
	if (withoutV === 0) return "";
	const change = Math.round(((withV - withoutV) / withoutV) * 100);
	return ` (${change > 0 ? "+" : ""}${change}%)`;
}

/** Render one receipt as a multi-line card. `dollarsPerToken` (the agent's
 * blended real-work rate at the receipt's model) adds an advisory dollar
 * translation of the saved tokens — reporting only, never a verdict input. */
export function renderReceipt(
	r: ReceiptRow,
	dollarsPerToken: number | null = null,
): string {
	const saved = r.delta === null ? "n/a" : `${fmt(r.delta)} tok`;
	const dollars =
		r.delta !== null && dollarsPerToken !== null
			? ` (≈$${(r.delta * dollarsPerToken).toFixed(4)}/run advisory)`
			: "";
	const se = r.standard_error === null ? "" : ` ±${fmt(r.standard_error)}`;
	const model = r.model ? ` · model=${displayText(r.model, 40)}` : "";
	const fixture = r.fixture_hash
		? ` · suite=${displayText(r.fixture_hash, 16)}`
		: "";
	return [
		`  rule #${r.rule_id} [${r.status}]  "${displayText(r.body)}"`,
		`    ROI: saved ${saved}${se}${dollars} vs rent ${fmt(r.context_cost)} (${roi(r.delta, r.context_cost)})` +
			` · measured over ${r.runs} run(s)${model}${fixture}`,
		`    quality: tasks passed ${r.tasks_passed_without}/${r.tasks_total} → ${r.tasks_passed_with}/${r.tasks_total}` +
			`${r.regression ? "  REGRESSION" : ""}`,
		`    activity: tool calls ${fmt(r.without_tool_calls)} → ${fmt(r.with_tool_calls)}${pctDelta(r.with_tool_calls, r.without_tool_calls)}` +
			` · file re-reads ${fmt(r.without_file_rereads)} → ${fmt(r.with_file_rereads)}${pctDelta(r.with_file_rereads, r.without_file_rereads)}`,
		`    decided ${displayText(r.decided_at, 30)} (${displayText(r.kind, 16)}) — ${displayText(r.reason ?? "no reason recorded")}`,
		...(r.born_digest
			? [`    born of: ${displayText(r.born_digest, 160)}`]
			: []),
	].join("\n");
}

/** Render all of an agent's rule receipts, best savings first. */
export function renderReceipts(db: WardenDb, agent: string): string {
	const rows = latestReceipts(db, agent);
	const lines = [`token-warden — rule receipts for ${agent}`, ""];
	if (rows.length === 0) {
		lines.push("  no receipts yet (run /warden-select to measure rules)");
		return lines.join("\n");
	}
	// Advisory dollar rate per receipt: the agent's real-work token mix priced
	// at the model each rule was measured under.
	const mix = agentTokenMix(db, agent);
	lines.push(
		rows
			.map((r) =>
				renderReceipt(
					r,
					blendedDollarsPerToken(mix, priceFor(r.model ?? undefined)),
				),
			)
			.join("\n\n"),
	);
	return lines.join("\n");
}

export interface ReceiptArgs {
	agent: string | null;
	json: boolean;
}

export function parseReceiptArgs(argv: string[]): ReceiptArgs {
	const args: ReceiptArgs = { agent: null, json: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") {
			const value = argv[++i];
			if (!value || !(DOMAIN_AGENTS as readonly string[]).includes(value)) {
				throw new Error(`--agent must be one of: ${DOMAIN_AGENTS.join(", ")}`);
			}
			args.agent = value;
		} else if (flag === "--json") {
			args.json = true;
		} else {
			throw new Error(`unknown flag: ${flag}`);
		}
	}
	return args;
}

export function main(argv: string[]): number {
	const args = parseReceiptArgs(argv);
	const agents = args.agent ? [args.agent] : [...DOMAIN_AGENTS];
	const db = openDb();
	try {
		if (args.json) {
			const out: Record<string, ReceiptRow[]> = {};
			for (const agent of agents) out[agent] = latestReceipts(db, agent);
			console.log(JSON.stringify(out, null, 2));
			return 0;
		}
		console.log(agents.map((agent) => renderReceipts(db, agent)).join("\n\n"));
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
