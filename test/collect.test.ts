import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAnomaly, isBusyError, withBusyRetry } from "../src/collect.js";
import { getRunBySession, type NewRun, openDb, upsertRun } from "../src/db.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(root, "node_modules", ".bin", "tsx");
const collectScript = join(root, "src", "collect.ts");
const fixturesDir = join(root, "test", "fixtures");

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-collect-"));
	dbPath = join(dir, "warden.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface CollectResult {
	status: number | null;
	stderr: string;
	stdout: string;
}

function runCollect(
	stdin: string,
	extraEnv: Record<string, string> = {},
): CollectResult {
	const result = spawnSync(tsxBin, [collectScript], {
		input: stdin,
		encoding: "utf8",
		env: {
			...process.env,
			TOKEN_WARDEN_DB: dbPath,
			TOKEN_WARDEN_NO_DISTILL: "1",
			...extraEnv,
		},
		timeout: 30_000,
	});
	return {
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

function payload(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		session_id: "collect-test-1",
		transcript_path: join(fixturesDir, "main-session.jsonl"),
		cwd: dir,
		permission_mode: "default",
		hook_event_name: "Stop",
		...overrides,
	});
}

function logContents(): string {
	const logPath = join(dir, "collect.log");
	return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

describe("collect.ts Stop hook", () => {
	it("inserts a runs row from a valid payload and transcript", () => {
		const result = runCollect(payload());
		expect(result.status).toBe(0);
		const db = openDb(dbPath);
		const row = getRunBySession(db, "collect-test-1");
		db.close();
		expect(row).toMatchObject({
			agent: "main",
			input_tokens: 165,
			output_tokens: 105,
			cache_creation: 500,
			cache_read: 8100,
			tool_calls: 3,
			file_rereads: 1,
			completed: 1,
			task_hash: null,
			ruleset_version: 0,
		});
	});

	it("is idempotent: a second Stop for the same session keeps one row", () => {
		expect(runCollect(payload()).status).toBe(0);
		expect(runCollect(payload()).status).toBe(0);
		const db = openDb(dbPath);
		const count = db
			.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs")
			.get();
		db.close();
		expect(count?.n).toBe(1);
	});

	it("records config 'real' and the payload cwd as project", () => {
		runCollect(payload());
		const db = openDb(dbPath);
		const row = getRunBySession(db, "collect-test-1");
		db.close();
		expect(row?.config).toBe("real");
		expect(row?.project).toBe(dir);
	});

	it("SubagentStop: derives the sidechain transcript and records it under a suffixed key", () => {
		// Real layout (verified live): payload carries the PARENT transcript;
		// the subagent's lives at <parent minus .jsonl>/subagents/agent-<id>.jsonl
		const agentId = "a1b2c3d4e5f6789ab";
		const parent = join(dir, "parent.jsonl");
		cpSync(join(fixturesDir, "main-session.jsonl"), parent);
		const sidechainDir = join(dir, "parent", "subagents");
		mkdirSync(sidechainDir, { recursive: true });
		cpSync(
			join(fixturesDir, "subagent-session.jsonl"),
			join(sidechainDir, `agent-${agentId}.jsonl`),
		);

		const result = runCollect(
			payload({
				hook_event_name: "SubagentStop",
				agent_type: "backend",
				agent_id: agentId,
				transcript_path: parent,
			}),
		);
		expect(result.status).toBe(0);
		const db = openDb(dbPath);
		const row = getRunBySession(db, `collect-test-1#${agentId}`);
		expect(row?.agent).toBe("backend");
		// Tokens must come from the SIDECHAIN transcript, not the parent.
		expect(row?.input_tokens).toBe(45);
		expect(getRunBySession(db, "collect-test-1")).toBeUndefined();
		db.close();
	});

	it("SubagentStop: skips (never double-counts) when no sidechain transcript exists", () => {
		const result = runCollect(
			payload({
				hook_event_name: "SubagentStop",
				agent_type: "backend",
				agent_id: "a1b2c3d4e5f6789ab",
			}),
		);
		expect(result.status).toBe(0);
		const db = openDb(dbPath);
		const count = db
			.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs")
			.get();
		db.close();
		expect(count?.n).toBe(0);
		expect(logContents()).toContain("no sidechain transcript");
	});

	it("attributes the run to agent_type when it names a domain agent", () => {
		const result = runCollect(payload({ agent_type: "backend" }));
		expect(result.status).toBe(0);
		const db = openDb(dbPath);
		expect(getRunBySession(db, "collect-test-1")?.agent).toBe("backend");
		db.close();
	});

	it("exits 0 and logs when the transcript file is missing", () => {
		const result = runCollect(
			payload({ transcript_path: join(dir, "nope.jsonl") }),
		);
		expect(result.status).toBe(0);
		const db = openDb(dbPath);
		expect(getRunBySession(db, "collect-test-1")).toBeUndefined();
		db.close();
		expect(logContents()).toContain("collect error");
	});

	it("exits 0 and skips insert on a fully corrupt transcript", () => {
		const corrupt = join(dir, "corrupt.jsonl");
		writeFileSync(corrupt, "\x00garbage\nnot json at all\n{{{{\n");
		const result = runCollect(payload({ transcript_path: corrupt }));
		expect(result.status).toBe(0);
		const db = openDb(dbPath);
		expect(getRunBySession(db, "collect-test-1")).toBeUndefined();
		db.close();
		expect(logContents()).toContain("no parseable conversational entries");
	});

	it("exits 0 on garbage stdin", () => {
		const result = runCollect("this is not a hook payload");
		expect(result.status).toBe(0);
		expect(logContents()).toContain("collect error");
	});
});

/**
 * Fail-open is the hook's headline promise, so it is asserted end to end on
 * the real subprocess: whatever breaks, the exit status is 0 and the reason
 * lands in collect.log. A non-zero exit here is a broken user session.
 */
describe("collect.ts fail-open guarantees", () => {
	it("exits 0 and skips when the transcript path is a directory", () => {
		const asDir = join(dir, "transcript-dir");
		mkdirSync(asDir, { recursive: true });
		const result = runCollect(payload({ transcript_path: asDir }));
		expect(result.status).toBe(0);
		expect(logContents()).toContain("not a regular file");
	});

	it("exits 0 when the database cannot be opened or written", () => {
		// A directory where the DB file should be: every write path fails.
		const blocked = join(dir, "blocked.db");
		mkdirSync(blocked, { recursive: true });
		const result = spawnSync(tsxBin, [collectScript], {
			input: payload(),
			encoding: "utf8",
			env: {
				...process.env,
				TOKEN_WARDEN_DB: blocked,
				TOKEN_WARDEN_NO_DISTILL: "1",
				TOKEN_WARDEN_NO_ALERTS: "1",
			},
			timeout: 30_000,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 without a payload at all (stdin closed immediately)", () => {
		const result = runCollect("");
		expect(result.status).toBe(0);
		expect(logContents()).toContain("collect error");
	});

	it("refuses a FIFO transcript instead of wedging in open()", () => {
		// A FIFO with no writer blocks open() forever. That block is NOT
		// escapable from inside the process — verified: the watchdog timer
		// fires but process.exit() itself then waits on the stuck threadpool
		// thread. The stat() guard is what keeps this fast and exit-0.
		const fifo = join(dir, "wedged.fifo");
		const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
		if (made.status !== 0) return; // no mkfifo here; nothing to assert

		const started = Date.now();
		const result = runCollect(payload({ transcript_path: fifo }));
		expect(result.status).toBe(0);
		expect(Date.now() - started).toBeLessThan(20_000);
		expect(logContents()).toContain("not a regular file");
		const db = openDb(dbPath);
		try {
			expect(getRunBySession(db, "collect-test-1")).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("enforces its own runtime budget and still exits 0", () => {
		// Budget 0 is due before the first poll phase, so the watchdog always
		// wins the race against reading stdin: a deterministic exercise of the
		// abort path the 2s cap uses in production.
		const result = runCollect(payload(), {
			TOKEN_WARDEN_HOOK_BUDGET_MS: "0",
		});
		expect(result.status).toBe(0);
		expect(logContents()).toContain("hook budget of 0ms exceeded");
		const db = openDb(dbPath);
		try {
			expect(getRunBySession(db, "collect-test-1")).toBeUndefined();
		} finally {
			db.close();
		}
	});
});

describe("detectAnomaly", () => {
	it("flags a session at or above the multiple of the recent median", () => {
		const priors = [1000, 1000, 1000, 1000, 1000];
		expect(detectAnomaly(priors, 2000)).toBeCloseTo(2, 5);
		expect(detectAnomaly(priors, 5000)).toBeCloseTo(5, 5);
	});

	it("stays silent below the multiple", () => {
		expect(detectAnomaly([1000, 1000, 1000, 1000, 1000], 1900)).toBeNull();
	});

	it("needs at least five priors", () => {
		expect(detectAnomaly([1000, 1000, 1000, 1000], 9999)).toBeNull();
	});

	it("ignores a zero median", () => {
		expect(detectAnomaly([0, 0, 0, 0, 0], 9999)).toBeNull();
	});
});

describe("collect.ts cost anomaly alert", () => {
	function seedMainPriors(tokensEach: number, count: number): void {
		const db = openDb(dbPath);
		for (let i = 0; i < count; i++) {
			const run: NewRun = {
				agent: "main",
				sessionId: `prior-${i}`,
				taskHash: null,
				inputTokens: tokensEach,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: `2026-06-1${i}T00:00:00Z`,
				config: "real",
			};
			upsertRun(db, run);
		}
		db.close();
	}

	it("emits a systemMessage when a main session is anomalously expensive", () => {
		// main-session fixture totals 8,870 tokens; median of priors is 1,000.
		seedMainPriors(1000, 5);
		const result = runCollect(payload());
		expect(result.status).toBe(0);
		const out = JSON.parse(result.stdout) as { systemMessage?: string };
		expect(out.systemMessage).toContain("token-warden");
		expect(out.systemMessage).toContain("× your recent median");
	});

	it("stays silent with too few priors", () => {
		seedMainPriors(1000, 4);
		const result = runCollect(payload());
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
	});

	it("respects TOKEN_WARDEN_NO_ALERTS", () => {
		seedMainPriors(1000, 5);
		const result = runCollect(payload(), { TOKEN_WARDEN_NO_ALERTS: "1" });
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
	});
});

describe("SQLITE_BUSY handling (silent-data-loss guard)", () => {
	it("recognises contention by code and by message, and nothing else", () => {
		expect(
			isBusyError(Object.assign(new Error("x"), { code: "SQLITE_BUSY" })),
		).toBe(true);
		expect(
			isBusyError(
				Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }),
			),
		).toBe(true);
		// better-sqlite3 reports some lock states with no distinct code.
		expect(isBusyError(new Error("database is locked"))).toBe(true);
		expect(isBusyError(new Error("database table is locked"))).toBe(true);

		// A genuine fault must NOT be retried — retrying it just burns the
		// hook's 2s budget and still fails.
		expect(isBusyError(new Error("no such column: foo"))).toBe(false);
		expect(
			isBusyError(Object.assign(new Error("x"), { code: "SQLITE_CORRUPT" })),
		).toBe(false);
		expect(isBusyError(null)).toBe(false);
		expect(isBusyError("database is locked")).toBe(true);
	});

	it("retries a busy write and succeeds, rather than dropping the session", () => {
		let calls = 0;
		const op = () => {
			calls++;
			if (calls < 3) {
				throw Object.assign(new Error("database is locked"), {
					code: "SQLITE_BUSY",
				});
			}
			return "written";
		};
		return withBusyRetry(op, { attempts: 5, delayMs: () => 0 }).then((got) => {
			expect(got).toBe("written");
			expect(calls).toBe(3);
		});
	});

	it("gives up after the attempt budget and surfaces the busy error", async () => {
		let calls = 0;
		const op = () => {
			calls++;
			throw Object.assign(new Error("database is locked"), {
				code: "SQLITE_BUSY",
			});
		};
		await expect(
			withBusyRetry(op, { attempts: 3, delayMs: () => 0 }),
		).rejects.toThrow(/database is locked/);
		expect(calls).toBe(3);
	});

	it("does NOT retry a non-busy error — it throws on the first attempt", async () => {
		let calls = 0;
		const op = () => {
			calls++;
			throw new Error("no such table: runs");
		};
		await expect(
			withBusyRetry(op, { attempts: 5, delayMs: () => 0 }),
		).rejects.toThrow(/no such table/);
		expect(calls).toBe(1);
	});

	it("returns immediately when the write succeeds first time", async () => {
		let calls = 0;
		const got = await withBusyRetry(
			() => {
				calls++;
				return 42;
			},
			{ attempts: 3, delayMs: () => 0 },
		);
		expect(got).toBe(42);
		expect(calls).toBe(1);
	});
});
