import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type NewRun,
	openDb,
	recordToolCosts,
	type ToolCostInput,
	toolCostRollup,
	upsertRun,
	type WardenDb,
} from "../src/db.js";

let dir: string;
let db: WardenDb;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-tc-"));
	db = openDb(join(dir, "warden.db"));
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function makeRun(over: Partial<NewRun> = {}): NewRun {
	return {
		agent: "backend",
		sessionId: "s1",
		taskHash: null,
		inputTokens: 1,
		outputTokens: 1,
		cacheCreation: 0,
		cacheRead: 0,
		toolCalls: 0,
		fileRereads: 0,
		completed: true,
		rulesetVersion: 0,
		ts: "2026-06-15T00:00:00.000Z",
		config: "real",
		...over,
	};
}

function cost(over: Partial<ToolCostInput>): ToolCostInput {
	return {
		kind: "builtin",
		group: "(builtin)",
		label: "Read",
		calls: 1,
		inputChars: 10,
		resultChars: 100,
		...over,
	};
}

describe("recordToolCosts", () => {
	it("persists rows for a run", () => {
		const runId = upsertRun(db, makeRun());
		recordToolCosts(db, runId, [
			cost({}),
			cost({ label: "Bash", resultChars: 5 }),
		]);
		const rows = toolCostRollup(db, { limit: 10 });
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.label).sort()).toEqual(["Bash", "Read"]);
	});

	it("replaces a run's prior costs rather than accumulating", () => {
		const runId = upsertRun(db, makeRun());
		recordToolCosts(db, runId, [cost({ calls: 5, resultChars: 500 })]);
		// The Stop hook re-records the same session with new totals.
		recordToolCosts(db, runId, [cost({ calls: 7, resultChars: 700 })]);
		const rows = toolCostRollup(db, { limit: 10 });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ calls: 7, resultChars: 700 });
	});

	it("handles an empty cost list", () => {
		const runId = upsertRun(db, makeRun());
		recordToolCosts(db, runId, [cost({})]);
		recordToolCosts(db, runId, []);
		expect(toolCostRollup(db, { limit: 10 })).toEqual([]);
	});
});

describe("toolCostRollup", () => {
	it("aggregates across sessions and counts distinct sessions", () => {
		const r1 = upsertRun(db, makeRun({ sessionId: "s1" }));
		const r2 = upsertRun(db, makeRun({ sessionId: "s2" }));
		recordToolCosts(db, r1, [
			cost({ calls: 2, inputChars: 20, resultChars: 200 }),
		]);
		recordToolCosts(db, r2, [
			cost({ calls: 3, inputChars: 30, resultChars: 300 }),
		]);
		const rows = toolCostRollup(db, { limit: 10 });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			label: "Read",
			sessions: 2,
			calls: 5,
			inputChars: 50,
			resultChars: 500,
		});
	});

	it("orders by total footprint descending", () => {
		const runId = upsertRun(db, makeRun());
		recordToolCosts(db, runId, [
			cost({ label: "Read", inputChars: 1, resultChars: 1 }),
			cost({ label: "Bash", inputChars: 1, resultChars: 9000 }),
		]);
		expect(toolCostRollup(db, { limit: 10 }).map((r) => r.label)).toEqual([
			"Bash",
			"Read",
		]);
	});

	it("filters by agent", () => {
		const be = upsertRun(db, makeRun({ agent: "backend", sessionId: "s1" }));
		const fe = upsertRun(db, makeRun({ agent: "frontend", sessionId: "s2" }));
		recordToolCosts(db, be, [cost({ label: "Read" })]);
		recordToolCosts(db, fe, [cost({ label: "Edit" })]);
		const rows = toolCostRollup(db, { agent: "backend", limit: 10 });
		expect(rows.map((r) => r.label)).toEqual(["Read"]);
	});

	it("filters by kind", () => {
		const runId = upsertRun(db, makeRun());
		recordToolCosts(db, runId, [
			cost({ kind: "builtin", label: "Read" }),
			cost({ kind: "mcp", group: "github", label: "create_issue" }),
		]);
		const rows = toolCostRollup(db, { kind: "mcp", limit: 10 });
		expect(rows.map((r) => r.label)).toEqual(["create_issue"]);
	});

	it("excludes golden runs (task_hash set) — attribution is real-work only", () => {
		const golden = upsertRun(
			db,
			makeRun({ taskHash: "task-1", config: "active" }),
		);
		recordToolCosts(db, golden, [cost({ label: "Read" })]);
		expect(toolCostRollup(db, { limit: 10 })).toEqual([]);
	});

	it("respects the limit", () => {
		const runId = upsertRun(db, makeRun());
		recordToolCosts(db, runId, [
			cost({ label: "A", resultChars: 300 }),
			cost({ label: "B", resultChars: 200 }),
			cost({ label: "C", resultChars: 100 }),
		]);
		expect(toolCostRollup(db, { limit: 2 }).map((r) => r.label)).toEqual([
			"A",
			"B",
		]);
	});
});
