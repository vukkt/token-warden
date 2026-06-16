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
): TaskSummary {
	return {
		taskId,
		results: [{ sessionId: `${taskId}-s`, tokens: meanTokens, completed }],
		meanCompletedTokens: completed ? meanTokens : 0,
		highVariance: false,
	};
}

describe("verdict", () => {
	it("evicts unmeasured, zero, and negative deltas", () => {
		expect(verdict({ measuredDelta: null, contextCost: 10 })).toBe("evicted");
		expect(verdict({ measuredDelta: 0, contextCost: 10 })).toBe("evicted");
		expect(verdict({ measuredDelta: -500, contextCost: 10 })).toBe("evicted");
	});

	it("requires savings of at least twice the context rent", () => {
		expect(verdict({ measuredDelta: 19, contextCost: 10 })).toBe("evicted");
		expect(verdict({ measuredDelta: 20, contextCost: 10 })).toBe("active");
		expect(verdict({ measuredDelta: 2000, contextCost: 10 })).toBe("active");
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
});

describe("parseSelectArgs", () => {
	it("parses agent, runs, and top-up budget", () => {
		expect(
			parseSelectArgs(["--agent", "sql", "--runs", "3", "--top-up", "2"]),
		).toEqual({ agent: "sql", runs: 3, topUp: 2 });
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

	it("re-audits the oldest active rule and evicts it when it stops earning", () => {
		const goodId = seedCandidate(
			"Use Grep to locate symbols before reading any file.",
		);
		selectForAgent(db, agent, fakeRunner(goodId, -1));
		expect(getRuleById(db, goodId)?.status).toBe("active");

		// Second invocation: the rule no longer changes suite cost.
		const flatRunner: SuiteRunner = () => [
			summary("sql-01", 10_000),
			summary("sql-02", 10_000),
		];
		const report = selectForAgent(db, agent, flatRunner);

		expect(getRuleById(db, goodId)?.status).toBe("evicted");
		expect(report.decisions.some((d) => d.kind === "re-audit")).toBe(true);
		expect(readFileSync(memoryFilePath(agent), "utf8")).not.toContain(
			"Use Grep",
		);
		expect(getRulesetVersion(db, agent)).toBe(2);
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
});
