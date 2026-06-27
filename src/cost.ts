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
	realWorkTotalsByVersion,
	type WardenDb,
} from "./db.js";
import { blendedDollarsPerToken, type Price, priceFor } from "./pricing.js";
import { DOMAIN_AGENTS } from "./types.js";

/** Average weeks per calendar month, for --months → weeks. */
const WEEKS_PER_MONTH = 4.345;

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

/**
 * A horizon projection for one agent: what its active rules save (and cost to
 * operate) over a stretch of time, and the with-vs-without-plugin comparison.
 */
export interface Projection {
	agent: string;
	weeks: number;
	sessionsPerWeek: number;
	horizonSessions: number;
	rules: number;
	/** Sum of per-rule net (savings − rent) per session, in dollars. */
	netPerSession: number;
	/** Gross savings over the horizon (before the one-time discovery cost). */
	grossSavings: number;
	/** One-time benchmark spend that found the active rules (operating cost). */
	operatingCost: number;
	/** grossSavings − rent − operatingCost over the horizon. */
	netBenefit: number;
	breakEvenSessions: number | null;
	/** Cost of the same work WITHOUT the plugin — null when no real-work runs
	 * exist to estimate a per-session baseline. */
	baselineCost: number | null;
	withPluginCost: number | null;
	pctSaved: number | null;
}

export function projectAgent(
	db: WardenDb,
	agent: string,
	weeks: number,
	sessionsPerWeek: number,
): Projection {
	const costs = agentCosts(db, agent);
	const horizonSessions = Math.round(weeks * sessionsPerWeek);
	const savingsPerSession = costs.reduce((a, c) => a + c.savingsDollars, 0);
	const netPerSession = costs.reduce((a, c) => a + c.netDollars, 0);
	const operatingCost = costs.reduce((a, c) => a + c.discoveryDollars, 0);
	const grossSavings = savingsPerSession * horizonSessions;
	const netBenefit = netPerSession * horizonSessions - operatingCost;

	// Baseline: mean real-work session tokens × the agent's blended $/token.
	const price = priceFor(costs[0]?.model ?? null);
	const blended = blendedDollarsPerToken(agentTokenMix(db, agent), price);
	const realTotals = realWorkTotalsByVersion(db, agent).map((t) => t.total);
	const meanTokens =
		realTotals.length > 0
			? realTotals.reduce((a, b) => a + b, 0) / realTotals.length
			: null;
	const baselineCost =
		meanTokens !== null ? meanTokens * blended * horizonSessions : null;
	const withPluginCost =
		baselineCost !== null
			? baselineCost - netPerSession * horizonSessions + operatingCost
			: null;
	const pctSaved =
		baselineCost !== null && baselineCost > 0
			? netBenefit / baselineCost
			: null;

	return {
		agent,
		weeks,
		sessionsPerWeek,
		horizonSessions,
		rules: costs.length,
		netPerSession,
		grossSavings,
		operatingCost,
		netBenefit,
		breakEvenSessions:
			netPerSession > 0 && operatingCost > 0
				? Math.ceil(operatingCost / netPerSession)
				: null,
		baselineCost,
		withPluginCost,
		pctSaved,
	};
}

export function renderProjection(p: Projection): string {
	const months = (p.weeks / WEEKS_PER_MONTH).toFixed(1);
	const head = `${p.agent}: projection over ${p.weeks} weeks (~${months} months) at ${p.sessionsPerWeek} sessions/week = ${p.horizonSessions} sessions`;
	if (p.rules === 0) return `${head}\n  no active rules to project.`;
	const lines = [
		head,
		`  active rules: ${p.rules}`,
		`  gross savings: ${usd(p.grossSavings)}`,
		`  operating (discovery) cost: ${usd(p.operatingCost)}`,
		`  NET benefit: ${usd(p.netBenefit)}`,
	];
	if (p.breakEvenSessions !== null) {
		lines.push(`  breaks even after ${p.breakEvenSessions} sessions`);
	}
	if (p.baselineCost !== null && p.withPluginCost !== null) {
		const pct = p.pctSaved !== null ? `${(p.pctSaved * 100).toFixed(1)}%` : "—";
		lines.push(
			`  cost WITHOUT plugin: ${usd(p.baselineCost)}`,
			`  cost WITH plugin:    ${usd(p.withPluginCost)}  (${pct} cheaper)`,
		);
	}
	return lines.join("\n");
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
	project: boolean;
	weeks: number;
	sessionsPerWeek: number;
}

export function parseCostArgs(argv: string[]): CostArgs {
	const spwDefault = sessionsPerWeek();
	const args: CostArgs = {
		agent: null,
		json: false,
		project: false,
		weeks: 13, // ~3 months
		sessionsPerWeek: spwDefault,
	};
	const posInt = (raw: string | undefined, label: string): number => {
		const n = Number(raw);
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error(`${label} must be a positive number`);
		}
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") args.agent = argv[++i] ?? null;
		else if (flag === "--json") args.json = true;
		else if (flag === "--project") args.project = true;
		else if (flag === "--weeks") {
			args.weeks = posInt(argv[++i], "--weeks");
			args.project = true;
		} else if (flag === "--months") {
			args.weeks = Math.round(posInt(argv[++i], "--months") * WEEKS_PER_MONTH);
			args.project = true;
		} else if (flag === "--sessions-per-week") {
			args.sessionsPerWeek = posInt(argv[++i], "--sessions-per-week");
			args.project = true;
		} else throw new Error(`unknown flag: ${flag}`);
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
		if (args.project) {
			const projections = agents.map((agent) =>
				projectAgent(db, agent, args.weeks, args.sessionsPerWeek),
			);
			console.log(
				args.json
					? JSON.stringify(projections, null, 2)
					: projections.map(renderProjection).join("\n\n"),
			);
			return 0;
		}
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
