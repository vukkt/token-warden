/**
 * Dollar accounting: what does each active rule actually save, in money?
 *
 * CLI: npx tsx src/cost.ts [--agent <name>] [--json]
 *
 * The keep/evict verdict is measured in tokens (a stable, model-independent
 * unit). This translates that into dollars using a price table and the agent's
 * own token-type mix, so the value is legible and defensible — the answer to
 * "your tool just counts tokens". Read-only; spends no tokens.
 *
 * Honest accounting notes, applied here:
 * - Savings are priced at the agent's *blended* $/token (its real input / output
 *   / cache-write / cache-read mix), not at the headline output rate. Most saved
 *   tokens are cheap input/cache-read, so this is the truthful magnitude.
 * - Rent (the rule's text carried every session) is priced at the input rate.
 * - Discovery cost (the one-time benchmark spend to find the rule) is estimated
 *   from the rule's receipt and amortized into a break-even.
 */
import { pathToFileURL } from "node:url";
import {
	agentTokenMix,
	getActiveRules,
	latestReceipts,
	openDb,
	type ReceiptRow,
	type WardenDb,
} from "./db.js";
import { blendedDollarsPerToken, type Price, priceFor } from "./pricing.js";
import { DOMAIN_AGENTS } from "./types.js";

function sessionsPerWeek(): number {
	const raw = Number(process.env.WARDEN_SESSIONS_PER_WEEK ?? 20);
	return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

export interface RuleCost {
	ruleId: number;
	body: string;
	model: string | null;
	rentTokens: number;
	deltaTokens: number;
	rentDollars: number;
	savingsDollars: number;
	netDollars: number;
	weeklyDollars: number;
	discoveryDollars: number;
	breakEvenSessions: number | null;
}

/** Translate one rule's token receipt into per-session and weekly dollar terms. */
export function computeRuleCost(
	receipt: ReceiptRow,
	price: Price,
	blendedPerToken: number,
	spw: number,
): RuleCost {
	const delta = Math.max(0, receipt.delta ?? 0);
	const inputPerToken = price.input / 1_000_000;
	const rentDollars = receipt.context_cost * inputPerToken;
	const savingsDollars = delta * blendedPerToken;
	const netDollars = savingsDollars - rentDollars;
	// One full benchmark of this rule measured both sides for `runs` completed
	// runs each; approximate the discovery spend from the receipt's means.
	const discoveryTokens =
		receipt.runs * (receipt.with_tokens + receipt.without_tokens);
	const discoveryDollars = discoveryTokens * blendedPerToken;
	return {
		ruleId: receipt.rule_id,
		body: receipt.body,
		model: receipt.model,
		rentTokens: receipt.context_cost,
		deltaTokens: delta,
		rentDollars,
		savingsDollars,
		netDollars,
		weeklyDollars: netDollars * spw,
		discoveryDollars,
		breakEvenSessions:
			netDollars > 0 ? Math.ceil(discoveryDollars / netDollars) : null,
	};
}

/** Active rules for an agent, priced. Active = currently earning its rent. */
export function agentCosts(db: WardenDb, agent: string): RuleCost[] {
	const activeIds = new Set(getActiveRules(db, agent).map((r) => r.id));
	if (activeIds.size === 0) return [];
	const mix = agentTokenMix(db, agent);
	const spw = sessionsPerWeek();
	const byRule = new Map<number, ReceiptRow>();
	for (const r of latestReceipts(db, agent)) {
		if (activeIds.has(r.rule_id) && !byRule.has(r.rule_id))
			byRule.set(r.rule_id, r);
	}
	const costs: RuleCost[] = [];
	for (const receipt of byRule.values()) {
		const price = priceFor(receipt.model);
		costs.push(
			computeRuleCost(receipt, price, blendedDollarsPerToken(mix, price), spw),
		);
	}
	return costs.sort((a, b) => b.weeklyDollars - a.weeklyDollars);
}

const usd = (n: number): string =>
	n >= 0.01 || n <= -0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(5)}`;

export function renderCosts(agent: string, costs: RuleCost[]): string {
	if (costs.length === 0) {
		return `${agent}: no active rules with receipts to price.`;
	}
	const spw = sessionsPerWeek();
	const weekly = costs.reduce((a, c) => a + c.weeklyDollars, 0);
	const lines = costs.map((c) => {
		const be =
			c.breakEvenSessions === null
				? "never (net ≤ 0)"
				: `${c.breakEvenSessions} sessions`;
		return [
			`  rule ${c.ruleId}: "${c.body}"`,
			`    saves ${usd(c.savingsDollars)}/session, rent ${usd(c.rentDollars)}/session → net ${usd(c.netDollars)}/session`,
			`    discovery cost ${usd(c.discoveryDollars)} → breaks even in ${be}`,
		].join("\n");
	});
	return [
		`${agent}: ${costs.length} active rule(s), priced at ${spw} sessions/week`,
		...lines,
		`  TOTAL net savings: ${usd(weekly)}/week (${usd(weekly * 52)}/year)`,
		"  Note: savings priced at this agent's blended $/token mix (mostly cheap input/cache-read); rent at the input rate.",
	].join("\n");
}

interface CostArgs {
	agent: string | null;
	json: boolean;
}

export function parseCostArgs(argv: string[]): CostArgs {
	const args: CostArgs = { agent: null, json: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") args.agent = argv[++i] ?? null;
		else if (flag === "--json") args.json = true;
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
	const args = parseCostArgs(argv);
	const agents = args.agent ? [args.agent] : [...DOMAIN_AGENTS];
	const db = openDb();
	try {
		const results = agents.map((agent) => ({
			agent,
			costs: agentCosts(db, agent),
		}));
		if (args.json) {
			console.log(JSON.stringify(results, null, 2));
		} else {
			console.log(
				results.map((r) => renderCosts(r.agent, r.costs)).join("\n\n"),
			);
		}
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
