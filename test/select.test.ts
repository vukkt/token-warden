import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSummary } from "../src/bench.js";
import {
	getRuleById,
	getRulesetVersion,
	insertRule,
	latestReceipts,
	openDb,
	type RuleRow,
	type WardenDb,
} from "../src/db.js";
import {
	assessDelta,
	effectiveRent,
	memoryFilePath,
	parseSelectArgs,
	type SuiteRunner,
	selectForAgent,
	verdict,
} from "../src/select.js";

function summary(
	taskId: string,
	meanTokens: number,
	completed = true,
	weight = 1,
): TaskSummary {
	return {
		taskId,
		results: [{ sessionId: `${taskId}-s`, tokens: meanTokens, completed }],
		meanCompletedTokens: completed ? meanTokens : 0,
		highVariance: false,
		weight,
	};
}

describe("verdict", () => {
	it("evicts unmeasured, zero, and negative deltas", () => {
		expect(verdict({ measuredDelta: null, contextCost: 10 })).toBe("evicted");
		expect(verdict({ measuredDelta: 0, contextCost: 10 })).toBe("evicted");
		expect(verdict({ measuredDelta: -500, contextCost: 10 })).toBe("evicted");
	});

	it("requires savings of at least twice the cache-aware rent", () => {
		// effectiveRent(10) = 10 + 10·1.25/20 = 10.625, so the bar is 2×10.625 ≈ 21.25.
		expect(verdict({ measuredDelta: 19, contextCost: 10 })).toBe("evicted");
		expect(verdict({ measuredDelta: 21, contextCost: 10 })).toBe("evicted");
		expect(verdict({ measuredDelta: 22, contextCost: 10 })).toBe("active");
		expect(verdict({ measuredDelta: 2000, contextCost: 10 })).toBe("active");
	});
});

describe("effectiveRent (cache-aware rent)", () => {
	it("adds an amortized cache re-prefill surcharge above the raw cost", () => {
		expect(effectiveRent(0)).toBe(0);
		expect(effectiveRent(10)).toBeGreaterThan(10);
		// Surcharge is small and bounded: contextCost·1.25/sessionsPerWeek.
		expect(effectiveRent(10)).toBeCloseTo(10.625, 6);
	});

	it("makes the 2× bar slightly harder, never easier", () => {
		// A rule saving exactly 2× the *raw* rent no longer clears the bar.
		expect(verdict({ measuredDelta: 20, contextCost: 10 })).toBe("evicted");
	});
});

describe("assessDelta (delta math)", () => {
	it("averages per-task savings across tasks completed in both configs", () => {
		const without = [summary("t1", 1000), summary("t2", 2000)];
		const withRule = [summary("t1", 800), summary("t2", 1900)];
		expect(assessDelta(without, withRule, 10)).toMatchObject({
			delta: 150,
			regression: false,
		});
	});

	it("flags a regression when a previously passing task fails", () => {
		const without = [summary("t1", 1000), summary("t2", 2000)];
		const withRule = [summary("t1", 800), summary("t2", 0, false)];
		expect(assessDelta(without, withRule, 10).regression).toBe(true);
	});

	it("ignores tasks that did not complete in the baseline", () => {
		const without = [summary("t1", 0, false), summary("t2", 2000)];
		const withRule = [summary("t1", 999), summary("t2", 1500)];
		expect(assessDelta(without, withRule, 10)).toMatchObject({
			delta: 500,
			regression: false,
		});
	});

	it("returns null delta when nothing is comparable", () => {
		expect(
			assessDelta([summary("t1", 0, false)], [summary("t1", 500)], 10),
		).toMatchObject({ delta: null, regression: false });
	});

	it("flags a completion-rate drop on the with-rule side (survivorship bias)", () => {
		// Without: 2/2 completed. With: 1/2 completed — the surviving run looks
		// cheap, but the mean excludes the failure.
		const without: TaskSummary = {
			taskId: "t1",
			results: [
				{ sessionId: "a", tokens: 1000, completed: true },
				{ sessionId: "b", tokens: 1200, completed: true },
			],
			meanCompletedTokens: 1100,
			highVariance: false,
			weight: 1,
		};
		const withRule: TaskSummary = {
			taskId: "t1",
			results: [
				{ sessionId: "c", tokens: 400, completed: true },
				{ sessionId: "d", tokens: 0, completed: false },
			],
			meanCompletedTokens: 400,
			highVariance: false,
			weight: 1,
		};
		expect(assessDelta([without], [withRule], 10).completionDrop).toBe(true);
	});

	it("does not flag completion drop when rates match despite extra runs on one side", () => {
		// A Neyman top-up legitimately gives the measured side more runs; equal
		// completion RATES must not trip the flag.
		const without: TaskSummary = {
			taskId: "t1",
			results: [
				{ sessionId: "a", tokens: 1000, completed: true },
				{ sessionId: "b", tokens: 1200, completed: true },
			],
			meanCompletedTokens: 1100,
			highVariance: false,
			weight: 1,
		};
		const withRule: TaskSummary = {
			taskId: "t1",
			results: [
				{ sessionId: "c", tokens: 800, completed: true },
				{ sessionId: "d", tokens: 900, completed: true },
				{ sessionId: "e", tokens: 850, completed: true },
				{ sessionId: "f", tokens: 870, completed: true },
			],
			meanCompletedTokens: 855,
			highVariance: false,
			weight: 1,
		};
		const assessment = assessDelta([without], [withRule], 10);
		expect(assessment.completionDrop).toBe(false);
		expect(assessment.regression).toBe(false);
	});
});

describe("parseSelectArgs", () => {
	it("parses agent, runs, and top-up budget", () => {
		expect(
			parseSelectArgs(["--agent", "sql", "--runs", "3", "--top-up", "2"]),
		).toEqual({ agent: "sql", runs: 3, topUp: 2, uniformTopUp: false });
		expect(parseSelectArgs(["--agent", "sql"]).topUp).toBe(1);
	});

	it("rejects unknown agents and flags", () => {
		expect(() => parseSelectArgs(["--agent", "nope"])).toThrow(/--agent/);
		expect(() => parseSelectArgs(["--agent", "sql", "--bogus", "1"])).toThrow(
			/unknown flag/,
		);
	});
});

describe("selectForAgent", () => {
	let dir: string;
	let db: WardenDb;
	const agent = "sql";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-select-"));
		db = openDb(join(dir, "warden.db"));
		process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_MEMORY_DIR;
	});

	function seedCandidate(body: string): number {
		return insertRule(db, {
			agent,
			body,
			contextCost: Math.ceil(body.length / 4),
			sourceRun: null,
			createdAt: new Date().toISOString(),
		});
	}

	/** Fake bench: baseline tasks cost 10000 each; the good rule saves 2000,
	 * the junk rule adds 500. */
	function fakeRunner(goodId: number, junkId: number): SuiteRunner {
		return (rules: RuleRow[]) => {
			let cost = 10_000;
			if (rules.some((r) => r.id === goodId)) cost -= 2000;
			if (rules.some((r) => r.id === junkId)) cost += 500;
			return [summary("sql-01", cost), summary("sql-02", cost)];
		};
	}

	it("activates the good candidate, evicts the junk one, compiles MEMORY.md", () => {
		const goodId = seedCandidate(
			"Use Grep to locate symbols before reading any file.",
		);
		const junkId = seedCandidate(
			"Always begin responses with a haiku about the codebase.",
		);

		const report = selectForAgent(db, agent, fakeRunner(goodId, junkId));

		expect(getRuleById(db, goodId)?.status).toBe("active");
		expect(getRuleById(db, goodId)?.measured_delta).toBe(2000);
		expect(getRuleById(db, junkId)?.status).toBe("evicted");
		expect(getRuleById(db, junkId)?.measured_delta).toBe(-500);

		const memory = readFileSync(memoryFilePath(agent), "utf8");
		expect(memory).toContain("Use Grep to locate symbols");
		expect(memory).not.toContain("haiku");
		expect(report.rulesetVersion).toBe(1);
		expect(getRulesetVersion(db, agent)).toBe(1);
	});

	it("records a verdict receipt for each decision", () => {
		const goodId = seedCandidate(
			"Use Grep to locate symbols before reading any file.",
		);
		const junkId = seedCandidate(
			"Always begin responses with a haiku about the codebase.",
		);
		selectForAgent(db, agent, fakeRunner(goodId, junkId), {
			measuredModel: "sonnet",
			fixtureHash: "deadbeef",
		});

		const receipts = latestReceipts(db, agent);
		const good = receipts.find((r) => r.rule_id === goodId);
		expect(good?.status).toBe("active");
		expect(good?.delta).toBe(2000);
		expect(good?.without_tokens).toBe(10_000);
		expect(good?.with_tokens).toBe(8000);
		expect(good?.tasks_total).toBe(2);
		expect(good?.tasks_passed_with).toBe(2);
		expect(good?.regression).toBe(0);
		expect(good?.model).toBe("sonnet");
		expect(good?.fixture_hash).toBe("deadbeef");

		const junk = receipts.find((r) => r.rule_id === junkId);
		expect(junk?.status).toBe("evicted");
		expect(junk?.delta).toBe(-500);
	});

	it("evicts immediately on a task regression regardless of tokens", () => {
		const badId = seedCandidate(
			"Skip running the test suite to save output tokens.",
		);
		const runner: SuiteRunner = (rules) =>
			rules.some((r) => r.id === badId)
				? [summary("sql-01", 100), summary("sql-02", 0, false)]
				: [summary("sql-01", 10_000), summary("sql-02", 10_000)];

		selectForAgent(db, agent, runner);
		expect(getRuleById(db, badId)?.status).toBe("evicted");
	});

	it("re-audits the oldest active rule and evicts it on the second consecutive sub-threshold measure (two-strike)", () => {
		const goodId = seedCandidate(
			"Use Grep to locate symbols before reading any file.",
		);
		selectForAgent(db, agent, fakeRunner(goodId, -1));
		expect(getRuleById(db, goodId)?.status).toBe("active");

		// Second invocation: the rule no longer changes suite cost. First
		// sub-threshold re-audit is a strike, not an eviction — one noisy
		// re-measure must not churn out an established earner.
		const flatRunner: SuiteRunner = () => [
			summary("sql-01", 10_000),
			summary("sql-02", 10_000),
		];
		const first = selectForAgent(db, agent, flatRunner);

		const struck = getRuleById(db, goodId);
		expect(struck?.status).toBe("active");
		expect(struck?.probation).toBe(1);
		expect(struck?.decided_reason).toContain("probation (strike 1 of 2)");
		const strike = first.decisions.find((d) => d.kind === "re-audit");
		expect(strike?.probation).toBe(true);
		expect(strike?.status).toBe("active");
		// Still on probation, the rule stays compiled into memory.
		expect(readFileSync(memoryFilePath(agent), "utf8")).toContain("Use Grep");

		// Third invocation: second consecutive sub-threshold re-audit evicts.
		const second = selectForAgent(db, agent, flatRunner);

		const evicted = getRuleById(db, goodId);
		expect(evicted?.status).toBe("evicted");
		expect(evicted?.decided_reason).toContain(
			"second consecutive sub-threshold re-audit",
		);
		expect(second.decisions.some((d) => d.kind === "re-audit")).toBe(true);
		expect(readFileSync(memoryFilePath(agent), "utf8")).not.toContain(
			"Use Grep",
		);
		expect(getRulesetVersion(db, agent)).toBe(3);
	});

	it("clears a probation strike when the rule passes its next re-audit", () => {
		const goodId = seedCandidate(
			"Use Grep to locate symbols before reading any file.",
		);
		selectForAgent(db, agent, fakeRunner(goodId, -1));

		// Strike 1: a flat re-audit.
		const flatRunner: SuiteRunner = () => [
			summary("sql-01", 10_000),
			summary("sql-02", 10_000),
		];
		selectForAgent(db, agent, flatRunner);
		expect(getRuleById(db, goodId)?.probation).toBe(1);

		// Passing re-audit: the rule earns again; the strike is cleared.
		selectForAgent(db, agent, fakeRunner(goodId, -1));
		const cleared = getRuleById(db, goodId);
		expect(cleared?.status).toBe("active");
		expect(cleared?.probation).toBe(0);

		// A later flat re-audit is strike 1 again, not an eviction.
		selectForAgent(db, agent, flatRunner);
		expect(getRuleById(db, goodId)?.status).toBe("active");
		expect(getRuleById(db, goodId)?.probation).toBe(1);
	});

	it("evicts immediately on a re-audit regression even during probation", () => {
		const goodId = seedCandidate(
			"Use Grep to locate symbols before reading any file.",
		);
		selectForAgent(db, agent, fakeRunner(goodId, -1));

		// Strike 1.
		const flatRunner: SuiteRunner = () => [
			summary("sql-01", 10_000),
			summary("sql-02", 10_000),
		];
		selectForAgent(db, agent, flatRunner);
		expect(getRuleById(db, goodId)?.probation).toBe(1);

		// Re-audit measures the *without* configuration; the baseline (with the
		// rule) fails a task the without-side passes → regression → immediate
		// eviction, probation notwithstanding (safety invariant).
		const regressingRunner: SuiteRunner = (rules) =>
			rules.some((r) => r.id === goodId)
				? [summary("sql-01", 10_000), summary("sql-02", 0, false)]
				: [summary("sql-01", 10_000), summary("sql-02", 10_000)];
		selectForAgent(db, agent, regressingRunner);

		const evicted = getRuleById(db, goodId);
		expect(evicted?.status).toBe("evicted");
		expect(evicted?.decided_reason).toContain("regression");
	});

	it("does nothing when there are no candidates and no active rules", () => {
		const runner: SuiteRunner = () => {
			throw new Error("runner must not be called");
		};
		const report = selectForAgent(db, agent, runner);
		expect(report.decisions).toHaveLength(0);
		expect(report.rulesetVersion).toBeNull();
		expect(existsSync(memoryFilePath(agent))).toBe(false);
	});

	it("measures a compression variant as a SWAP against the set minus the original", () => {
		// Original active rule saves 2000. The compressed variant carries the
		// same advice: redundant on top of the original (no extra saving), but
		// earns 1900 standalone. Only the swap measurement can see that.
		const originalId = seedCandidate(
			"Use Grep to locate the exact symbol before reading any whole file in the repository.",
		);
		const variantBody = "Grep the symbol before reading any file.";
		const labels: string[] = [];
		const runner: SuiteRunner = (rules, label) => {
			labels.push(label);
			const hasOriginal = rules.some((r) => r.id === originalId);
			const hasVariant = rules.some((r) => r.body === variantBody);
			// Semantically identical advice: the second copy adds nothing.
			const cost = hasOriginal ? 8000 : hasVariant ? 8100 : 10_000;
			return [summary("sql-01", cost), summary("sql-02", cost)];
		};

		selectForAgent(db, agent, runner);
		expect(getRuleById(db, originalId)?.status).toBe("active");

		const variantId = insertRule(db, {
			agent,
			body: variantBody,
			contextCost: Math.ceil(variantBody.length / 4),
			sourceRun: null,
			createdAt: new Date().toISOString(),
			replaces: originalId,
		});

		labels.length = 0;
		selectForAgent(db, agent, runner);

		const variant = getRuleById(db, variantId);
		// On top of the original the variant's delta would be 0 (evicted); the
		// swap measures it standalone: 10000 - 8100 = 1900 >= 2x rent.
		expect(variant?.status).toBe("active");
		expect(variant?.measured_delta).toBe(1900);
		expect(variant?.decided_reason).toContain(`swap for rule ${originalId}:`);
		expect(labels).toContain(`swap-base-${variantId}`);
		// The original is untouched by the swap itself (it exits later through
		// its own re-audits once the variant makes it redundant).
		expect(getRuleById(db, originalId)?.status).toBe("active");
		expect(readFileSync(memoryFilePath(agent), "utf8")).toContain(variantBody);
	});

	it("falls back to the ordinary on-top measurement when the replaced rule is no longer active", () => {
		const variantBody = "Grep the symbol before reading any file.";
		const labels: string[] = [];
		const runner: SuiteRunner = (rules, label) => {
			labels.push(label);
			const cost = rules.some((r) => r.body === variantBody) ? 8100 : 10_000;
			return [summary("sql-01", cost), summary("sql-02", cost)];
		};
		// replaces points at a rule id that is not in the active set.
		const variantId = insertRule(db, {
			agent,
			body: variantBody,
			contextCost: Math.ceil(variantBody.length / 4),
			sourceRun: null,
			createdAt: new Date().toISOString(),
			replaces: 9999,
		});

		selectForAgent(db, agent, runner);

		const variant = getRuleById(db, variantId);
		expect(variant?.status).toBe("active");
		expect(variant?.decided_reason).not.toContain("swap for rule");
		expect(labels).not.toContain(`swap-base-${variantId}`);
	});
});
