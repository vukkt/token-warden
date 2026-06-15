import { describe, expect, it } from "vitest";
import type { RuleRow } from "../src/db.js";
import {
	formatLedger,
	LEDGER_MARKER,
	parseShareArgs,
	type SharedLedger,
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
