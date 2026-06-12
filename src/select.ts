/**
 * Selector: measure candidates, keep what earns its rent, evict the rest,
 * compile survivors into the agent's persistent memory.
 *
 * CLI: npx tsx src/select.ts --agent <name> [--runs <n>]
 *
 * Per invocation (cost-bounded):
 * - bench the active set once (shared baseline for all candidates)
 * - bench each candidate (oldest first, max 3) on top of the active set
 * - re-audit the least recently decided active rule by benching without it
 * - regenerate ~/.claude/agent-memory/<agent>/MEMORY.md wholesale from the
 *   final active set and bump the agent's ruleset_version
 *
 * Evicted rules are never deleted — they are the negative dataset.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	compileMemoryMd,
	type GoldenTask,
	loadGoldenTasks,
	runSuite,
	summarizeTask,
	type TaskSummary,
} from "./bench.js";
import {
	bumpRulesetVersion,
	decideRule,
	getActiveRules,
	getRulesetVersion,
	listCandidates,
	oldestDecidedActiveRule,
	openDb,
	type RuleRow,
	type WardenDb,
} from "./db.js";
import { DOMAIN_AGENTS } from "./types.js";

export const MAX_CANDIDATES_PER_INVOCATION = 3;

export interface VerdictInput {
	measuredDelta: number | null;
	contextCost: number;
}

/** Keep/evict inequality from the spec: a rule must save at least twice its
 * context rent. SESSIONS_PER_WEEK cancels algebraically but is kept so the
 * policy reads as the spec states it. */
export function verdict(rule: VerdictInput): "active" | "evicted" {
	const sessionsPerWeek = Number(process.env.WARDEN_SESSIONS_PER_WEEK ?? 20);
	if (rule.measuredDelta === null || rule.measuredDelta <= 0) return "evicted";
	const weeklySavings = rule.measuredDelta * sessionsPerWeek;
	const weeklyRent = rule.contextCost * sessionsPerWeek;
	return weeklySavings >= weeklyRent * 2 ? "active" : "evicted";
}

export interface ReasonedVerdict {
	status: "active" | "evicted";
	reason: string;
}

/** Verdict plus the human-readable reason stored on the rule and shown in
 * the /warden-status eviction ledger. */
export function verdictWithReason(
	delta: number | null,
	contextCost: number,
	regression: boolean,
): ReasonedVerdict {
	if (regression) {
		return {
			status: "evicted",
			reason: "regression: a previously passing golden task failed",
		};
	}
	if (delta === null) {
		return { status: "evicted", reason: "no comparable completed runs" };
	}
	if (delta <= 0) {
		return { status: "evicted", reason: `non-positive delta (${delta})` };
	}
	const status = verdict({ measuredDelta: delta, contextCost });
	return status === "active"
		? { status, reason: `savings ${delta} ≥ 2× context rent ${contextCost}` }
		: {
				status,
				reason: `sub-threshold: savings ${delta} < 2× context rent ${contextCost}`,
			};
}

export interface DeltaResult {
	/** Mean tokens saved per golden run (positive = candidate is cheaper);
	 * null when no task completed in both configurations. */
	delta: number | null;
	/** True when a task that completed in the baseline configuration has no
	 * completed run in the candidate configuration → immediate eviction. */
	regression: boolean;
}

/** Per-task savings for tasks completed in both configurations
 * (invariant #3), plus the regression flag. */
function perTaskSavings(
	without: TaskSummary[],
	withRule: TaskSummary[],
): { savings: number[]; regression: boolean } {
	const withById = new Map(withRule.map((s) => [s.taskId, s]));
	const savings: number[] = [];
	let regression = false;
	for (const base of without) {
		const baseCompleted = base.results.some((r) => r.completed);
		if (!baseCompleted) continue;
		const other = withById.get(base.taskId);
		const otherCompleted = other?.results.some((r) => r.completed) ?? false;
		if (!other || !otherCompleted) {
			regression = true;
			continue;
		}
		savings.push(base.meanCompletedTokens - other.meanCompletedTokens);
	}
	return { savings, regression };
}

/** Pair task summaries by id and average the per-task savings. */
export function computeDelta(
	without: TaskSummary[],
	withRule: TaskSummary[],
): DeltaResult {
	const { savings, regression } = perTaskSavings(without, withRule);
	if (savings.length === 0) return { delta: null, regression };
	const delta = Math.round(savings.reduce((a, b) => a + b, 0) / savings.length);
	return { delta, regression };
}

export interface DeltaAssessment extends DeltaResult {
	/** Standard error of the mean per-task savings; null with <2 comparable
	 * tasks. */
	standardError: number | null;
	/** True when the keep/evict verdict could flip within one standard
	 * error — the signal to spend a top-up measurement. */
	uncertain: boolean;
}

/**
 * Variance-aware delta: alongside the point estimate, report whether the
 * verdict is within noise of the 2×rent threshold. LLM run-to-run variance
 * is the dominant error source at small effect sizes.
 */
export function assessDelta(
	without: TaskSummary[],
	withRule: TaskSummary[],
	contextCost: number,
): DeltaAssessment {
	const { savings, regression } = perTaskSavings(without, withRule);
	if (savings.length === 0) {
		return { delta: null, regression, standardError: null, uncertain: false };
	}
	const mean = savings.reduce((a, b) => a + b, 0) / savings.length;
	const delta = Math.round(mean);
	let standardError: number | null = null;
	if (savings.length >= 2) {
		const variance =
			savings.reduce((acc, s) => acc + (s - mean) ** 2, 0) /
			(savings.length - 1);
		standardError = Math.sqrt(variance / savings.length);
	}
	const threshold = 2 * contextCost;
	const uncertain =
		!regression &&
		standardError !== null &&
		Math.abs(mean - threshold) < standardError;
	return { delta, regression, standardError, uncertain };
}

/** Combine two measurement passes of the same configuration: pool the raw
 * results per task and re-summarize. */
export function mergeSummaries(
	first: TaskSummary[],
	second: TaskSummary[],
): TaskSummary[] {
	const secondById = new Map(second.map((s) => [s.taskId, s]));
	return first.map((summary) => {
		const extra = secondById.get(summary.taskId);
		if (!extra) return summary;
		return summarizeTask(summary.taskId, [
			...summary.results,
			...extra.results,
		]);
	});
}

/** Where compiled agent memory lives. Overridable for tests so they never
 * touch the real ~/.claude/agent-memory. */
export function memoryFilePath(agent: string): string {
	const base =
		process.env.TOKEN_WARDEN_MEMORY_DIR ??
		join(homedir(), ".claude", "agent-memory");
	return join(base, agent, "MEMORY.md");
}

/** Runs the golden suite under an explicit rule set; injected so unit tests
 * can fake measurements. The real one wraps bench.runSuite. */
export type SuiteRunner = (
	rules: RuleRow[],
	label: string,
	recordBaselines: boolean,
) => TaskSummary[];

export interface Decision {
	rule: RuleRow;
	kind: "candidate" | "re-audit";
	delta: number | null;
	regression: boolean;
	status: "active" | "evicted";
	/** True when the verdict was within one standard error of flipping
	 * after all measurements (decided at low confidence). */
	uncertain: boolean;
	/** True when an extra measurement pass was spent on this decision. */
	toppedUp: boolean;
}

export interface SelectionReport {
	agent: string;
	decisions: Decision[];
	activeBodies: string[];
	rulesetVersion: number | null;
}

export interface SelectOptions {
	/** Extra measurement passes allowed per decision when the verdict is
	 * within one standard error of flipping. Bounded cost: each top-up is
	 * one more suite invocation of the measured configuration. */
	topUpBudget?: number;
}

export function selectForAgent(
	db: WardenDb,
	agent: string,
	runner: SuiteRunner,
	options: SelectOptions = {},
): SelectionReport {
	const topUpBudget = options.topUpBudget ?? 1;
	const candidates = listCandidates(db, agent, MAX_CANDIDATES_PER_INVOCATION);
	// Captured before any decision so a rule activated this invocation is
	// not immediately re-audited.
	const auditTarget = oldestDecidedActiveRule(db, agent);

	/** Measure `measured` vs `reference`, topping up the measured side when
	 * the verdict is within noise of the threshold. Used for candidates
	 * (reference = baseline) and re-audits (reference = without-rule). */
	function assessWithTopUp(
		reference: () => TaskSummary[],
		measureOnce: (suffix: string) => TaskSummary[],
		contextCost: number,
		invert: boolean,
	): { assessment: DeltaAssessment; toppedUp: boolean } {
		let measured = measureOnce("");
		const assess = () =>
			invert
				? assessDelta(measured, reference(), contextCost)
				: assessDelta(reference(), measured, contextCost);
		let assessment = assess();
		let toppedUp = false;
		if (assessment.uncertain && topUpBudget > 0) {
			measured = mergeSummaries(measured, measureOnce("-topup"));
			assessment = assess();
			toppedUp = true;
		}
		return { assessment, toppedUp };
	}

	const decisions: Decision[] = [];
	if (candidates.length > 0 || auditTarget !== undefined) {
		const activeSet = getActiveRules(db, agent);
		const baseline = runner(activeSet, "active-set", true);

		for (const candidate of candidates) {
			const { assessment, toppedUp } = assessWithTopUp(
				() => baseline,
				(suffix) =>
					runner(
						[...activeSet, candidate],
						`candidate-${candidate.id}${suffix}`,
						false,
					),
				candidate.context_cost,
				false,
			);
			const { delta, regression, uncertain } = assessment;
			const { status, reason } = verdictWithReason(
				delta,
				candidate.context_cost,
				regression,
			);
			const fullReason = annotateConfidence(reason, toppedUp, uncertain);
			decideRule(
				db,
				candidate.id,
				status,
				delta,
				fullReason,
				new Date().toISOString(),
			);
			decisions.push({
				rule: candidate,
				kind: "candidate",
				delta,
				regression,
				status,
				uncertain,
				toppedUp,
			});
		}

		if (auditTarget !== undefined) {
			const withoutIt = activeSet.filter((rule) => rule.id !== auditTarget.id);
			// The rule's current worth: cost without it minus cost with it
			// (baseline includes it). Removing a good rule makes runs dearer,
			// so the measured (toppable) side is the without-configuration.
			const { assessment, toppedUp } = assessWithTopUp(
				() => baseline,
				(suffix) =>
					runner(withoutIt, `audit-${auditTarget.id}${suffix}`, false),
				auditTarget.context_cost,
				true,
			);
			const { delta, regression, uncertain } = assessment;
			const { status, reason } = verdictWithReason(
				delta,
				auditTarget.context_cost,
				regression,
			);
			const fullReason = annotateConfidence(
				`re-audit: ${reason}`,
				toppedUp,
				uncertain,
			);
			decideRule(
				db,
				auditTarget.id,
				status,
				delta,
				fullReason,
				new Date().toISOString(),
			);
			decisions.push({
				rule: auditTarget,
				kind: "re-audit",
				delta,
				regression,
				status,
				uncertain,
				toppedUp,
			});
		}
	}

	let rulesetVersion: number | null = null;
	const finalActive = getActiveRules(db, agent);
	if (decisions.length > 0) {
		const memoryPath = memoryFilePath(agent);
		mkdirSync(join(memoryPath, ".."), { recursive: true });
		writeFileSync(memoryPath, compileMemoryMd(finalActive));
		rulesetVersion = bumpRulesetVersion(db, agent, new Date().toISOString());
	}

	return {
		agent,
		decisions,
		activeBodies: finalActive.map((rule) => rule.body),
		rulesetVersion,
	};
}

interface SelectArgs {
	agent: string;
	runs: number;
	topUp: number;
}

export function parseSelectArgs(argv: string[]): SelectArgs {
	const args: SelectArgs = { agent: "", runs: 2, topUp: 1 };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--agent") {
			args.agent = argv[i + 1] ?? "";
			i++;
		} else if (argv[i] === "--runs") {
			args.runs = Number(argv[i + 1]);
			i++;
		} else if (argv[i] === "--top-up") {
			args.topUp = Number(argv[i + 1]);
			i++;
		} else {
			throw new Error(`unknown flag: ${argv[i]}`);
		}
	}
	if (!(DOMAIN_AGENTS as readonly string[]).includes(args.agent)) {
		throw new Error(
			`--agent must be one of: ${DOMAIN_AGENTS.join(", ")} (got "${args.agent}")`,
		);
	}
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isInteger(args.topUp) || args.topUp < 0) {
		throw new Error("--top-up must be a non-negative integer");
	}
	return args;
}

function annotateConfidence(
	reason: string,
	toppedUp: boolean,
	uncertain: boolean,
): string {
	if (!toppedUp && !uncertain) return reason;
	const notes: string[] = [];
	if (toppedUp) notes.push("after variance top-up");
	if (uncertain) notes.push("low confidence: within one SE of flipping");
	return `${reason} (${notes.join("; ")})`;
}

function main(args: SelectArgs): void {
	const db = openDb();
	try {
		const tasks: GoldenTask[] = loadGoldenTasks(args.agent);
		const runner: SuiteRunner = (rules, label, recordBaselines) =>
			runSuite(db, args.agent, tasks, {
				rules,
				runs: args.runs,
				recordBaselines,
				rulesetVersion: getRulesetVersion(db, args.agent),
				label,
				config: recordBaselines
					? "active"
					: label.startsWith("audit-")
						? "audit"
						: "candidate",
			});

		console.log(
			`Selecting for agent=${args.agent} (runs=${args.runs} per config, top-up budget ${args.topUp})`,
		);
		const report = selectForAgent(db, args.agent, runner, {
			topUpBudget: args.topUp,
		});

		if (report.decisions.length === 0) {
			console.log("No candidates and no active rules to audit; nothing to do.");
			return;
		}
		for (const decision of report.decisions) {
			console.log(
				`  [${decision.kind}] rule ${decision.rule.id} → ${decision.status.toUpperCase()}` +
					` (delta=${decision.delta ?? "n/a"}, rent=${decision.rule.context_cost}` +
					`${decision.regression ? ", REGRESSION" : ""}` +
					`${decision.toppedUp ? ", topped-up" : ""}` +
					`${decision.uncertain ? ", LOW-CONFIDENCE" : ""}): "${decision.rule.body}"`,
			);
		}
		console.log(
			`Compiled ${report.activeBodies.length} active rule(s) → ${memoryFilePath(args.agent)}` +
				` (ruleset v${report.rulesetVersion})`,
		);
	} finally {
		db.close();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		main(parseSelectArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
