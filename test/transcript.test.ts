import {
	mkdtempSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTranscript, parseTranscriptFile } from "../src/transcript.js";

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

	it("streaming file parser produces identical results to the string parser", async () => {
		for (const name of [
			"main-session.jsonl",
			"interrupted-session.jsonl",
			"subagent-session.jsonl",
		]) {
			const fromString = parseTranscript(await fixture(name));
			const fromFile = await parseTranscriptFile(join(fixturesDir, name));
			expect(fromFile, name).toEqual(fromString);
		}
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

describe("parseTranscript — toolEvents (attribution raw material)", () => {
	it("records each call's name, input size, and joined result size", () => {
		const lines = [
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Read",
							input: { file_path: "/a" },
						},
					],
				},
			}),
			entry({
				type: "user",
				uuid: "u1",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: "x".repeat(123),
						},
					],
				},
			}),
		].join("\n");
		const events = parseTranscript(lines).toolEvents;
		expect(events).toHaveLength(1);
		expect(events[0]?.name).toBe("Read");
		expect(events[0]?.resultChars).toBe(123);
		expect(events[0]?.inputChars).toBeGreaterThan(0);
		expect(events[0]?.skill).toBeNull();
	});

	it("captures the skill name from a Skill call", () => {
		const lines = entry({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Skill",
						input: { skill: "code-review" },
					},
				],
			},
		});
		expect(parseTranscript(lines).toolEvents[0]?.skill).toBe("code-review");
	});

	it("leaves resultChars at 0 when a call has no matching result", () => {
		const lines = entry({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Bash",
						input: { command: "ls" },
					},
				],
			},
		});
		expect(parseTranscript(lines).toolEvents[0]?.resultChars).toBe(0);
	});

	/**
	 * ARRAY-FORM tool_result content, restored after being lost.
	 *
	 * These two cases were the only coverage of `resultContentChars`'s array
	 * branch, and they lived in test/attribute.test.ts because they happened to
	 * assert through the `/warden-attribute` renderer. That command was removed
	 * in v1.0.0 and its test file went with it -- taking the regression tests
	 * for a live bug fix that has nothing to do with the renderer. The parsing
	 * still runs on every Stop hook and still feeds `tool_costs` and the status
	 * dashboard; only the tests protecting it disappeared.
	 *
	 * Rewritten against `parseTranscript`, the surviving public path, so they
	 * cannot be orphaned again by deleting a consumer.
	 */
	it("sums the text blocks of an array-form tool_result", () => {
		const lines = [
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					content: [{ type: "tool_use", id: "t1", name: "Grep", input: {} }],
				},
			}),
			entry({
				type: "user",
				uuid: "u1",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [
								{ type: "text", text: "abc" },
								{ type: "text", text: "de" },
							],
						},
					],
				},
			}),
		];
		expect(parseTranscript(lines.join("\n")).toolEvents[0]?.resultChars).toBe(
			5,
		);
	});

	/**
	 * The regression from error-ledger entry #4: a bare string, a number, a null
	 * or an image block sitting beside real text must not zero the whole
	 * result's footprint. Parsing the array strictly and catching the failure
	 * would discard every good sibling, which silently corrupted attribution
	 * before it was fixed.
	 */
	it("counts good text blocks even when the result array has odd siblings", () => {
		const lines = [
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					content: [{ type: "tool_use", id: "t1", name: "Grep", input: {} }],
				},
			}),
			entry({
				type: "user",
				uuid: "u1",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [
								{ type: "image", source: { data: "..." } },
								{ type: "text", text: "realtext" },
								12345,
								null,
								"bare string sibling",
							],
						},
					],
				},
			}),
		];
		expect(parseTranscript(lines.join("\n")).toolEvents[0]?.resultChars).toBe(
			8,
		);
	});

	it("counts a result only once even if streamed across entries", () => {
		const resultEntry = entry({
			type: "user",
			uuid: "u1",
			message: {
				content: [{ type: "tool_result", tool_use_id: "t1", content: "abcde" }],
			},
		});
		const lines = [
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					content: [{ type: "tool_use", id: "t1", name: "Grep", input: {} }],
				},
			}),
			resultEntry,
			resultEntry,
		].join("\n");
		expect(parseTranscript(lines).toolEvents[0]?.resultChars).toBe(5);
	});

	it("keeps a tool name verbatim — sanitizing is the renderer's job", () => {
		// The parser is the ingestion boundary, not the display boundary: it
		// must not silently rewrite payloads (that would corrupt attribution
		// keys). Neutralizing escapes happens in displayText at render time.
		const hostile = `Read${String.fromCharCode(0x1b)}[31m\nFAKE`;
		const lines = entry({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				content: [{ type: "tool_use", id: "t1", name: hostile, input: {} }],
			},
		});
		expect(parseTranscript(lines).toolEvents[0]?.name).toBe(hostile);
	});

	it("still records a tool_use that has no id (input only)", () => {
		const lines = entry({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
			},
		});
		const events = parseTranscript(lines).toolEvents;
		expect(events).toHaveLength(1);
		expect(events[0]?.resultChars).toBe(0);
	});
});

/**
 * Totality: a transcript is written by another program and can be truncated,
 * corrupt, or actively hostile. Every case below must produce a ParsedRun —
 * never a throw, since a throw here is a broken user session.
 */
describe("parseTranscript totality (hostile and malformed input)", () => {
	const NUL = String.fromCharCode(0);
	const ESC = String.fromCharCode(0x1b);

	it("counts a truncated final line as malformed and keeps earlier entries", () => {
		const good = entry({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				content: [{ type: "text", text: "ok" }],
				usage: { input_tokens: 11, output_tokens: 2 },
			},
		});
		// No trailing newline, JSON cut mid-object — how a killed process
		// leaves the file.
		const run = parseTranscript(
			`${good}\n{"type":"assistant","message":{"id":"m2","usage":{"input_to`,
		);
		expect(run.malformedLines).toBe(1);
		expect(run.entryCount).toBe(1);
		expect(run.inputTokens).toBe(11);
	});

	it("treats valid JSON of the wrong shape as malformed", () => {
		for (const line of ["[1,2,3]", "42", '"a string"', "null", "true", "{}"]) {
			const run = parseTranscript(line);
			expect(run.malformedLines, line).toBe(1);
			expect(run.entryCount, line).toBe(0);
		}
	});

	it("ignores a usage object of the wrong shape without dropping the entry", () => {
		for (const usage of [[1, 2], "lots", 7, true]) {
			const run = parseTranscript(
				entry({
					type: "assistant",
					uuid: "a1",
					message: { id: "m1", usage, content: [{ type: "text", text: "ok" }] },
				}),
			);
			expect(run.malformedLines, JSON.stringify(usage)).toBe(0);
			expect(run.entryCount, JSON.stringify(usage)).toBe(1);
			expect(run.inputTokens, JSON.stringify(usage)).toBe(0);
			expect(run.completed, JSON.stringify(usage)).toBe(true);
		}
	});

	it("defaults every counter to zero when usage fields are missing or renamed", () => {
		const run = parseTranscript(
			entry({
				type: "assistant",
				uuid: "a1",
				// A future/renamed schema must degrade to zero, never to NaN.
				message: { id: "m1", usage: { inputTokens: 500, outputTokens: 40 } },
			}),
		);
		expect(run).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			cacheCreation: 0,
			cacheRead: 0,
			malformedLines: 0,
		});
	});

	it("rejects negative, fractional, and out-of-range counters as zero", () => {
		const run = parseTranscript(
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					usage: {
						input_tokens: -5,
						output_tokens: 1.5,
						cache_creation_input_tokens: 1e21,
						cache_read_input_tokens: 12,
					},
				},
			}),
		);
		expect(run).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			cacheCreation: 0,
			cacheRead: 12,
		});
	});

	it("keeps the last usage seen for a repeated message id (dedup semantics)", () => {
		// Locked deliberately: Claude Code repeats the same `usage` object on
		// every streamed entry of one API message, and the final entry carries
		// the complete counts. Changing this changes every frozen baseline.
		const run = parseTranscript(
			[
				entry({
					type: "assistant",
					uuid: "a1",
					message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1 } },
				}),
				entry({
					type: "assistant",
					uuid: "a2",
					message: { id: "m1", usage: { input_tokens: 9, output_tokens: 3 } },
				}),
			].join("\n"),
		);
		expect(run.inputTokens).toBe(9);
		expect(run.outputTokens).toBe(3);
	});

	it("survives an enormous single line", () => {
		const huge = entry({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				usage: { input_tokens: 3 },
				content: [{ type: "text", text: "z".repeat(4_000_000) }],
			},
		});
		expect(huge.length).toBeGreaterThan(4_000_000);
		const run = parseTranscript(huge);
		expect(run.entryCount).toBe(1);
		expect(run.inputTokens).toBe(3);
		expect(run.completed).toBe(true);
	});

	it("survives deeply nested JSON without throwing", () => {
		const deep = `{"type":"assistant","uuid":"a1","message":{"id":"m1","content":${"[".repeat(20_000)}${"]".repeat(20_000)}}}`;
		expect(() => parseTranscript(deep)).not.toThrow();
	});

	it("survives raw NUL and escape bytes inside JSON strings", () => {
		const run = parseTranscript(
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					usage: { input_tokens: 4 },
					content: [{ type: "text", text: `a${NUL}b${ESC}[2Jc` }],
				},
			}),
		);
		expect(run.entryCount).toBe(1);
		expect(run.inputTokens).toBe(4);
	});

	it("cannot pollute Object.prototype through a tool input", () => {
		const line = `{"type":"assistant","uuid":"a1","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}}]}}`;
		const run = parseTranscript(line);
		expect(run.toolCalls).toBe(1);
		expect(({} as Record<string, unknown>).polluted ?? null).toBeNull();
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("parses CRLF input identically to LF", () => {
		const lines = [
			entry({ type: "user", uuid: "u1", message: { content: "go" } }),
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					usage: { input_tokens: 6, output_tokens: 2 },
					content: [{ type: "text", text: "done" }],
				},
			}),
		];
		expect(parseTranscript(lines.join("\r\n"))).toEqual(
			parseTranscript(lines.join("\n")),
		);
	});

	it("drops the whole content array when one block is malformed (known limit)", () => {
		// Documented tolerance boundary: content is validated as a unit, so a
		// single wrong-typed block (here a numeric tool_use id) costs the
		// entry's tool calls and text. Token counters are unaffected — usage
		// is parsed independently of content.
		const run = parseTranscript(
			entry({
				type: "assistant",
				uuid: "a1",
				message: {
					id: "m1",
					usage: { input_tokens: 5, output_tokens: 1 },
					content: [
						{ type: "tool_use", id: 5, name: "Bash", input: {} },
						{ type: "text", text: "hi" },
					],
				},
			}),
		);
		expect(run.inputTokens).toBe(5);
		expect(run.toolCalls).toBe(0);
		expect(run.toolEvents).toHaveLength(0);
		expect(run.completed).toBe(false);
		expect(run.malformedLines).toBe(0);
	});
});

describe("parseTranscriptFile IO edges", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-transcript-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const validLine = entry({
		type: "assistant",
		uuid: "a1",
		message: {
			id: "m1",
			usage: { input_tokens: 21, output_tokens: 2 },
			content: [{ type: "text", text: "ok" }],
		},
	});

	function write(name: string, content: string | Uint8Array): string {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	}

	it("returns zeros for an empty file", async () => {
		const run = await parseTranscriptFile(write("empty.jsonl", ""));
		expect(run).toMatchObject({
			entryCount: 0,
			malformedLines: 0,
			inputTokens: 0,
			completed: false,
		});
	});

	it("counts non-UTF8 bytes as malformed without losing the good lines", async () => {
		const bytes = Buffer.concat([
			Buffer.from([0xff, 0xfe, 0x80, 0x9f]),
			Buffer.from("\n", "utf8"),
			Buffer.from(validLine, "utf8"),
			Buffer.from("\n", "utf8"),
		]);
		const run = await parseTranscriptFile(write("binary.jsonl", bytes));
		expect(run.malformedLines).toBe(1);
		expect(run.entryCount).toBe(1);
		expect(run.inputTokens).toBe(21);
	});

	it("follows a symlink to the real transcript", async () => {
		const target = write("real.jsonl", `${validLine}\n`);
		const link = join(dir, "link.jsonl");
		symlinkSync(target, link);
		expect(await parseTranscriptFile(link)).toEqual(
			await parseTranscriptFile(target),
		);
	});

	it("settles either way when the file vanishes mid-read", async () => {
		const path = write(
			"vanishing.jsonl",
			`${Array.from({ length: 5_000 }, () => validLine).join("\n")}\n`,
		);
		const pending = parseTranscriptFile(path);
		unlinkSync(path);
		// Racy by nature: the open may lose to the unlink (ENOENT) or win and
		// keep reading the still-open inode. Both are acceptable; hanging, or
		// resolving with a half-built run that then gets recorded as real
		// token spend, is not. One message id means usage dedupes to a single
		// count however much was read.
		const [outcome] = await Promise.allSettled([pending]);
		if (outcome?.status === "fulfilled") {
			expect(outcome.value.inputTokens).toBe(21);
			expect(outcome.value.entryCount).toBeGreaterThan(0);
		} else {
			expect(outcome?.reason).toBeInstanceOf(Error);
		}
	});

	it("rejects (never hangs) on a missing file", async () => {
		await expect(
			parseTranscriptFile(join(dir, "does-not-exist.jsonl")),
		).rejects.toBeInstanceOf(Error);
	});

	it("rejects (never hangs) when the path is a directory", async () => {
		await expect(parseTranscriptFile(dir)).rejects.toBeInstanceOf(Error);
	});
});
