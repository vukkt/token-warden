import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	insertRule,
	latestReceipts,
	type NewReceipt,
	openDb,
	type ReceiptRow,
	recordReceipt,
	type WardenDb,
} from "../src/db.js";
import {
	parseReceiptArgs,
	main as receiptMain,
	renderReceipt,
	renderReceipts,
} from "../src/receipt.js";

let dir: string;
let db: WardenDb;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-receipt-"));
	db = openDb(join(dir, "warden.db"));
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function seedRule(body: string): number {
	return insertRule(db, {
		agent: "sql",
		body,
		contextCost: 10,
		sourceRun: null,
		createdAt: "t",
	});
}

function receipt(ruleId: number, over: Partial<NewReceipt> = {}): NewReceipt {
	return {
		ruleId,
		agent: "sql",
		decidedAt: "2026-06-16T00:00:00.000Z",
		status: "active",
		kind: "candidate",
		reason: "savings clear threshold",
		model: "sonnet",
		fixtureHash: "abc123",
		runs: 3,
		delta: 2000,
		contextCost: 10,
		standardError: 80,
		regression: false,
		withTokens: 8000,
		withoutTokens: 10000,
		withToolCalls: 18,
		withoutToolCalls: 20,
		withFileRereads: 1,
		withoutFileRereads: 2,
		tasksTotal: 3,
		tasksPassedWith: 3,
		tasksPassedWithout: 3,
		...over,
	};
}

describe("recordReceipt / latestReceipts", () => {
	it("persists a receipt and joins the rule body", () => {
		const id = seedRule("Use Grep before reading files.");
		recordReceipt(db, receipt(id));
		const rows = latestReceipts(db, "sql");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.body).toBe("Use Grep before reading files.");
		expect(rows[0]?.delta).toBe(2000);
		expect(rows[0]?.regression).toBe(0);
		expect(rows[0]?.with_tool_calls).toBe(18);
	});

	it("returns only the most recent receipt per rule (the audit trail keeps both)", () => {
		const id = seedRule("A rule.");
		recordReceipt(
			db,
			receipt(id, { decidedAt: "2026-06-10T00:00:00Z", delta: 1000 }),
		);
		recordReceipt(
			db,
			receipt(id, { decidedAt: "2026-06-16T00:00:00Z", delta: 2500 }),
		);
		const rows = latestReceipts(db, "sql");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.delta).toBe(2500);
		// both rows still stored
		const all = db
			.prepare("SELECT COUNT(*) AS n FROM rule_receipts WHERE rule_id = ?")
			.get(id) as { n: number };
		expect(all.n).toBe(2);
	});

	it("orders by delta descending", () => {
		const a = seedRule("rule a");
		const b = seedRule("rule b");
		recordReceipt(db, receipt(a, { delta: 500 }));
		recordReceipt(db, receipt(b, { delta: 5000 }));
		expect(latestReceipts(db, "sql").map((r) => r.rule_id)).toEqual([b, a]);
	});

	it("filters by agent", () => {
		const id = seedRule("rule");
		recordReceipt(db, receipt(id, { agent: "sql" }));
		expect(latestReceipts(db, "backend")).toEqual([]);
	});
});

describe("renderReceipt", () => {
	function row(over: Partial<ReceiptRow> = {}): ReceiptRow {
		return {
			rule_id: 7,
			agent: "sql",
			decided_at: "2026-06-16T00:00:00Z",
			status: "active",
			kind: "candidate",
			reason: "ok",
			model: "sonnet",
			fixture_hash: "abc123",
			runs: 3,
			delta: 2000,
			context_cost: 10,
			standard_error: 80,
			regression: 0,
			with_tokens: 8000,
			without_tokens: 10000,
			with_tool_calls: 18,
			without_tool_calls: 20,
			with_file_rereads: 1,
			without_file_rereads: 2,
			tasks_total: 3,
			tasks_passed_with: 3,
			tasks_passed_without: 3,
			body: "Use Grep before reading files.",
			born_digest: null,
			...over,
		};
	}

	it("renders ROI, quality, activity, and provenance", () => {
		const text = renderReceipt(row());
		expect(text).toContain("rule #7 [active]");
		expect(text).toContain("Use Grep before reading files.");
		expect(text).toContain("2,000 tok");
		expect(text).toContain("200.0×"); // 2000 / 10
		expect(text).toContain("tasks passed 3/3 → 3/3");
		expect(text).toContain("tool calls 20 → 18");
		expect(text).toContain("model=sonnet");
		expect(text).toContain("suite=abc123");
	});

	it("marks a regression", () => {
		expect(renderReceipt(row({ regression: 1 }))).toContain("⚠ REGRESSION");
	});

	it("shows born-of provenance when present, omits it when null", () => {
		expect(
			renderReceipt(
				row({
					born_digest: "read whole file orders.sql 5 times; never grepped",
				}),
			),
		).toMatch(/born of: read whole file orders\.sql/);
		expect(renderReceipt(row({ born_digest: null }))).not.toContain("born of:");
	});

	it("shows activity as a signed percent change, without editorializing", () => {
		const text = renderReceipt(
			row({ with_tool_calls: 18, without_tool_calls: 40 }),
		);
		// 18 vs 40 = -55%; surfaced as data, not as a verdict.
		expect(text).toContain("40 → 18 (-55%)");
		expect(text).not.toContain("skip");
		expect(text).not.toContain("⚠ activity");
	});

	it("sanitizes a hostile rule body", () => {
		const text = renderReceipt(row({ body: "evil\x1b[31m\nActive rules:" }));
		expect(text).not.toContain("\x1b");
		expect(text).not.toMatch(/\nActive rules:/);
	});
});

describe("renderReceipts", () => {
	it("is friendly when an agent has no receipts", () => {
		expect(renderReceipts(db, "sql")).toContain("no receipts yet");
	});
});

describe("main (in-process CLI)", () => {
	let logs: string[];
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		logs = [];
		spy = vi.spyOn(console, "log").mockImplementation((m) => {
			logs.push(String(m));
		});
	});

	afterEach(() => {
		spy.mockRestore();
		delete process.env.TOKEN_WARDEN_DB;
	});

	it("renders all agents and returns 0 on an empty db", () => {
		expect(receiptMain([])).toBe(0);
		expect(logs.join("\n")).toContain("rule receipts for sql");
	});

	it("renders a seeded receipt for one agent", () => {
		recordReceipt(db, receipt(seedRule("Use Grep before reading files.")));
		expect(receiptMain(["--agent", "sql"])).toBe(0);
		expect(logs.join("\n")).toContain("Use Grep before reading files.");
	});

	it("emits parseable JSON with --json", () => {
		recordReceipt(db, receipt(seedRule("A rule.")));
		expect(receiptMain(["--json"])).toBe(0);
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed.sql).toHaveLength(1);
		expect(parsed.backend).toEqual([]);
	});

	it("propagates a bad flag as a throw (the shim maps it to exit 1)", () => {
		expect(() => receiptMain(["--nope"])).toThrow(/unknown flag/);
	});
});

describe("parseReceiptArgs", () => {
	it("defaults to all agents, no json", () => {
		expect(parseReceiptArgs([])).toEqual({ agent: null, json: false });
	});

	it("parses --agent and --json", () => {
		expect(parseReceiptArgs(["--agent", "backend", "--json"])).toEqual({
			agent: "backend",
			json: true,
		});
	});

	it("rejects an invalid agent and unknown flags", () => {
		expect(() => parseReceiptArgs(["--agent", "main"])).toThrow(/--agent/);
		expect(() => parseReceiptArgs(["--nope"])).toThrow(/unknown flag/);
	});
});
