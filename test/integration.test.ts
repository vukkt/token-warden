import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSummary } from "../src/bench.js";
import type { RuleRow, WardenDb } from "../src/db.js";
import {
	getRuleById,
	insertRule,
	latestReceipts,
	type NewRun,
	openDb,
	upsertRun,
} from "../src/db.js";
import { shouldDistill } from "../src/distill.js";
import {
	memoryFilePath,
	type SuiteRunner,
	selectForAgent,
} from "../src/select.js";
import { renderStatus } from "../src/status.js";

/**
 * Cross-component integration: real-work collection feeds the distiller's p75
 * trigger; the selector measures candidates, evicts/keeps, compiles memory, and
 * records receipts; the status report reflects the result. Only the claude
 * subprocess is faked (a SuiteRunner) — every other module is the real one,
 * wired through the same SQLite DB.
 */

let dir: string;
let db: WardenDb;
const agent = "sql";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-integration-"));
	db = openDb(join(dir, "warden.db"));
	process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
	delete process.env.TOKEN_WARDEN_MEMORY_DIR;
});

function realRun(sessionId: string, total: number): NewRun {
	return {
		agent,
		sessionId,
		taskHash: null,
		inputTokens: total,
		outputTokens: 0,
		cacheCreation: 0,
		cacheRead: 0,
		toolCalls: 5,
		fileRereads: 1,
		completed: true,
		rulesetVersion: 0,
		ts: new Date().toISOString(),
		config: "real",
		project: "/proj",
	};
}

function summary(taskId: string, tokens: number): TaskSummary {
	return {
		taskId,
		results: [{ sessionId: `${taskId}-s`, tokens, completed: true }],
		meanCompletedTokens: tokens,
		highVariance: false,
	};
}

describe("collect → distill-trigger → select → receipts → status", () => {
	it("an expensive run trips the distiller, then the selector decides and the picture is consistent", () => {
		// 1. Collection: a history of cheap real-work sessions, then one spike.
		for (let i = 0; i < 6; i++) {
			upsertRun(db, realRun(`cheap-${i}`, 10_000));
		}
		const spikeId = upsertRun(db, realRun("spike", 40_000));

		// 2. Distiller trigger (pure, real): the spike is above the rolling p75.
		expect(shouldDistill(db, agent, spikeId, 40_000)).toBe(true);
		expect(shouldDistill(db, agent, spikeId, 9_000)).toBe(false);

		// 3. Two candidates land (as the distiller would insert them).
		const good = insertRule(db, {
			agent,
			body: "Use Grep to locate symbols before reading any file.",
			contextCost: 13,
			sourceRun: null,
			createdAt: new Date().toISOString(),
		});
		const junk = insertRule(db, {
			agent,
			body: "Always begin every response with a haiku.",
			contextCost: 11,
			sourceRun: null,
			createdAt: new Date().toISOString(),
		});

		// 4. Selection (real selector, faked suite): good saves 2k, junk costs 500.
		const runner: SuiteRunner = (rules: RuleRow[]) => {
			let cost = 10_000;
			if (rules.some((r) => r.id === good)) cost -= 2000;
			if (rules.some((r) => r.id === junk)) cost += 500;
			return [summary("sql-01", cost), summary("sql-02", cost)];
		};
		const report = selectForAgent(db, agent, runner, {
			measuredModel: "sonnet",
			fixtureHash: "abcd1234",
		});

		// 5. Verdicts propagate consistently across components.
		expect(getRuleById(db, good)?.status).toBe("active");
		expect(getRuleById(db, junk)?.status).toBe("evicted");
		expect(report.rulesetVersion).toBe(1);

		// compiled memory holds the winner only
		const memory = readFileSync(memoryFilePath(agent), "utf8");
		expect(memory).toContain("Use Grep to locate symbols");
		expect(memory).not.toContain("haiku");

		// a receipt exists for each decision, with the provenance threaded through
		const receipts = latestReceipts(db, agent);
		expect(receipts).toHaveLength(2);
		expect(receipts.find((r) => r.rule_id === good)?.model).toBe("sonnet");
		expect(receipts.find((r) => r.rule_id === good)?.fixture_hash).toBe(
			"abcd1234",
		);

		// the status report reflects the same world
		const status = renderStatus(db);
		expect(status).toContain("Use Grep to locate symbols");
		expect(status).toContain("/proj");
	});
});
