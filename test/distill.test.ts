import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRow } from "../src/db.js";
import { openDb, upsertRun, type WardenDb } from "../src/db.js";
import {
	buildPrompt,
	contextCost,
	p75,
	parseDistillArgs,
	parseRulesJson,
	shouldDistill,
	trigramSimilarity,
} from "../src/distill.js";
import { digestTranscript } from "../src/transcript.js";

describe("buildPrompt", () => {
	const run = {
		id: 1,
		agent: "sql",
		session_id: "s",
		task_hash: null,
		input_tokens: 30_000,
		output_tokens: 0,
		cache_creation: 0,
		cache_read: 0,
		tool_calls: 12,
		file_rereads: 3,
		completed: 1,
		ruleset_version: 0,
		ts: "t",
		config: "real",
		project: "/p",
		model: null,
	} as unknown as RunRow;

	it("forbids false-economy rules (the burn's rule-3 lesson)", () => {
		const prompt = buildPrompt(run, "USER: do x\nTOOL Bash {}", []);
		// A rule that trades completion/thoroughness for tokens must be ruled out.
		expect(prompt).toMatch(/SAME-RESULT/);
		expect(prompt).toMatch(
			/skipping steps|trading thoroughness|cutting verification/,
		);
	});

	it("includes the waste stats and the action trace", () => {
		const prompt = buildPrompt(run, "TOOL Read {}", []);
		expect(prompt).toContain("total tokens processed: 30000");
		expect(prompt).toContain("TOOL Read");
	});

	it("feeds banked rules back in, telling the model not to repeat them", () => {
		const prompt = buildPrompt(
			run,
			"TOOL Read {}",
			[],
			[
				"Grep before reading whole files.",
				"State a one-line plan before editing.",
			],
		);
		expect(prompt).toMatch(/ALREADY follows these proven/);
		expect(prompt).toMatch(/do NOT repeat/i);
		expect(prompt).toContain("- Grep before reading whole files.");
		expect(prompt).toContain("- State a one-line plan before editing.");
	});

	it("omits the proven-rules section when the agent has none yet", () => {
		expect(buildPrompt(run, "TOOL Read {}", [], [])).not.toMatch(
			/ALREADY follows these proven/,
		);
	});

	it("feeds evicted rules back with their measured verdicts", () => {
		const prompt = buildPrompt(
			run,
			"TOOL Read {}",
			[],
			[],
			[
				{
					body: "Cache table schemas in memory.",
					measured_delta: 12,
					decided_reason:
						"sub-threshold: savings 12 < 2× cache-aware rent (18)",
				},
				{
					body: "Skip re-running tests after trivial edits.",
					measured_delta: null,
					decided_reason: "regression: a previously passing golden task failed",
				},
			],
		);
		expect(prompt).toMatch(/MEASURED on the benchmark, and REJECTED/);
		expect(prompt).toContain(
			'- "Cache table schemas in memory." -> rejected: sub-threshold: savings 12 < 2× cache-aware rent (18) (measured 12 tokens/run)',
		);
		// Null delta omits the measured suffix instead of printing "null".
		expect(prompt).toContain(
			'- "Skip re-running tests after trivial edits." -> rejected: regression: a previously passing golden task failed',
		);
		expect(prompt).not.toContain("measured null");
	});

	it("bounds evicted feedback to 8 entries and omits the section when empty", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({
			body: `Evicted rule number ${i}.`,
			measured_delta: i,
			decided_reason: "sub-threshold",
		}));
		const prompt = buildPrompt(run, "TOOL Read {}", [], [], many);
		expect(prompt).toContain("Evicted rule number 7.");
		expect(prompt).not.toContain("Evicted rule number 8.");

		expect(buildPrompt(run, "TOOL Read {}", [], [], [])).not.toMatch(
			/REJECTED/,
		);
	});
});

describe("trigramSimilarity", () => {
	it("is 1 for identical strings and 0 for disjoint ones", () => {
		expect(trigramSimilarity("use grep first", "use grep first")).toBe(1);
		expect(trigramSimilarity("aaa bbb", "zzz yyy")).toBe(0);
	});

	it("flags near-duplicates above the 0.85 threshold", () => {
		const a = "Use Grep to locate symbols before reading any file.";
		const b = "Use Grep to locate symbols before reading any files.";
		expect(trigramSimilarity(a, b)).toBeGreaterThan(0.85);
	});

	it("keeps genuinely different rules below the threshold", () => {
		const a = "Use Grep to locate symbols before reading any file.";
		const b = "State a one-line plan before making the first edit.";
		expect(trigramSimilarity(a, b)).toBeLessThan(0.85);
	});

	it("ignores case and punctuation", () => {
		expect(
			trigramSimilarity("Use grep first!", "use GREP first"),
		).toBeGreaterThan(0.85);
	});
});

describe("parseRulesJson", () => {
	it("accepts a valid array of up to two rules", () => {
		const rules = parseRulesJson(
			'[{"body": "Use Grep before reading files."}, {"body": "Plan before editing anything."}]',
		);
		expect(rules).toHaveLength(2);
	});

	it("accepts an empty array and tolerates markdown fences", () => {
		expect(parseRulesJson("[]")).toEqual([]);
		expect(
			parseRulesJson(
				'```json\n[{"body": "Use Grep before reading files."}]\n```',
			),
		).toHaveLength(1);
	});

	it("returns null for non-JSON, wrong shapes, and oversized output", () => {
		expect(parseRulesJson("I think the agent should...")).toBeNull();
		expect(parseRulesJson('{"body": "not an array"}')).toBeNull();
		expect(
			parseRulesJson(
				'[{"body":"Rule one is fine here."},{"body":"Rule two is fine here."},{"body":"Three rules is too many."}]',
			),
		).toBeNull();
		expect(parseRulesJson('[{"body": "short"}]')).toBeNull();
		expect(parseRulesJson(`[{"body": "${"x".repeat(201)}"}]`)).toBeNull();
	});

	it("rejects bodies containing control characters or newlines", () => {
		expect(
			parseRulesJson(
				'[{"body": "Legit looking rule\\nwith an injected line."}]',
			),
		).toBeNull();
		expect(
			parseRulesJson('[{"body": "Rule with escape \\u001b[31m inside it."}]'),
		).toBeNull();
	});
});

describe("p75 / shouldDistill", () => {
	it("computes nearest-rank p75", () => {
		expect(p75([1, 2, 3, 4])).toBe(3);
		expect(p75([10])).toBe(10);
		expect(p75([])).toBe(0);
	});

	describe("with a seeded db", () => {
		let dir: string;
		let db: WardenDb;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "warden-distill-"));
			db = openDb(join(dir, "warden.db"));
		});

		afterEach(() => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		});

		function seedRun(sessionId: string, inputTokens: number): number {
			return upsertRun(db, {
				agent: "backend",
				sessionId,
				taskHash: null,
				inputTokens,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: new Date().toISOString(),
			});
		}

		it("requires at least five prior runs", () => {
			for (let i = 0; i < 4; i++) seedRun(`s${i}`, 10_000);
			const current = seedRun("current", 99_000);
			expect(shouldDistill(db, "backend", current, 99_000)).toBe(false);
		});

		it("triggers only above the rolling p75", () => {
			const totals = [10_000, 12_000, 14_000, 16_000, 18_000];
			for (const [i, total] of totals.entries()) {
				seedRun(`s${i}`, total);
			}
			const current = seedRun("current", 50_000);
			expect(shouldDistill(db, "backend", current, 50_000)).toBe(true);
			expect(shouldDistill(db, "backend", current, 11_000)).toBe(false);
		});

		it("only counts the same agent's runs", () => {
			for (let i = 0; i < 10; i++) seedRun(`s${i}`, 10_000);
			const current = seedRun("current", 99_000);
			expect(shouldDistill(db, "sql", current, 99_000)).toBe(false);
		});

		it("excludes golden/bench runs from the priors", () => {
			// Only 4 real-work priors — the golden run must not count as a 5th.
			for (let i = 0; i < 4; i++) seedRun(`s${i}`, 10_000);
			upsertRun(db, {
				agent: "backend",
				sessionId: "golden",
				taskHash: "backend-01",
				inputTokens: 10_000,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: new Date().toISOString(),
			});
			const current = seedRun("current", 99_000);
			expect(shouldDistill(db, "backend", current, 99_000)).toBe(false);
		});

		it("alreadyDistilled flags runs that produced a rule", async () => {
			const { alreadyDistilled } = await import("../src/distill.js");
			const { insertRule } = await import("../src/db.js");
			const runId = seedRun("expensive", 90_000);
			expect(alreadyDistilled(db, runId)).toBe(false);
			insertRule(db, {
				agent: "backend",
				body: "A rule distilled from this run.",
				contextCost: 8,
				sourceRun: runId,
				createdAt: "t",
			});
			expect(alreadyDistilled(db, runId)).toBe(true);
		});
	});
});

describe("contextCost", () => {
	it("charges one token per four characters, rounded up", () => {
		expect(contextCost("abcd")).toBe(1);
		expect(contextCost("abcde")).toBe(2);
	});
});

describe("parseDistillArgs", () => {
	it("requires --run and --transcript", () => {
		expect(
			parseDistillArgs(["--run", "7", "--transcript", "/t.jsonl"]),
		).toEqual({ runId: 7, transcriptPath: "/t.jsonl" });
		expect(() => parseDistillArgs(["--run", "7"])).toThrow(/--transcript/);
		expect(() => parseDistillArgs(["--transcript", "/t.jsonl"])).toThrow(
			/--run/,
		);
	});
});

describe("digestTranscript", () => {
	const entry = (type: string, message: unknown) =>
		JSON.stringify({ type, sessionId: "s", message });

	it("renders text and tool calls compactly", () => {
		const jsonl = [
			entry("user", { content: "Fix the bug in the parser." }),
			entry("assistant", {
				id: "m1",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Read",
						input: { file_path: "/a.ts" },
					},
				],
			}),
			entry("assistant", {
				id: "m2",
				content: [{ type: "text", text: "Done." }],
			}),
			entry("system", { content: "ignored" }),
		].join("\n");
		const digest = digestTranscript(jsonl);
		expect(digest).toContain("USER: Fix the bug in the parser.");
		expect(digest).toContain('TOOL Read {"file_path":"/a.ts"}');
		expect(digest).toContain("ASSISTANT: Done.");
		expect(digest).not.toContain("ignored");
	});

	it("caps output keeping head and tail", () => {
		const lines = Array.from({ length: 500 }, (_, i) =>
			entry("assistant", {
				id: `m${i}`,
				content: [
					{ type: "text", text: `step number ${i} of the long session` },
				],
			}),
		).join("\n");
		const digest = digestTranscript(lines, 2000);
		expect(digest.length).toBeLessThan(2100);
		expect(digest).toContain("step number 0");
		expect(digest).toContain("step number 499");
		expect(digest).toContain("[transcript truncated]");
	});
});
