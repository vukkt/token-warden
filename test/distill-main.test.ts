import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";

// Mock the subprocess so no real `claude` binary is ever spawned. The
// distiller calls spawnSync("claude", [...], opts) and reads `.stdout`
// (a JSON string with a `result` field), `.status` and `.error`.
const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSync(...args),
}));

import {
	insertRule,
	listRulesByAgent,
	openDb,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import { distill } from "../src/distill.js";

const mockSpawn = spawnSync as unknown as Mock;

/** A spawnSync return value mimicking a successful headless `claude` call.
 * The distiller does JSON.parse(stdout) and reads `.result`. */
function spawnOk(resultJson: string) {
	return {
		status: 0,
		stdout: JSON.stringify({ result: resultJson }),
		stderr: "",
		error: undefined,
		signal: null,
		pid: 1,
		output: [],
	};
}

let dir: string;
let dbPath: string;
let db: WardenDb;
let transcriptPath: string;

/** Seed an expensive `sql` run plus enough cheap priors that the run lands
 * above the rolling p75 (>= MIN_PRIOR_RUNS priors required). Returns run id. */
function seedExpensiveRun(): number {
	for (let i = 0; i < 6; i++) {
		upsertRun(db, {
			agent: "sql",
			sessionId: `prior-${i}`,
			taskHash: null,
			inputTokens: 100,
			outputTokens: 100,
			cacheCreation: 0,
			cacheRead: 0,
			toolCalls: 1,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 0,
			ts: `2026-01-0${i + 1}T00:00:00.000Z`,
		});
	}
	return upsertRun(db, {
		agent: "sql",
		sessionId: "expensive",
		taskHash: null,
		inputTokens: 500000,
		outputTokens: 500000,
		cacheCreation: 0,
		cacheRead: 0,
		toolCalls: 40,
		fileRereads: 5,
		completed: true,
		rulesetVersion: 0,
		ts: "2026-02-01T00:00:00.000Z",
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-distill-"));
	dbPath = join(dir, "warden.db");
	process.env.TOKEN_WARDEN_DB = dbPath;
	db = openDb(dbPath);
	transcriptPath = join(dir, "transcript.jsonl");
	writeFileSync(
		transcriptPath,
		`${JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
				],
			},
		})}\n`,
	);
	mockSpawn.mockReset();
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
	delete process.env.TOKEN_WARDEN_DB;
});

describe("distill() orchestration", () => {
	it("inserts a candidate rule from a valid model reply", () => {
		const runId = seedExpensiveRun();
		mockSpawn.mockReturnValue(
			spawnOk(
				'[{"body":"Use Grep to locate symbols before reading any file."}]',
			),
		);

		distill({ runId, transcriptPath });

		expect(mockSpawn).toHaveBeenCalledOnce();
		const [cmd, argv] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("claude");
		// Default distill model is sonnet — candidate quality is the loop's bottleneck.
		expect(argv).toContain("sonnet");

		const rules = listRulesByAgent(db, "sql");
		expect(rules).toHaveLength(1);
		expect(rules[0]?.status).toBe("candidate");
		expect(rules[0]?.source_run).toBe(runId);
		expect(rules[0]?.body).toBe(
			"Use Grep to locate symbols before reading any file.",
		);
	});

	it("inserts nothing for an invalid/garbage model reply, never throws", () => {
		const runId = seedExpensiveRun();
		// Not a JSON array of {body} — parseRulesJson returns null, dropped.
		mockSpawn.mockReturnValue(spawnOk("sorry, I cannot help with that"));

		expect(() => distill({ runId, transcriptPath })).not.toThrow();
		expect(mockSpawn).toHaveBeenCalledOnce();
		expect(listRulesByAgent(db, "sql")).toHaveLength(0);
	});

	it("skips when the run was already distilled (alreadyDistilled guard)", () => {
		const runId = seedExpensiveRun();
		// A prior rule already names this run as its source.
		insertRule(db, {
			agent: "sql",
			body: "A pre-existing rule born from this exact run.",
			contextCost: 10,
			sourceRun: runId,
			createdAt: "2026-02-01T00:00:00.000Z",
		});

		distill({ runId, transcriptPath });

		// Guard fires before spawnSync; no new model call, no new rules.
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(listRulesByAgent(db, "sql")).toHaveLength(1);
	});

	it("handles a spawnSync error gracefully (throws, caught by CLI shim)", () => {
		const runId = seedExpensiveRun();
		mockSpawn.mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("spawn claude ENOENT"),
			signal: null,
			pid: 0,
			output: [],
		});

		// distill rethrows claude.error; no rule is inserted before that.
		expect(() => distill({ runId, transcriptPath })).toThrow(/ENOENT/);
		expect(listRulesByAgent(db, "sql")).toHaveLength(0);
	});

	it("skips a run that does not exist without spawning", () => {
		distill({ runId: 9999, transcriptPath });
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("skips an agent with no golden suite", () => {
		const runId = upsertRun(db, {
			agent: "docs",
			sessionId: "no-suite",
			taskHash: null,
			inputTokens: 1,
			outputTokens: 1,
			cacheCreation: 0,
			cacheRead: 0,
			toolCalls: 0,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 0,
			ts: "2026-02-01T00:00:00.000Z",
		});
		distill({ runId, transcriptPath });
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(listRulesByAgent(db, "docs")).toHaveLength(0);
	});

	it("skips a run below the rolling p75 (too few priors / not expensive)", () => {
		// Only one prior, so MIN_PRIOR_RUNS is not met -> shouldDistill false.
		const runId = upsertRun(db, {
			agent: "sql",
			sessionId: "lonely",
			taskHash: null,
			inputTokens: 10,
			outputTokens: 10,
			cacheCreation: 0,
			cacheRead: 0,
			toolCalls: 0,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 0,
			ts: "2026-02-01T00:00:00.000Z",
		});
		distill({ runId, transcriptPath });
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("drops a near-duplicate candidate but still never throws", () => {
		const runId = seedExpensiveRun();
		// Existing rule for the agent; model returns a near-identical body.
		insertRule(db, {
			agent: "sql",
			body: "Use Grep to locate symbols before reading any file.",
			contextCost: 12,
			sourceRun: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		mockSpawn.mockReturnValue(
			spawnOk(
				'[{"body":"Use Grep to locate symbols before reading any files."}]',
			),
		);

		distill({ runId, transcriptPath });

		// Still just the one pre-existing rule: the near-duplicate was skipped.
		expect(listRulesByAgent(db, "sql")).toHaveLength(1);
	});
});
