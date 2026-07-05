import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { assessCohorts, cohortStats } from "../src/cohort.js";
import {
	confirmAgent,
	fixtureSide,
	main,
	parseConfirmArgs,
	renderConfirmation,
} from "../src/confirm.js";
import {
	decideRule,
	insertRule,
	openDb,
	type ReceiptRow,
	recordReceipt,
	upsertRun,
	type WardenDb,
} from "../src/db.js";

function receipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
	return {
		rule_id: 1,
		agent: "sql",
		decided_at: "2026-06-01T00:00:00.000Z",
		status: "active",
		kind: "candidate",
		reason: "ok",
		model: "sonnet",
		fixture_hash: "abc",
		runs: 3,
		delta: 3000,
		context_cost: 10,
		standard_error: 500,
		regression: 0,
		with_tokens: 7000,
		without_tokens: 10000,
		with_tool_calls: 5,
		without_tool_calls: 8,
		with_file_rereads: 0,
		without_file_rereads: 1,
		tasks_total: 5,
		tasks_passed_with: 5,
		tasks_passed_without: 5,
		body: "A rule.",
		born_digest: null,
		...overrides,
	};
}

/** A production cohort assessment from synthetic per-session totals. */
function cohortOf(v0: number[], v1: number[] = [], minN = 5) {
	const totals = [
		...v0.map((total) => ({ rulesetVersion: 0, total })),
		...v1.map((total) => ({ rulesetVersion: 1, total })),
	];
	return assessCohorts(cohortStats(totals), minN);
}

const IMPROVED = cohortOf(
	[12000, 12100, 11900, 12050, 11950],
	[8000, 8100, 7900, 8050, 7950],
);
const REGRESSED = cohortOf(
	[8000, 8100, 7900, 8050, 7950],
	[12000, 12100, 11900, 12050, 11950],
);
const NO_CHANGE = cohortOf(
	[10000, 9000, 11000, 10500, 9500],
	[10200, 9200, 10800, 10300, 9700],
);
const INSUFFICIENT = cohortOf([10000, 10000]);

describe("fixtureSide", () => {
	it("sums only active rules' positive deltas and collects regression flags", () => {
		const receipts = [
			receipt({ rule_id: 1, delta: 3000 }),
			receipt({ rule_id: 2, delta: -400, regression: 1 }),
			receipt({ rule_id: 3, delta: 9999, status: "evicted" }),
		];
		const side = fixtureSide(receipts, new Set([1, 2]));
		expect(side.activeRules).toBe(2);
		// Rule 3 is not active; rule 2's negative delta clamps to 0.
		expect(side.expectedSavingsPerRun).toBe(3000);
		expect(side.regressedRules).toEqual([2]);
	});
});

describe("confirmAgent verdict matrix", () => {
	const predicting = fixtureSide([receipt()], new Set([1]));

	it("nothing-to-confirm without active rules", () => {
		const c = confirmAgent("sql", fixtureSide([], new Set()), IMPROVED);
		expect(c.verdict).toBe("nothing-to-confirm");
	});

	it("nothing-to-confirm when active rules predict no savings (protected)", () => {
		const side = fixtureSide([receipt({ delta: null })], new Set([1]));
		const c = confirmAgent("sql", side, IMPROVED);
		expect(c.verdict).toBe("nothing-to-confirm");
		expect(c.reason).toContain("positive measured delta");
	});

	it("corroborated when production confidently improved", () => {
		const c = confirmAgent("sql", predicting, IMPROVED);
		expect(c.verdict).toBe("corroborated");
	});

	it("contradicted when production confidently regressed, recommending re-audit", () => {
		const c = confirmAgent("sql", predicting, REGRESSED);
		expect(c.verdict).toBe("contradicted");
		expect(c.reason).toContain("/warden-select");
		expect(c.reason).toContain("never auto-evicts");
	});

	it("unconfirmed within noise or with insufficient data", () => {
		expect(confirmAgent("sql", predicting, NO_CHANGE).verdict).toBe(
			"unconfirmed",
		);
		expect(confirmAgent("sql", predicting, INSUFFICIENT).verdict).toBe(
			"unconfirmed",
		);
	});

	it("renders the fixture and production sides", () => {
		const out = renderConfirmation(confirmAgent("sql", predicting, IMPROVED));
		expect(out).toContain("out-of-fixture confirmation — sql");
		expect(out).toContain("expected savings ~3,000 tok/run");
		expect(out).toContain("production: IMPROVED");
		expect(out).toContain("verdict: CORROBORATED");
	});
});

describe("parseConfirmArgs", () => {
	it("parses flags and rejects junk", () => {
		expect(parseConfirmArgs([])).toEqual({
			agent: null,
			minN: 5,
			json: false,
			gate: false,
		});
		expect(
			parseConfirmArgs(["--agent", "sql", "--min-n", "3", "--json", "--gate"]),
		).toEqual({ agent: "sql", minN: 3, json: true, gate: true });
		expect(() => parseConfirmArgs(["--agent", "nope"])).toThrow(/--agent/);
		expect(() => parseConfirmArgs(["--min-n", "1"])).toThrow(/--min-n/);
		expect(() => parseConfirmArgs(["--bogus"])).toThrow(/unknown flag/);
	});
});

describe("main (in-process CLI)", () => {
	let dir: string;
	let logSpy: MockInstance;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-confirm-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	function output(): string {
		return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
	}

	/** Seed one active sql rule with a positive receipt plus real-work
	 * sessions at v0 (expensive) and v1 (per `v1Tokens`). */
	function seed(db: WardenDb, v1Tokens: number): void {
		const id = insertRule(db, {
			agent: "sql",
			body: "Batch related queries into one statement.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});
		decideRule(db, id, "active", 3000, "earned", "2026-05-01T00:00:00.000Z");
		recordReceipt(db, {
			ruleId: id,
			agent: "sql",
			decidedAt: "2026-05-01T00:00:00.000Z",
			status: "active",
			kind: "candidate",
			reason: "earned",
			model: "sonnet",
			fixtureHash: "abc",
			runs: 3,
			delta: 3000,
			contextCost: 10,
			standardError: 400,
			regression: false,
			withTokens: 7000,
			withoutTokens: 10000,
			withToolCalls: 5,
			withoutToolCalls: 8,
			withFileRereads: 0,
			withoutFileRereads: 1,
			tasksTotal: 5,
			tasksPassedWith: 5,
			tasksPassedWithout: 5,
		});
		for (let version = 0; version <= 1; version++) {
			for (let i = 0; i < 5; i++) {
				upsertRun(db, {
					agent: "sql",
					sessionId: `real-v${version}-${i}`,
					taskHash: null,
					inputTokens: (version === 0 ? 12000 : v1Tokens) + i * 10,
					outputTokens: 0,
					cacheCreation: 0,
					cacheRead: 0,
					toolCalls: 1,
					fileRereads: 0,
					completed: true,
					rulesetVersion: version,
					ts: `2026-0${5 + version}-0${i + 1}T00:00:00.000Z`,
					config: "real",
				});
			}
		}
	}

	it("reports nothing-to-confirm on an empty db and exits 0 even with --gate", () => {
		expect(main(["--gate"])).toBe(0);
		expect(output()).toContain("NOTHING-TO-CONFIRM");
	});

	it("corroborates when production improved; gate stays green", () => {
		const db = openDb();
		try {
			seed(db, 8000);
		} finally {
			db.close();
		}
		expect(main(["--agent", "sql", "--gate"])).toBe(0);
		expect(output()).toContain("verdict: CORROBORATED");
	});

	it("contradicts when production regressed; --gate exits 1", () => {
		const db = openDb();
		try {
			seed(db, 20000);
		} finally {
			db.close();
		}
		expect(main(["--agent", "sql", "--gate"])).toBe(1);
		const out = output();
		expect(out).toContain("verdict: CONTRADICTED");
		expect(out).toContain("Governance: sql: RE-AUDIT");
	});

	it("emits JSON with --json", () => {
		expect(main(["--agent", "sql", "--json"])).toBe(0);
		const parsed = JSON.parse(output()) as Array<{ verdict: string }>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.verdict).toBe("nothing-to-confirm");
	});
});
