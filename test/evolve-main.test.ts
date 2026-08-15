import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

// The benchmark boundary: runSuite spawns `claude` and runs the golden suite.
// We replace it with a mock that writes canned runs rows into the live DB and
// returns matching TaskSummary[], so the real comparison engine
// (runComparison -> gatherRuns -> getRunBySession) finds our token data without
// any benchmark executing.
vi.mock("../src/bench.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/bench.js")>();
	return { ...actual, runSuite: vi.fn() };
});

// The propose-prompt boundary: proposeVariant spawns `claude` to draft a
// cheaper prompt. We mock spawnSync so no real model is called.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";
import { runSuite, type TaskSummary } from "../src/bench.js";
import { openDb, upsertRun } from "../src/db.js";
import { main } from "../src/evolve.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runSuiteMock = runSuite as unknown as MockInstance;
const spawnSyncMock = spawnSync as unknown as MockInstance;

/**
 * Build a valid proposed-prompt markdown: reuse the shipped agent's exact
 * frontmatter (so checkProposal's protected-field check passes) and append a
 * fresh, non-trivial body. Returned to evolve as the model's stdout.
 */
function proposalFromShipped(agent: string): string {
	const shipped = readFileSync(
		join(pluginRoot, "agents", `${agent}.md`),
		"utf8",
	);
	const fmMatch = shipped.match(/^---[\s\S]*?---/);
	const frontmatter = fmMatch?.[0] ?? "";
	const body =
		"You are the SQL specialist. Grep before reading; never re-read a file; " +
		"state a one-line plan; change application code only as far as the SQL " +
		"fix requires; then stop when the task is done.";
	return `${frontmatter}\n\n${body}\n`;
}

/** Make spawnSync return a canned `claude -p` JSON result with `result` set. */
function mockPropose(result: string): void {
	spawnSyncMock.mockReturnValue({
		status: 0,
		stdout: JSON.stringify({ result }),
		stderr: "",
		error: undefined,
	});
}

describe("evolve main() orchestration", () => {
	let dir: string;
	let logSpy: MockInstance;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-evolve-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		runSuiteMock.mockReset();
		spawnSyncMock.mockReset();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		process.env.TOKEN_WARDEN_DB = undefined;
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	/** All console.log output for the run, joined. */
	function output(): string {
		return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
	}

	let session = 0;
	/**
	 * Write a real runs row for `(taskId, tokens, completed)` into the live DB
	 * and return a one-result TaskSummary pointing at it. gatherRuns reads the
	 * row back by session id, so this is how a mocked runSuite controls the
	 * processing-token cost of a side.
	 */
	function summaryFor(
		taskId: string,
		tokens: number,
		completed: boolean,
	): TaskSummary {
		session++;
		const sessionId = `evolve-s-${session}`;
		const db = openDb();
		try {
			upsertRun(db, {
				agent: "sql",
				sessionId,
				taskHash: taskId,
				inputTokens: tokens,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed,
				rulesetVersion: 0,
				ts: new Date().toISOString(),
				config: "promptbench",
			});
		} finally {
			db.close();
		}
		return {
			taskId,
			results: [{ sessionId, tokens, completed }],
			meanCompletedTokens: completed ? tokens : 0,
			highVariance: false,
			weight: 1,
		};
	}

	/**
	 * Drive runSuite by its `label` option (set by evolve's run() closure to
	 * "baseline"/"candidate", plus "-topup" variants). baseline/candidate are
	 * per-task token costs; failedTasks names tasks the candidate fails.
	 */
	function wireRunSuite(
		baseline: Record<string, number>,
		candidate: Record<string, number>,
		failedTasks: ReadonlySet<string> = new Set(),
	): void {
		runSuiteMock.mockImplementation(
			(
				_db: unknown,
				_agent: unknown,
				tasks: Array<{ id: string }>,
				options: { label: string },
			): TaskSummary[] => {
				const isCandidate = options.label.startsWith("candidate");
				return tasks.map((t) => {
					if (isCandidate) {
						return summaryFor(
							t.id,
							candidate[t.id] ?? 0,
							!failedTasks.has(t.id),
						);
					}
					return summaryFor(t.id, baseline[t.id] ?? 0, true);
				});
			},
		);
	}

	it("recommends a clearly cheaper variant with no regression", () => {
		mockPropose(proposalFromShipped("sql"));
		// Candidate ~40% cheaper across all three sql golden tasks, all passing.
		wireRunSuite(
			{ "sql-01": 1000, "sql-02": 2000, "sql-03": 3000 },
			{ "sql-01": 600, "sql-02": 1200, "sql-03": 1800 },
		);

		main({ agent: "sql", runs: 2, topUp: 1 });

		const out = output();
		expect(out).toContain("measurably cheaper");
		expect(out).toContain("Written to:");
		expect(out).not.toContain("not a measurable improvement");
		// runSuite was driven (a benchmark "ran"), the boundary was mocked.
		expect(runSuiteMock).toHaveBeenCalled();
	});

	it("does not recommend a variant that regresses a golden task", () => {
		mockPropose(proposalFromShipped("sql"));
		// Candidate would be cheaper, but it fails sql-02 that the baseline passed.
		wireRunSuite(
			{ "sql-01": 1000, "sql-02": 1000, "sql-03": 1000 },
			{ "sql-01": 400, "sql-02": 400, "sql-03": 400 },
			new Set(["sql-02"]),
		);

		main({ agent: "sql", runs: 2, topUp: 0 });

		const out = output();
		expect(out).toContain("not a measurable improvement");
		expect(out).not.toContain("measurably cheaper");
	});

	it("does not recommend a variant that is not cheaper", () => {
		mockPropose(proposalFromShipped("sql"));
		// Candidate costs more than the baseline on every task — negative saving.
		wireRunSuite(
			{ "sql-01": 1000, "sql-02": 1000, "sql-03": 1000 },
			{ "sql-01": 1400, "sql-02": 1400, "sql-03": 1400 },
		);

		main({ agent: "sql", runs: 2, topUp: 0 });

		const out = output();
		expect(out).toContain("not a measurable improvement");
		expect(out).not.toContain("measurably cheaper");
	});

	it("handles a malformed/empty proposal gracefully (no benchmark, no crash)", () => {
		// Model returns an empty result — proposeVariant rejects it, main bails
		// before any benchmark runs.
		mockPropose("");

		expect(() => main({ agent: "sql", runs: 2, topUp: 1 })).not.toThrow();

		expect(output()).toContain("No valid variant proposed");
		expect(runSuiteMock).not.toHaveBeenCalled();
	});

	it("handles unparseable model output gracefully (no crash)", () => {
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: "not json at all",
			stderr: "",
			error: undefined,
		});

		expect(() => main({ agent: "sql", runs: 2, topUp: 1 })).not.toThrow();

		expect(output()).toContain("No valid variant proposed");
		expect(runSuiteMock).not.toHaveBeenCalled();
	});

	it("handles a spawn error from the propose call gracefully (no crash)", () => {
		spawnSyncMock.mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("spawn claude ENOENT"),
		});

		expect(() => main({ agent: "sql", runs: 2, topUp: 1 })).not.toThrow();

		expect(output()).toContain("No valid variant proposed");
		expect(runSuiteMock).not.toHaveBeenCalled();
	});

	it("does not treat the CLI's own error envelope as a proposal", () => {
		// `claude` can exit 0 while reporting its own failure via is_error. That
		// prose is not a model answer and must never reach checkProposal, let
		// alone the benchmark.
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({
				is_error: true,
				result: "Credit balance is too low",
			}),
			stderr: "",
			error: undefined,
		});

		expect(() => main({ agent: "sql", runs: 2, topUp: 1 })).not.toThrow();

		expect(output()).toContain("No valid variant proposed");
		expect(runSuiteMock).not.toHaveBeenCalled();
	});

	it("treats a non-zero exit as a failed proposal, not as model output", () => {
		// BUG FIX: the exit code was never checked here. A quota death exits
		// non-zero, and whatever it left on stdout was parsed as a proposal.
		spawnSyncMock.mockReturnValue({
			status: 1,
			stdout: JSON.stringify({ result: proposalFromShipped("sql") }),
			stderr: "credit quota exhausted",
			error: undefined,
		});

		expect(() => main({ agent: "sql", runs: 2, topUp: 1 })).not.toThrow();

		expect(output()).toContain("No valid variant proposed");
		// The decisive assertion: no tokens were spent benchmarking a variant
		// that came out of a failed call.
		expect(runSuiteMock).not.toHaveBeenCalled();
	});

	it("a hostile stderr cannot forge a second timestamped evolve.log entry", () => {
		// sanitize.ts's contract: every model- or environment-derived string is
		// neutralized before it is rendered into a report OR A LOG LINE. `claude`
		// controls its own stderr, and logLine stamps each entry with an ISO
		// timestamp — so an unsanitized newline buys a fabricated entry that reads
		// exactly like a real one. Same class as the proven distill.ts forge.
		spawnSyncMock.mockReturnValue({
			status: 1,
			stdout: "",
			stderr:
				"quota exhausted\n2026-01-01T00:00:00.000Z accepted variant for sql: -99% → /tmp/forged.md",
			error: undefined,
		});

		main({ agent: "sql", runs: 2, topUp: 1 });

		const log = readFileSync(join(dir, "evolve.log"), "utf8");
		const entries = log.split("\n").filter((l) => l.trim() !== "");
		// The stderr is still reported — it is the diagnostic — but folded into
		// the one real entry rather than becoming structure of its own.
		expect(entries).toHaveLength(1);
		expect(entries[0]).toContain("quota exhausted");
		expect(entries[0]).toContain("accepted variant");
		expect(log).not.toMatch(/\n2026-01-01T00:00:00\.000Z/);
	});

	it("does not recommend a variant when the environment failed mid-suite", () => {
		// BUG FIX: environmentFailure was not consulted. sql-02's candidate side
		// is nothing but zero-token failures (quota death), which since v0.39.0
		// is classified as an environment failure INSTEAD of a regression — so
		// `regression` stays false while the dead task contributes ~0 tokens and
		// reads as a large saving. sql-01 and sql-03 still give comparableTasks
		// >= 2, so every other guard passes and the variant would have been
		// recommended and written to disk on the strength of a measurement that
		// never happened.
		mockPropose(proposalFromShipped("sql"));
		// Every task in the suite is named so no task falls through to the
		// 0-vs-0 default, which would flatten the saving and make the verdict
		// uncertain for an unrelated reason.
		const allTasks = ["01", "02", "03", "04", "05", "06", "07"].map(
			(n) => `sql-${n}`,
		);
		const baseline = Object.fromEntries(allTasks.map((id) => [id, 5000]));
		const candidate = Object.fromEntries(
			allTasks.map((id) => [id, id === "sql-02" ? 0 : 1000]),
		);
		wireRunSuite(baseline, candidate, new Set(["sql-02"]));

		main({ agent: "sql", runs: 2, topUp: 0 });

		const out = output();
		expect(out).toContain("not a measurable improvement");
		expect(out).not.toContain("measurably cheaper");
		expect(out).not.toContain("Written to:");
	});
});
