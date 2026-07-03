import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decideRule,
	insertRule,
	openDb,
	type RuleRow,
	type WardenDb,
} from "../src/db.js";
import {
	formatLedger,
	LEDGER_MARKER,
	parseShareArgs,
	type SharedLedger,
	main as shareMain,
	toSharedLedger,
} from "../src/share.js";

function rule(overrides: Partial<RuleRow> = {}): RuleRow {
	return {
		id: 1,
		agent: "sql",
		body: "Use Grep to locate symbols before reading any file.",
		status: "active",
		measured_delta: 3673,
		context_cost: 13,
		source_run: 13,
		decided_at: "t",
		created_at: "2026-06-11T00:00:00.000Z",
		decided_reason: "savings 3673 ≥ 2× context rent 13",
		protected: 0,
		born_digest: null,
		scope: null,
		probation: 0,
		...overrides,
	};
}

describe("parseShareArgs", () => {
	it("parses agent with a default null out", () => {
		expect(parseShareArgs(["--agent", "sql"])).toEqual({
			agent: "sql",
			out: null,
		});
	});

	it("parses an explicit out path", () => {
		expect(
			parseShareArgs(["--agent", "backend", "--out", "/tmp/x.md"]),
		).toEqual({
			agent: "backend",
			out: "/tmp/x.md",
		});
	});

	it("rejects a non-domain agent and unknown flags", () => {
		expect(() => parseShareArgs(["--agent", "main"])).toThrow(/--agent/);
		expect(() => parseShareArgs(["--agent", "sql", "--bogus"])).toThrow(
			/unknown flag/,
		);
	});
});

describe("toSharedLedger", () => {
	it("maps ledger rows to the portable shape", () => {
		const ledger = toSharedLedger("sql", [rule()], "2026-06-15T00:00:00Z");
		expect(ledger).toEqual({
			agent: "sql",
			exportedAt: "2026-06-15T00:00:00Z",
			rules: [
				{
					body: "Use Grep to locate symbols before reading any file.",
					measuredDelta: 3673,
					contextCost: 13,
					sourceRun: 13,
					createdAt: "2026-06-11T00:00:00.000Z",
				},
			],
		});
	});
});

describe("formatLedger", () => {
	const ledger = toSharedLedger(
		"sql",
		[
			rule(),
			rule({
				id: 2,
				body: "Other rule.",
				measured_delta: 500,
				context_cost: 7,
			}),
		],
		"2026-06-15T00:00:00Z",
	);
	const out = formatLedger(ledger);

	it("renders a reviewable header and per-rule deltas", () => {
		expect(out).toContain("# token-warden rules — sql");
		expect(out).toContain("2 active rule(s)");
		expect(out).toContain(
			"**+3673 tokens/run** (rent 13): Use Grep to locate symbols",
		);
		expect(out).toContain("**+500 tokens/run** (rent 7): Other rule.");
	});

	it("embeds a machine-readable JSON block that round-trips", () => {
		expect(out).toContain(LEDGER_MARKER);
		const json = out.split("```json\n")[1]?.split("\n```")[0] ?? "";
		expect(JSON.parse(json) as SharedLedger).toEqual(ledger);
	});

	it("handles an empty ledger without a JSON parse hazard", () => {
		const empty = formatLedger(toSharedLedger("frontend", [], "t"));
		expect(empty).toContain("0 active rule(s)");
		expect(empty).toContain("_No active rules yet._");
		const json = empty.split("```json\n")[1]?.split("\n```")[0] ?? "";
		expect((JSON.parse(json) as SharedLedger).rules).toEqual([]);
	});

	it("renders n/a for a null measured delta", () => {
		const out2 = formatLedger(
			toSharedLedger("sql", [rule({ measured_delta: null })], "t"),
		);
		expect(out2).toContain("**n/a tokens/run**");
	});
});

describe("main (in-process CLI)", () => {
	let dir: string;
	let db: WardenDb;
	let logs: string[];
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-sharemain-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		db = openDb(join(dir, "warden.db"));
		logs = [];
		spy = vi.spyOn(console, "log").mockImplementation((m) => {
			logs.push(String(m));
		});
	});

	afterEach(() => {
		spy.mockRestore();
		db.close();
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes a ledger of the agent's active rules to --out", () => {
		const id = insertRule(db, {
			agent: "sql",
			body: "Use Grep before reading any file.",
			contextCost: 8,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, id, "active", 600, "earns its rent", "t");
		const out = join(dir, "sql.rules.md");
		shareMain({ agent: "sql", out });
		const written = readFileSync(out, "utf8");
		expect(written).toContain("Use Grep before reading any file.");
		expect(written).toContain(LEDGER_MARKER);
		expect(logs.join("\n")).toContain("Wrote 1 active sql rule(s)");
	});

	it("notes when there are no active rules to share", () => {
		shareMain({ agent: "backend", out: join(dir, "backend.rules.md") });
		expect(logs.join("\n")).toContain("no active rules yet");
	});
});
