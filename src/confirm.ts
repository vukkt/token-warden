/**
 * Out-of-fixture confirmation: does fixture survival predict production savings?
 *
 * CLI: npx tsx src/confirm.ts [--agent <name>] [--min-n N] [--json] [--gate]
 *
 * The fixture benchmark admits a rule when it confidently saves tokens on the
 * frozen golden suite; the cohort module independently measures whether the
 * agent's REAL work got cheaper across ruleset versions. This command joins
 * the two: per agent, the fixture side (the latest receipt of each active
 * rule — expected savings per run) against the production side (the cohort
 * verdict). Zero tokens, read-only; the fixture stays the only authority that
 * removes a rule, so a contradiction recommends a re-audit, never auto-evicts.
 */
import { pathToFileURL } from "node:url";
import {
	assessAgentCohorts,
	type CohortAssessment,
	cohortGovernance,
} from "./cohort.js";
import {
	getActiveRules,
	latestReceipts,
	openDb,
	type ReceiptRow,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

const DEFAULT_MIN_N = 5;

export type ConfirmVerdict =
	| "corroborated"
	| "contradicted"
	| "unconfirmed"
	| "nothing-to-confirm";

export interface FixtureSide {
	/** Active rules with a receipt, best delta first. */
	activeRules: number;
	/** Sum of the positive measured deltas of active rules (tokens/run the
	 * fixture says the current memory earns). */
	expectedSavingsPerRun: number;
	/** Rule ids whose latest receipt shows a regression flag. */
	regressedRules: number[];
}

export interface Confirmation {
	agent: string;
	verdict: ConfirmVerdict;
	reason: string;
	fixture: FixtureSide;
	cohort: CohortAssessment;
}

/** Reduce an agent's receipts to the fixture-side expectation. Only active
 * rules count — an evicted rule no longer predicts anything about memory. */
export function fixtureSide(
	receipts: ReceiptRow[],
	activeRuleIds: ReadonlySet<number>,
): FixtureSide {
	const active = receipts.filter((r) => activeRuleIds.has(r.rule_id));
	return {
		activeRules: activeRuleIds.size,
		expectedSavingsPerRun: active.reduce(
			(sum, r) => sum + Math.max(0, r.delta ?? 0),
			0,
		),
		regressedRules: active
			.filter((r) => r.regression === 1)
			.map((r) => r.rule_id),
	};
}

/**
 * The confirmation matrix. Fixture predicts savings when at least one active
 * rule carries a positive measured delta; the production cohort then either
 * corroborates (improved), contradicts (regressed), or has not yet spoken
 * (no-change / insufficient-data).
 */
export function confirmAgent(
	agent: string,
	fixture: FixtureSide,
	cohort: CohortAssessment,
): Confirmation {
	if (fixture.activeRules === 0) {
		return {
			agent,
			verdict: "nothing-to-confirm",
			reason: "no active rules — the fixture predicts nothing yet",
			fixture,
			cohort,
		};
	}
	if (fixture.expectedSavingsPerRun <= 0) {
		return {
			agent,
			verdict: "nothing-to-confirm",
			reason:
				"active rules exist but none carries a positive measured delta (protected/behavioral rules predict no token savings)",
			fixture,
			cohort,
		};
	}
	switch (cohort.verdict) {
		case "improved":
			return {
				agent,
				verdict: "corroborated",
				reason: `fixture expects ~${Math.round(fixture.expectedSavingsPerRun)} tok/run and production sessions got confidently cheaper (${cohort.reason})`,
				fixture,
				cohort,
			};
		case "regressed":
			return {
				agent,
				verdict: "contradicted",
				reason: `fixture expects ~${Math.round(fixture.expectedSavingsPerRun)} tok/run but production sessions got confidently MORE expensive (${cohort.reason}) — re-audit on the fixture (/warden-select); observational, never auto-evicts`,
				fixture,
				cohort,
			};
		default:
			return {
				agent,
				verdict: "unconfirmed",
				reason: `fixture expects ~${Math.round(fixture.expectedSavingsPerRun)} tok/run; production has not confirmed or denied it yet (${cohort.reason})`,
				fixture,
				cohort,
			};
	}
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

export function renderConfirmation(c: Confirmation): string {
	const lines = [`out-of-fixture confirmation — ${c.agent}`];
	lines.push(
		`  fixture: ${c.fixture.activeRules} active rule(s), expected savings ~${fmt(c.fixture.expectedSavingsPerRun)} tok/run` +
			(c.fixture.regressedRules.length > 0
				? `  [receipt regression flags: ${c.fixture.regressedRules.join(", ")}]`
				: ""),
	);
	lines.push(
		`  production: ${c.cohort.verdict.toUpperCase()}` +
			(c.cohort.delta !== null
				? ` (${c.cohort.delta >= 0 ? "-" : "+"}${fmt(Math.abs(c.cohort.delta))} tok/session vs baseline)`
				: ""),
	);
	lines.push(`  verdict: ${c.verdict.toUpperCase()} — ${c.reason}`);
	return lines.join("\n");
}

interface ConfirmArgs {
	agent: string | null;
	minN: number;
	json: boolean;
	gate: boolean;
}

export function parseConfirmArgs(argv: string[]): ConfirmArgs {
	const args: ConfirmArgs = {
		agent: null,
		minN: DEFAULT_MIN_N,
		json: false,
		gate: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") {
			const agent = argv[++i] ?? "";
			if (!(DOMAIN_AGENTS as readonly string[]).includes(agent)) {
				throw new Error(
					`--agent must be one of: ${DOMAIN_AGENTS.join(", ")} (got "${agent}")`,
				);
			}
			args.agent = agent;
		} else if (flag === "--min-n") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n < 2) {
				throw new Error("--min-n must be an integer >= 2");
			}
			args.minN = n;
		} else if (flag === "--json") args.json = true;
		else if (flag === "--gate") args.gate = true;
		else throw new Error(`unknown flag: ${flag}`);
	}
	return args;
}

export function main(argv: string[]): number {
	const args = parseConfirmArgs(argv);
	const agents = args.agent ? [args.agent] : [...DOMAIN_AGENTS];
	const db = openDb();
	try {
		const results = agents.map((agent) => {
			const activeIds = new Set(getActiveRules(db, agent).map((r) => r.id));
			const fixture = fixtureSide(latestReceipts(db, agent), activeIds);
			const cohort = assessAgentCohorts(db, agent, args.minN).assessment;
			return confirmAgent(agent, fixture, cohort);
		});
		if (args.json) {
			console.log(JSON.stringify(results, null, 2));
		} else {
			console.log(results.map(renderConfirmation).join("\n\n"));
			const contradicted = results.filter((r) => r.verdict === "contradicted");
			if (contradicted.length > 0) {
				console.log(
					`\nGovernance: ${contradicted
						.map(
							(r) =>
								`${r.agent}: ${cohortGovernance(r.cohort).action.toUpperCase()}`,
						)
						.join("; ")}`,
				);
			}
		}
		// --gate: non-zero exit only on a genuine contradiction (fixture predicts
		// savings, production confidently regressed) — the CI hook for the
		// out-of-fixture falsification experiment.
		return args.gate && results.some((r) => r.verdict === "contradicted")
			? 1
			: 0;
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
