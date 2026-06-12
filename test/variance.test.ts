import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSummary } from "../src/bench.js";
import { getRuleById, insertRule, openDb, type WardenDb } from "../src/db.js";
import { buildNudge } from "../src/notify.js";
import {
	assessDelta,
	mergeSummaries,
	type SuiteRunner,
	selectForAgent,
} from "../src/select.js";

function summary(
	taskId: string,
	tokens: number[],
	completed = true,
): TaskSummary {
	const results = tokens.map((t, i) => ({
		sessionId: `${taskId}-s${i}`,
		tokens: t,
		completed,
	}));
	const completedTokens = completed ? tokens : [];
	const mean =
		completedTokens.length > 0
			? Math.round(
					completedTokens.reduce((a, b) => a + b, 0) / completedTokens.length,
				)
			: 0;
	return { taskId, results, meanCompletedTokens: mean, highVariance: false };
}

describe("assessDelta", () => {
	const baseline = [
		summary("t1", [1000]),
		summary("t2", [1000]),
		summary("t3", [1000]),
	];

	it("flags a verdict within one standard error as uncertain", () => {
		// Per-task savings {60, -100, 200}: mean ≈ 53, SE ≈ 87; threshold 50.
		const withRule = [
			summary("t1", [940]),
			summary("t2", [1100]),
			summary("t3", [800]),
		];
		const assessment = assessDelta(baseline, withRule, 25);
		expect(assessment.delta).toBe(53);
		expect(assessment.uncertain).toBe(true);
		expect(assessment.standardError).toBeGreaterThan(0);
	});

	it("does not flag a clear verdict", () => {
		// Savings {500, 510, 490}: mean 500, SE ≈ 5.8; threshold 50.
		const withRule = [
			summary("t1", [500]),
			summary("t2", [490]),
			summary("t3", [510]),
		];
		expect(assessDelta(baseline, withRule, 25).uncertain).toBe(false);
	});

	it("never marks regressions or unmeasurable deltas uncertain", () => {
		const regressed = [
			summary("t1", [900]),
			summary("t2", [0], false),
			summary("t3", [900]),
		];
		const assessment = assessDelta(baseline, regressed, 25);
		expect(assessment.regression).toBe(true);
		expect(assessment.uncertain).toBe(false);
	});
});

describe("mergeSummaries", () => {
	it("pools results per task and recomputes means", () => {
		const first = [summary("t1", [1000])];
		const second = [summary("t1", [800])];
		const merged = mergeSummaries(first, second);
		expect(merged[0]?.results).toHaveLength(2);
		expect(merged[0]?.meanCompletedTokens).toBe(900);
	});

	it("keeps tasks missing from the second pass unchanged", () => {
		const merged = mergeSummaries([summary("t1", [1000])], []);
		expect(merged[0]?.meanCompletedTokens).toBe(1000);
	});
});

describe("selectForAgent variance top-up", () => {
	let dir: string;
	let db: WardenDb;
	const agent = "sql";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-topup-"));
		db = openDb(join(dir, "warden.db"));
		process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_MEMORY_DIR;
	});

	it("spends one extra pass on an uncertain verdict and decides on pooled data", () => {
		const id = insertRule(db, {
			agent,
			body: "A borderline rule whose first measurement is noisy.",
			contextCost: 25,
			sourceRun: null,
			createdAt: "t",
		});
		const labels: string[] = [];
		const runner: SuiteRunner = (rules, label) => {
			labels.push(label);
			if (rules.length === 0) {
				// Baseline configuration.
				return [
					summary("t1", [1000]),
					summary("t2", [1000]),
					summary("t3", [1000]),
				];
			}
			if (label.endsWith("-topup")) {
				// Clearer second pass: pooled savings become {80, 100, 150}.
				return [
					summary("t1", [900]),
					summary("t2", [700]),
					summary("t3", [900]),
				];
			}
			// Noisy first pass: savings {60, -100, 200} → uncertain at rent 25.
			return [
				summary("t1", [940]),
				summary("t2", [1100]),
				summary("t3", [800]),
			];
		};

		const report = selectForAgent(db, agent, runner, { topUpBudget: 1 });

		expect(labels).toEqual([
			"active-set",
			`candidate-${id}`,
			`candidate-${id}-topup`,
		]);
		const decision = report.decisions[0];
		expect(decision?.toppedUp).toBe(true);
		expect(decision?.uncertain).toBe(false);
		// Pooled savings {80, 100, 150} → mean 110 ≥ 2×25.
		expect(decision?.delta).toBe(110);
		expect(getRuleById(db, id)?.status).toBe("active");
		expect(getRuleById(db, id)?.decided_reason).toContain("variance top-up");
	});

	it("does not top up when the budget is zero", () => {
		insertRule(db, {
			agent,
			body: "A borderline rule measured exactly once.",
			contextCost: 25,
			sourceRun: null,
			createdAt: "t",
		});
		const labels: string[] = [];
		const runner: SuiteRunner = (rules, label) => {
			labels.push(label);
			return rules.length === 0
				? [summary("t1", [1000]), summary("t2", [1000]), summary("t3", [1000])]
				: [summary("t1", [940]), summary("t2", [1100]), summary("t3", [800])];
		};

		const report = selectForAgent(db, agent, runner, { topUpBudget: 0 });
		expect(labels.filter((l) => l.endsWith("-topup"))).toHaveLength(0);
		const decision = report.decisions[0];
		expect(decision?.toppedUp).toBe(false);
		expect(decision?.uncertain).toBe(true);
		expect(getRuleById(db, decision?.rule.id ?? -1)?.decided_reason).toContain(
			"low confidence",
		);
	});
});

describe("buildNudge", () => {
	it("summarizes pending candidates per agent", () => {
		const nudge = buildNudge([
			{ agent: "sql", pending: 2 },
			{ agent: "backend", pending: 1 },
		]);
		expect(nudge).toContain("3 candidate rule(s)");
		expect(nudge).toContain("sql: 2");
		expect(nudge).toContain("warden-select");
	});

	it("is null when nothing is pending", () => {
		expect(buildNudge([])).toBeNull();
	});
});
