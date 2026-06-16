import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The detached distiller must never really spawn during a unit test. Mock the
// whole module to a no-op whose return value still answers `.unref()`. The
// factory is hoisted above imports, so the mock fn is declared via vi.hoisted.
const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(() => ({ unref: vi.fn() })),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { main } from "../src/collect.js";
import { getRunBySession, openDb, upsertRun } from "../src/db.js";

const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");

let dir: string;
let dbPath: string;

/** Replace process.stdin with a Readable that yields the given payload string,
 * exactly as the real Stop hook feeds main() through readStdin(). */
function feedStdin(text: string): void {
	const fake = Readable.from([Buffer.from(text)]);
	Object.defineProperty(process, "stdin", { value: fake, configurable: true });
}

/** A minimal but realistic main-agent transcript: two assistant messages with
 * usage, two Read tool calls (one re-read), ending on assistant text so the
 * run is "completed". Returns the absolute path it was written to. */
function writeTranscript(name: string, lines: string[]): string {
	const path = join(dir, name);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

const ASSISTANT_USAGE = (
	id: string,
	tokens: { input: number; cacheRead: number },
	content: unknown[],
): string =>
	JSON.stringify({
		type: "assistant",
		uuid: `a-${id}`,
		requestId: `req-${id}`,
		sessionId: "s",
		isSidechain: false,
		message: {
			id: `msg-${id}`,
			role: "assistant",
			content,
			usage: {
				input_tokens: tokens.input,
				output_tokens: 10,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: tokens.cacheRead,
			},
		},
	});

function mainTranscriptLines(): string[] {
	return [
		JSON.stringify({
			type: "user",
			uuid: "u1",
			sessionId: "s",
			isSidechain: false,
			message: { role: "user", content: "do the thing" },
		}),
		ASSISTANT_USAGE("1", { input: 100, cacheRead: 200 }, [
			{
				type: "tool_use",
				id: "tu1",
				name: "Read",
				input: { file_path: "/a.ts" },
			},
		]),
		ASSISTANT_USAGE("2", { input: 50, cacheRead: 100 }, [
			{
				type: "tool_use",
				id: "tu2",
				name: "Read",
				input: { file_path: "/a.ts" },
			},
		]),
		ASSISTANT_USAGE("3", { input: 0, cacheRead: 0 }, [
			{ type: "text", text: "Done." },
		]),
	];
}

function payload(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		session_id: "main-test-1",
		transcript_path: writeTranscript("t.jsonl", mainTranscriptLines()),
		cwd: dir,
		hook_event_name: "Stop",
		...overrides,
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-collect-main-"));
	dbPath = join(dir, "warden.db");
	process.env.TOKEN_WARDEN_DB = dbPath;
	process.env.TOKEN_WARDEN_NO_DISTILL = "1";
	process.env.TOKEN_WARDEN_NO_ALERTS = "1";
	spawnMock.mockClear();
});

afterEach(() => {
	if (realStdin) Object.defineProperty(process, "stdin", realStdin);
	delete process.env.TOKEN_WARDEN_DB;
	delete process.env.TOKEN_WARDEN_NO_DISTILL;
	delete process.env.TOKEN_WARDEN_NO_ALERTS;
	delete process.env.TOKEN_WARDEN_TEST;
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("collect main() in-process", () => {
	it("upserts one runs row and records tool costs from a valid Stop payload", async () => {
		feedStdin(payload());
		await main();

		const db = openDb(dbPath);
		try {
			const row = getRunBySession(db, "main-test-1");
			expect(row).toMatchObject({
				agent: "main",
				session_id: "main-test-1",
				input_tokens: 150,
				cache_read: 300,
				tool_calls: 2,
				file_rereads: 1,
				completed: 1,
				config: "real",
				project: dir,
			});
			const runCount = db
				.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs")
				.get();
			expect(runCount?.n).toBe(1);
			// Tool costs were attributed for this run (two Read calls → Read group).
			const costs = db
				.prepare<[number], { n: number; calls: number }>(
					"SELECT COUNT(*) AS n, COALESCE(SUM(calls),0) AS calls FROM tool_costs WHERE run_id = ?",
				)
				.get(row?.id ?? -1);
			expect(costs?.n).toBeGreaterThan(0);
			expect(costs?.calls).toBe(2);
		} finally {
			db.close();
		}
	});

	it("fails open on malformed stdin JSON: main rejects and no row is written", async () => {
		// Garbage written as \xNN escapes so the source carries no raw bytes.
		feedStdin("\x7fnot a hook payload\x00{{{");
		// main() itself throws (JSON.parse) — the CLI shim's try/catch is what
		// turns this into an exit-0 fail-open. We assert the rejection here and
		// that DB state stays clean, matching the fail-open contract.
		await expect(main()).rejects.toBeInstanceOf(Error);

		const db = openDb(dbPath);
		try {
			const count = db
				.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs")
				.get();
			expect(count?.n).toBe(0);
		} finally {
			db.close();
		}
	});

	it("skips (no row) when the transcript has zero parseable entries", async () => {
		const empty = writeTranscript("empty.jsonl", [
			"\x00garbage",
			"not json at all",
			"{{{{",
		]);
		feedStdin(payload({ transcript_path: empty }));
		// Zero parseable entries returns early (no throw).
		await expect(main()).resolves.toBeUndefined();

		const db = openDb(dbPath);
		try {
			expect(getRunBySession(db, "main-test-1")).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("does not spawn the distiller for a non-domain (main) agent", async () => {
		delete process.env.TOKEN_WARDEN_NO_DISTILL;
		feedStdin(payload());
		await main();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("spawns the detached distiller for a domain agent above its p75", async () => {
		delete process.env.TOKEN_WARDEN_NO_DISTILL;
		// Five cheap prior real-work backend runs → p75 is low; the current
		// session (480 tokens) clears it and is a domain agent → spawn fires.
		const db = openDb(dbPath);
		for (let i = 0; i < 5; i++) {
			upsertRun(db, {
				agent: "backend",
				sessionId: `b-${i}`,
				taskHash: null,
				inputTokens: 1,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: `2026-06-1${i}T00:00:00Z`,
				config: "real",
			});
		}
		db.close();

		feedStdin(payload({ agent_type: "backend" }));
		await main();

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [
			string,
			string[],
			{ detached?: boolean },
		];
		expect(cmd).toBe("npx");
		expect(args).toContain("--run");
		expect(opts.detached).toBe(true);
	});

	it("SubagentStop: derives the sidechain transcript and records it under a suffixed key", async () => {
		const agentId = "a1b2c3d4e5f6789ab";
		const parent = writeTranscript("parent.jsonl", mainTranscriptLines());
		// Sidechain lives at <parent minus .jsonl>/subagents/agent-<id>.jsonl.
		const sidechainDir = join(dir, "parent", "subagents");
		mkdirSync(sidechainDir, { recursive: true });
		const sideLines = [
			JSON.stringify({
				type: "user",
				uuid: "su1",
				sessionId: "s",
				isSidechain: true,
				agentId,
				agentName: "backend",
				message: { role: "user", content: "subtask" },
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "sa1",
				requestId: "sreq",
				sessionId: "s",
				isSidechain: true,
				agentId,
				agentName: "backend",
				message: {
					id: "smsg",
					role: "assistant",
					content: [{ type: "text", text: "subagent done" }],
					usage: {
						input_tokens: 45,
						output_tokens: 5,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				},
			}),
		];
		writeFileSync(
			join(sidechainDir, `agent-${agentId}.jsonl`),
			`${sideLines.join("\n")}\n`,
		);

		feedStdin(
			payload({
				hook_event_name: "SubagentStop",
				agent_type: "backend",
				agent_id: agentId,
				transcript_path: parent,
			}),
		);
		await main();

		const db = openDb(dbPath);
		try {
			const row = getRunBySession(db, `main-test-1#${agentId}`);
			expect(row?.agent).toBe("backend");
			// Tokens come from the SIDECHAIN, not the parent (which has 150 input).
			expect(row?.input_tokens).toBe(45);
			expect(getRunBySession(db, "main-test-1")).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("SubagentStop: skips (no double-count) when the sidechain transcript is missing", async () => {
		feedStdin(
			payload({
				hook_event_name: "SubagentStop",
				agent_type: "backend",
				agent_id: "a1b2c3d4e5f6789ab",
			}),
		);
		// Early return, no throw, no row.
		await expect(main()).resolves.toBeUndefined();

		const db = openDb(dbPath);
		try {
			const count = db
				.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs")
				.get();
			expect(count?.n).toBe(0);
		} finally {
			db.close();
		}
	});

	it("emits a systemMessage anomaly alert when a main session is >=2x the recent median", async () => {
		delete process.env.TOKEN_WARDEN_NO_ALERTS;
		// Seed >=5 prior main runs each ~225 tokens; median 225, current 460 → ~2x.
		const db = openDb(dbPath);
		for (let i = 0; i < 6; i++) {
			upsertRun(db, {
				agent: "main",
				sessionId: `prior-${i}`,
				taskHash: null,
				inputTokens: 225,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: `2026-06-1${i}T00:00:00Z`,
				config: "real",
			});
		}
		db.close();

		// This transcript totals 480 tokens (160 input + 30 output + 0 + 290
		// cacheRead), comfortably >= 2x the 225 median.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		feedStdin(payload());
		await main();

		expect(logSpy).toHaveBeenCalledTimes(1);
		const printed = logSpy.mock.calls[0]?.[0] as string;
		const parsed = JSON.parse(printed) as { systemMessage?: string };
		expect(parsed.systemMessage).toContain("token-warden");
		expect(parsed.systemMessage).toContain("recent median");
	});

	it("stays silent (no systemMessage) when NO_ALERTS is set even above the median", async () => {
		// NO_ALERTS stays "1" from beforeEach.
		const db = openDb(dbPath);
		for (let i = 0; i < 6; i++) {
			upsertRun(db, {
				agent: "main",
				sessionId: `q-${i}`,
				taskHash: null,
				inputTokens: 10,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: `2026-06-1${i}T00:00:00Z`,
				config: "real",
			});
		}
		db.close();

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		feedStdin(payload());
		await main();
		expect(logSpy).not.toHaveBeenCalled();
	});
});
