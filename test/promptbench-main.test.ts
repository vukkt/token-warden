import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { agentDefinitionName, main } from "../src/promptbench.js";

const runSuiteMock = runSuite as unknown as MockInstance<typeof runSuite>;

/** Per-task token plan: taskId -> [baselineTokens, candidateTokens, candidateCompleted]. */
type Plan = Record<string, [base: number, cand: number, candDone?: boolean]>;

let session = 0;

/**
 * Build a stubbed runSuite that, for each task, writes a runs row to the live
 * DB and returns a TaskSummary referencing it by sessionId. Candidate passes
 * are identified by the pass label ("candidate", "candidate-topup"): BOTH arms
 * now pin their definition via definitionOverride (the baseline's is read from
 * disk once in main(), so it cannot drift between passes), so the presence of
 * an override no longer distinguishes the sides.
 */
function stubRunSuite(plan: Plan): typeof runSuite {
	return ((
		db: WardenDb,
		agent: string,
		tasks: { id: string }[],
		options: SuiteOptions,
	): TaskSummary[] => {
		const isCandidate = options.label.startsWith("candidate");
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

	// ---- CONTROL ARM: the two sides must differ in exactly one variable ----

	it("varies ONLY the prompt: model, rules, ruleset version and suite are bit-identical across arms", () => {
		runSuiteMock.mockImplementation(
			stubRunSuite({
				"sql-01": [1000, 1010],
				"sql-02": [1000, 980],
				"sql-03": [1000, 1030],
			}),
		);

		// topUp 1 + a within-noise plan so the top-up passes run too: drift that
		// only appears on the second pass is exactly the kind an A/B hides.
		main({ ...baseArgs(), topUp: 1 });

		const calls = runSuiteMock.mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const opts = calls.map((c) => c[3] as SuiteOptions);
		const first = opts[0] as SuiteOptions;
		for (const o of opts) {
			expect(o.model).toBe(first.model);
			expect(o.rules).toBe(first.rules);
			expect(o.rulesetVersion).toBe(first.rulesetVersion);
			expect(o.runs).toBe(first.runs);
			expect(o.config).toBe("promptbench");
			// Neither arm may write baselines: run1/best describe the active set.
			expect(o.recordBaselines).toBe(false);
		}
		// The suite object itself is shared by reference, so no per-arm filtering
		// or reordering can diverge.
		for (const c of calls) expect(c[2]).toBe(calls[0]?.[2]);

		// The single varied dimension: exactly two distinct prompt bodies, and
		// each arm uses the SAME object on its initial and its top-up pass.
		const byLabel = new Map<string, string>();
		for (const o of opts) {
			const body = o.definitionOverride?.content;
			expect(body).toBeDefined();
			byLabel.set(o.label, body as string);
		}
		expect(byLabel.get("baseline")).toBe(byLabel.get("baseline-topup"));
		expect(byLabel.get("candidate")).toBe(byLabel.get("candidate-topup"));
		expect(byLabel.get("baseline")).not.toBe(byLabel.get("candidate"));
	});

	it("pins the baseline prompt so a mid-benchmark edit of the agent file cannot become a second variable", () => {
		runSuiteMock.mockImplementation(
			stubRunSuite({
				"sql-01": [1000, 1010],
				"sql-02": [1000, 980],
				"sql-03": [1000, 1030],
			}),
		);

		main({ ...baseArgs(), topUp: 1 });

		const opts = runSuiteMock.mock.calls.map((c) => c[3] as SuiteOptions);
		const baselinePasses = opts.filter((o) => o.label.startsWith("baseline"));
		expect(baselinePasses.length).toBe(2);
		// Same object identity, not merely equal content: it was read once.
		expect(baselinePasses[0]?.definitionOverride).toBe(
			baselinePasses[1]?.definitionOverride,
		);
	});

	it("holds the model constant even when the variant names a different one", () => {
		// VARIANT_MD says `model: haiku`; the sql agent ships `model: sonnet`.
		runSuiteMock.mockImplementation(stubRunSuite({ "sql-01": [3000, 1000] }));

		main({ ...baseArgs(), task: "sql-01" });

		const opts = runSuiteMock.mock.calls.map((c) => c[3] as SuiteOptions);
		expect(opts.every((o) => o.model === "sonnet")).toBe(true);
	});

	it("WARNS when the variant renames the agent — that confound reads out as a false regression", () => {
		const renamed = join(dir, "renamed.md");
		writeFileSync(renamed, VARIANT_MD.replace("name: sql", "name: sql-lean"));
		runSuiteMock.mockImplementation(stubRunSuite({ "sql-01": [3000, 1000] }));

		main({ ...baseArgs(), variant: renamed, task: "sql-01" });

		const out = verdict();
		expect(out).toContain('declares "name: sql-lean"');
		expect(out).toContain("REGRESSION");
	});

	it("tolerates identical arms — an A/A run of the shipped prompt against itself", () => {
		// A/A is a legitimate use: it measures the suite's own noise floor rather
		// than a prompt. promptbench must accept it (unlike modelbench, which
		// rejects a model compared against itself) and must not manufacture a
		// winner or a regression out of it.
		//
		// KNOWN DEFECT, reported not fixed (it lives in compare.ts/select.ts,
		// which this agent does not own): on an EXACT tie the verdict cascade
		// reads `uncertain` as |delta| < standardError, and 0 < 0 is false, so a
		// zero-delta zero-variance A/A falls through to the final branch and is
		// announced as "more expensive for this workload" at 0.0%. The wording is
		// therefore deliberately not asserted here, so whichever way it is fixed
		// this test keeps passing.
		const same = join(dir, "same.md");
		writeFileSync(
			same,
			readFileSync(join(process.cwd(), "agents", "sql.md"), "utf8"),
		);
		runSuiteMock.mockImplementation(
			stubRunSuite({
				"sql-01": [1000, 1000],
				"sql-02": [1000, 1000],
				"sql-03": [1000, 1000],
			}),
		);

		main({ ...baseArgs(), variant: same });

		const out = verdict();
		expect(out).toContain("Prompt comparison — sql");
		// No side "won", and identical prompts are never a regression.
		expect(out).toContain("0.0%");
		expect(out).not.toContain("cheaper for this workload");
		expect(out).not.toContain("NOT a safe");
		// Both arms compiled the same prompt body — the A/A is genuinely an A/A.
		const opts = runSuiteMock.mock.calls.map((c) => c[3] as SuiteOptions);
		const bodies = new Set(opts.map((o) => o.definitionOverride?.content));
		expect(bodies.size).toBe(1);
	});

	it("does not warn when the variant keeps the agent name", () => {
		runSuiteMock.mockImplementation(stubRunSuite({ "sql-01": [3000, 1000] }));
		main({ ...baseArgs(), task: "sql-01" });
		expect(verdict()).not.toContain('declares "name:');
	});
});

describe("agentDefinitionName", () => {
	it("reads the name frontmatter field, or null when absent", () => {
		expect(agentDefinitionName("---\nname: sql\nmemory: user\n---\nb")).toBe(
			"sql",
		);
		expect(agentDefinitionName("---\nmemory: user\n---\nb")).toBeNull();
		// Must not match a `name:` that is only mentioned in the prose body.
		expect(agentDefinitionName("---\nmemory: user\n---\nUse name: bob")).toBe(
			null,
		);
	});
});
