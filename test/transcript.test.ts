import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/transcript.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function fixture(name: string): Promise<string> {
	return readFile(join(fixturesDir, name), "utf8");
}

function entry(overrides: Record<string, unknown>): string {
	return JSON.stringify({
		sessionId: "inline-1",
		isSidechain: false,
		...overrides,
	});
}

describe("parseTranscript on fixtures", () => {
	it("aggregates a normal session, deduplicating usage by message id", async () => {
		const run = parseTranscript(await fixture("main-session.jsonl"));
		// msg_001 appears on two entries with identical usage — counted once.
		expect(run.inputTokens).toBe(100 + 50 + 10 + 5);
		expect(run.outputTokens).toBe(20 + 30 + 15 + 40);
		expect(run.cacheCreation).toBe(500);
		expect(run.cacheRead).toBe(1000 + 2000 + 2500 + 2600);
		expect(run.toolCalls).toBe(3);
		// /repo/src/parser.ts was Read twice; /repo/src/util.ts once.
		expect(run.fileRereads).toBe(1);
		expect(run.completed).toBe(true);
		expect(run.malformedLines).toBe(1);
		expect(run.entryCount).toBe(9);
		expect(run.sessionId).toBe("fix-main-1");
		expect(run.agent).toBe("main");
		expect(run.isSidechain).toBe(false);
		expect(run.agentId).toBeNull();
	});

	it("marks a user-interrupted session as not completed", async () => {
		const run = parseTranscript(await fixture("interrupted-session.jsonl"));
		expect(run.completed).toBe(false);
		expect(run.toolCalls).toBe(1);
		expect(run.inputTokens).toBe(80);
		expect(run.outputTokens).toBe(12);
		expect(run.cacheRead).toBe(900);
	});

	it("detects subagent sidechain context", async () => {
		const run = parseTranscript(await fixture("subagent-session.jsonl"));
		expect(run.isSidechain).toBe(true);
		expect(run.agentId).toBe("a1b2c3d4e5f6789ab");
		// The transcript carries no agent *name*, so attribution defaults to
		// main; callers override from hook payload or bench flags.
		expect(run.agent).toBe("main");
		expect(run.completed).toBe(true);
		expect(run.inputTokens).toBe(45);
		expect(run.outputTokens).toBe(35);
	});
});

describe("parseTranscript edge cases", () => {
	it("returns zeros for empty input", () => {
		const run = parseTranscript("");
		expect(run).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			toolCalls: 0,
			fileRereads: 0,
			completed: false,
			entryCount: 0,
			malformedLines: 0,
			sessionId: null,
			agent: "main",
		});
	});

	it("never throws on garbage and counts every bad line", () => {
		const run = parseTranscript('not json\n{"missing":"type"}\n{broken\n');
		expect(run.malformedLines).toBe(3);
		expect(run.entryCount).toBe(0);
	});

	it("tolerates a UTF-8 BOM before the first line", () => {
		const jsonl = `﻿${entry({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				content: [{ type: "text", text: "ok" }],
				usage: { input_tokens: 7, output_tokens: 2 },
			},
		})}`;
		const run = parseTranscript(jsonl);
		expect(run.malformedLines).toBe(0);
		expect(run.inputTokens).toBe(7);
	});

	it("skips blank lines without counting them as malformed", () => {
		const lines = [
			"",
			entry({
				type: "assistant",
				uuid: "a1",
				message: { id: "m1", content: [{ type: "text", text: "hi" }] },
			}),
			"   ",
			"",
		].join("\n");
		const run = parseTranscript(lines);
		expect(run.malformedLines).toBe(0);
		expect(run.entryCount).toBe(1);
	});

	it("treats a trailing API-error assistant message as incomplete", () => {
		const lines = [
			entry({ type: "user", uuid: "u1", message: { content: "do x" } }),
			entry({
				type: "assistant",
				uuid: "a1",
				isApiErrorMessage: true,
				message: {
					id: "m1",
					content: [{ type: "text", text: "API Error: 529 overloaded" }],
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			}),
		].join("\n");
		const run = parseTranscript(lines);
		expect(run.completed).toBe(false);
		expect(run.inputTokens).toBe(10);
	});

	it("treats a trailing tool_use-only assistant message as incomplete", () => {
		const lines = [
			entry({ type: "user", uuid: "u1", message: { content: "do x" } }),
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
					usage: { input_tokens: 5, output_tokens: 5 },
				},
			}),
		].join("\n");
		expect(parseTranscript(lines).completed).toBe(false);
	});

	it("dedupes repeated tool_use blocks by block id", () => {
		const block = { type: "tool_use", id: "t1", name: "Bash", input: {} };
		const lines = [
			entry({
				type: "assistant",
				uuid: "a1",
				message: { id: "m1", content: [block] },
			}),
			entry({
				type: "assistant",
				uuid: "a2",
				message: { id: "m1", content: [block] },
			}),
		].join("\n");
		expect(parseTranscript(lines).toolCalls).toBe(1);
	});

	it("falls back to requestId/uuid for usage dedup when message id is absent", () => {
		const usage = { input_tokens: 7, output_tokens: 3 };
		const lines = [
			entry({
				type: "assistant",
				uuid: "a1",
				requestId: "r1",
				message: { usage },
			}),
			entry({
				type: "assistant",
				uuid: "a2",
				requestId: "r1",
				message: { usage },
			}),
			entry({ type: "assistant", uuid: "a3", message: { usage } }),
		].join("\n");
		// r1 counted once, the uuid-only entry counted once.
		expect(parseTranscript(lines).inputTokens).toBe(14);
	});

	it("defaults missing or malformed usage counters to zero", () => {
		const lines = [
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					content: [{ type: "text", text: "ok" }],
					usage: {
						input_tokens: 9,
						output_tokens: null,
						cache_read_input_tokens: "bad",
					},
				},
			}),
		].join("\n");
		const run = parseTranscript(lines);
		expect(run.inputTokens).toBe(9);
		expect(run.outputTokens).toBe(0);
		expect(run.cacheRead).toBe(0);
		expect(run.malformedLines).toBe(0);
	});

	it("counts each distinct re-read file once, regardless of extra reads", () => {
		const read = (id: string, file: string) =>
			entry({
				type: "assistant",
				uuid: id,
				message: {
					id,
					content: [
						{
							type: "tool_use",
							id: `t-${id}`,
							name: "Read",
							input: { file_path: file },
						},
					],
				},
			});
		const lines = [
			read("a1", "/a.ts"),
			read("a2", "/a.ts"),
			read("a3", "/a.ts"),
			read("a4", "/b.ts"),
			read("a5", "/b.ts"),
			read("a6", "/c.ts"),
		].join("\n");
		expect(parseTranscript(lines).fileRereads).toBe(2);
	});

	it("uses agentName when the transcript provides one", () => {
		const lines = [
			entry({
				type: "assistant",
				uuid: "a1",
				agentName: "backend",
				message: { id: "m1", content: [{ type: "text", text: "ok" }] },
			}),
		].join("\n");
		expect(parseTranscript(lines).agent).toBe("backend");
	});

	it("parses a 5MB transcript well under the 2s hook budget", async () => {
		const line = (await fixture("main-session.jsonl")).split("\n")[2] ?? "";
		const big = Array.from(
			{ length: Math.ceil(5_000_000 / line.length) },
			() => line,
		).join("\n");
		expect(big.length).toBeGreaterThan(5_000_000);
		const start = performance.now();
		const run = parseTranscript(big);
		const elapsed = performance.now() - start;
		expect(run.entryCount).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(2000);
	});
});
