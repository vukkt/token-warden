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

// The benchmark boundary: select's main() builds a SuiteRunner around
// bench.runSuite. Replacing runSuite lets the whole selection pipeline —
// candidate listing, baseline pass, top-up allocation, verdicts, receipts,
// memory compilation, decision printing — run for real against a temp DB
// while no benchmark spawns.
vi.mock("../src/bench.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/bench.js")>();
	return { ...actual, runSuite: vi.fn() };
});

import { runSuite, type TaskSummary } from "../src/bench.js";
import { decideRule, getRuleById, insertRule, openDb } from "../src/db.js";
import { main, parseSelectArgs } from "../src/select.js";

const runSuiteMock = runSuite as unknown as MockInstance;

describe("parseSelectArgs validation", () => {
	it("rejects unknown flags, bad agents, and out-of-range numbers", () => {
		expect(() => parseSelectArgs(["--bogus"])).toThrow(/unknown flag/);
		expect(() => parseSelectArgs(["--agent", "nope"])).toThrow(/--agent/);
		expect(() => parseSelectArgs(["--agent", "sql", "--runs", "0"])).toThrow(
			/--runs must be a positive integer/,
		);
		expect(() => parseSelectArgs(["--agent", "sql", "--top-up", "-1"])).toThrow(
			/--top-up must be a non-negative integer/,
		);
	});
});

describe("select main() orchestration", () => {
	let dir: string;
	let logSpy: MockInstance;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-select-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		process.env.TOKEN_WARDEN_MEMORY_DIR = join(dir, "agent-memory");
		runSuiteMock.mockReset();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		delete process.env.TOKEN_WARDEN_DB;
		delete process.env.TOKEN_WARDEN_MEMORY_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	/** All console.log output for the run, joined. */
	function output(): string {
		return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
	}

	function insertCandidate(body: string, contextCost = 10): number {
		const db = openDb();
		try {
			return insertRule(db, {
				agent: "sql",
				body,
				contextCost,
				sourceRun: null,
				createdAt: "t",
			});
		} finally {
			db.close();
		}
	}

	/**
	 * Wire runSuite to answer each configuration with a fixed per-run token
	 * sequence (cycled per task). Keys are label prefixes: the active-set
	 * baseline, the candidate/audit first pass, and the "-topup" pass.
	 */
	function wireRunSuite(perLabel: {
		baseline: number[];
		measured: number[];
		topUp?: number[];
	}): void {
		runSuiteMock.mockImplementation(
			(
				_db: unknown,
				_agent: unknown,
				tasks: Array<{ id: string }>,
				options: { runs: number; label: string },
			): TaskSummary[] => {
				const values = options.label.endsWith("-topup")
					? (perLabel.topUp ?? perLabel.measured)
					: options.label === "active-set"
						? perLabel.baseline
						: perLabel.measured;
				return tasks.map((t) => {
					const results = Array.from({ length: options.runs }, (_, i) => ({
						sessionId: `${options.label}-${t.id}-${i}`,
						tokens: values[i % values.length] as number,
						completed: true,
					}));
					const mean = Math.round(
						results.reduce((a, r) => a + r.tokens, 0) / results.length,
					);
					return {
						taskId: t.id,
						results,
						meanCompletedTokens: mean,
						highVariance: false,
					};
				});
			},
		);
	}

	it("does nothing when there are no candidates and nothing to audit", () => {
		main({ agent: "sql", runs: 2, topUp: 1 });

		expect(output()).toContain(
			"No candidates and no active rules to audit; nothing to do.",
		);
		expect(runSuiteMock).not.toHaveBeenCalled();
	});

	it("promotes a candidate that confidently clears the 2x-rent bar", () => {
		const id = insertCandidate("Batch related queries into one statement.");
		// Constant 1000 vs 500: delta=500 per run with zero variance — far past
		// the bar (2× rent of cost 10 ≈ 22) at full confidence.
		wireRunSuite({ baseline: [1000, 1000], measured: [500, 500] });

		main({ agent: "sql", runs: 2, topUp: 1 });

		const out = output();
		expect(out).toContain(`[candidate] rule ${id} → ACTIVE`);
		expect(out).toContain("delta=500");
		expect(out).toContain("Compiled 1 active rule(s)");
		expect(out).toContain("(ruleset v1)");
		const db = openDb();
		try {
			expect(getRuleById(db, id)?.status).toBe("active");
		} finally {
			db.close();
		}
	});

	it("spends the top-up budget on an uncertain candidate, then evicts it", () => {
		const id = insertCandidate("A marginal micro-optimization.");
		// Savings of ~30/run clear the ~22 bar on the point estimate, but the
		// run-to-run noise (baseline 1000/1100) keeps the verdict within z·SE of
		// flipping — so the selector tops up by variance, stays uncertain, and
		// refuses to start paying rent.
		wireRunSuite({
			baseline: [1000, 1100],
			measured: [1000, 1040],
			topUp: [1030, 1010],
		});

		main({ agent: "sql", runs: 2, topUp: 1 });

		const out = output();
		// The top-up pass ran against allocated tasks (label suffix "-topup").
		const labels = runSuiteMock.mock.calls.map(
			(c) => (c[3] as { label: string }).label,
		);
		expect(labels.some((l) => l.endsWith("-topup"))).toBe(true);
		expect(out).toContain(`[candidate] rule ${id} → EVICTED`);
		expect(out).toContain("topped-up");
		expect(out).toContain("LOW-CONFIDENCE");
		const db = openDb();
		try {
			expect(getRuleById(db, id)?.status).toBe("evicted");
		} finally {
			db.close();
		}
	});

	it("puts an active rule on probation at its first sub-threshold re-audit", () => {
		const id = insertCandidate("An old rule that stopped earning.");
		const db = openDb();
		try {
			decideRule(db, id, "active", 100, "earned once", "2026-01-01T00:00:00Z");
		} finally {
			db.close();
		}
		// Suite costs the same with and without the rule: worth 0 now.
		wireRunSuite({ baseline: [1000, 1000], measured: [1000, 1000] });

		main({ agent: "sql", runs: 2, topUp: 0 });

		const out = output();
		expect(out).toContain(`[re-audit] rule ${id} → ACTIVE`);
		expect(out).toContain("PROBATION (strike 1 of 2)");
		const reopened = openDb();
		try {
			const rule = getRuleById(reopened, id);
			expect(rule?.status).toBe("active");
			expect(rule?.probation).toBe(1);
		} finally {
			reopened.close();
		}
	});
});
