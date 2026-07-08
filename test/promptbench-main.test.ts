import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Mock the suite boundary so no real `claude` ever spawns. The stubbed
// runSuite writes real `runs` rows into the live temp DB (via upsertRun) and
// returns TaskSummary[] whose results.sessionId reference those rows, exactly
// as the comparison engine (gatherRuns -> getRunBySession) expects. The REAL
// parseAgentDefinition / loadAgentDefinition / loadGoldenTasks are kept so
// main() genuinely reads the variant file and the shipped sql suite.
vi.mock("../src/bench.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/bench.js")>();
	return { ...actual, runSuite: vi.fn() };
});

import type { SuiteOptions, TaskSummary } from "../src/bench.js";
import { runSuite } from "../src/bench.js";
import { openDb, upsertRun, type WardenDb } from "../src/db.js";
import { main } from "../src/promptbench.js";

const runSuiteMock = runSuite as unknown as MockInstance<typeof runSuite>;

/** Per-task token plan: taskId -> [baselineTokens, candidateTokens, candidateCompleted]. */
type Plan = Record<string, [base: number, cand: number, candDone?: boolean]>;

let session = 0;

/**
 * Build a stubbed runSuite that, for each task, writes a runs row to the live
 * DB and returns a TaskSummary referencing it by sessionId. Candidate passes
 * are identified by options.definitionOverride being set (main() runs the
 * variant with the override; the baseline without).
 */
function stubRunSuite(plan: Plan): typeof runSuite {
	return ((
		db: WardenDb,
		agent: string,
		tasks: { id: string }[],
		options: SuiteOptions,
	): TaskSummary[] => {
		const isCandidate = options.definitionOverride !== undefined;
		return tasks.map((task) => {
			const entry = plan[task.id] ?? [1000, 1000];
			const tokens = isCandidate ? entry[1] : entry[0];
			const completed = isCandidate ? (entry[2] ?? true) : true;
			session++;
			const sessionId = `s-${session}`;
			upsertRun(db, {
				agent,
				sessionId,
				taskHash: task.id,
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
			return {
				taskId: task.id,
				results: [{ sessionId, tokens, completed }],
				meanCompletedTokens: completed ? tokens : 0,
				highVariance: false,
				weight: 1,
			};
		});
	}) as unknown as typeof runSuite;
}

const VARIANT_MD = [
	"---",
	"name: sql",
	"description: SQL specialist variant.",
	"tools: Read, Grep, Glob, Edit, Write, Bash",
	"model: haiku",
	"memory: user",
	"---",
	"",
	"You are a leaner SQL specialist. Be terse.",
	"",
].join("\n");

describe("promptbench main() orchestration", () => {
	let dir: string;
	let variantPath: string;
	let logSpy: MockInstance<typeof console.log>;
	const prevDb = process.env.TOKEN_WARDEN_DB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-promptbench-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		variantPath = join(dir, "variant.md");
		writeFileSync(variantPath, VARIANT_MD, "utf8");
		// Seed ruleset/version state so getActiveRules / getRulesetVersion work
		// against a real, migrated DB.
		const seed = openDb();
		seed.close();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		runSuiteMock.mockReset();
	});

	afterEach(() => {
		logSpy.mockRestore();
		if (prevDb === undefined) delete process.env.TOKEN_WARDEN_DB;
		else process.env.TOKEN_WARDEN_DB = prevDb;
		rmSync(dir, { recursive: true, force: true });
	});

	const verdict = (): string =>
		logSpy.mock.calls.map((c) => String(c[0])).join("\n");

	const baseArgs = () => ({
		agent: "sql",
		variant: variantPath,
		runs: 1,
		topUp: 0,
		task: null,
	});

	it("reports a win when the variant is clearly cheaper with no regression", () => {
		runSuiteMock.mockImplementation(
			stubRunSuite({
				"sql-01": [3000, 1000],
				"sql-02": [3000, 1000],
				"sql-03": [3000, 1000],
			}),
		);

		main(baseArgs());

		const out = verdict();
		expect(runSuiteMock).toHaveBeenCalled();
		expect(out).toContain("Prompt-bench agent=sql");
		// Model held constant at the agent's shipped model (sonnet), NOT the
		// variant's haiku.
		expect(out).toContain("model sonnet");
		expect(out).toContain("cheaper for this workload");
	});

	it("flags an unsafe change when the variant regresses a task", () => {
		runSuiteMock.mockImplementation(
			stubRunSuite({
				// Variant is cheaper on tokens but FAILS sql-02 that the baseline
				// completed → must be reported unsafe regardless of tokens.
				"sql-01": [3000, 1000],
				"sql-02": [3000, 1000, false],
				"sql-03": [3000, 1000],
			}),
		);

		main(baseArgs());

		const out = verdict();
		expect(out).toContain("NOT a safe prompt change");
	});

	it("reports within-noise when the two prompts are indistinguishable", () => {
		runSuiteMock.mockImplementation(
			stubRunSuite({
				"sql-01": [1000, 1010],
				"sql-02": [1000, 980],
				"sql-03": [1000, 1030],
			}),
		);

		// topUp 0 so no second pass; the first verdict stands.
		main(baseArgs());

		const out = verdict();
		expect(out).toContain("within measurement noise");
	});

	it("restricts the suite to a single task via --task", () => {
		runSuiteMock.mockImplementation(stubRunSuite({ "sql-01": [3000, 1000] }));

		main({ ...baseArgs(), task: "sql-01" });

		// runSuite was handed exactly the one filtered task.
		const tasksArg = runSuiteMock.mock.calls[0]?.[2] as { id: string }[];
		expect(tasksArg.map((t) => t.id)).toEqual(["sql-01"]);
	});

	it("throws when --task names an unknown task id", () => {
		runSuiteMock.mockImplementation(stubRunSuite({}));
		expect(() => main({ ...baseArgs(), task: "sql-99" })).toThrow(
			/no task with id sql-99/,
		);
	});

	it("throws when the variant file does not exist", () => {
		expect(() =>
			main({ ...baseArgs(), variant: join(dir, "nope.md") }),
		).toThrow(/variant file not found/);
	});
});
