import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRow } from "../src/db.js";
import {
	openDb,
	RUN_TOTAL_TOKENS_SQL,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import {
	buildPrompt,
	p75,
	parseDistillArgs,
	parseRulesJson,
	shouldDistill,
} from "../src/distill.js";
import {
	MAX_MODEL_REPLY_CHARS,
	parseClaudeEnvelope,
	stripJsonFence,
} from "../src/model-call.js";
import {
	contextCost,
	hasForbiddenChar,
	trigramSimilarity,
} from "../src/rules.js";
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

	it("refuses an absurdly long reply without parsing it", () => {
		// A valid reply is at most two 200-char bodies. Anything at this scale is
		// garbage and must not be handed to JSON.parse or the regex passes.
		expect(parseRulesJson("[".repeat(MAX_MODEL_REPLY_CHARS + 1))).toBeNull();
		// A genuinely valid payload padded past the cap is refused too — the cap
		// is on what we are willing to inspect, not on what looks plausible.
		const valid = '[{"body": "Use Grep before reading files."}]';
		expect(
			parseRulesJson(valid + " ".repeat(MAX_MODEL_REPLY_CHARS)),
		).toBeNull();
	});
});

/** Build a string containing a specific code point without writing an
 * invisible character into this source file. */
const codePoint = (code: number) => String.fromCharCode(code);

describe("rule-body character hardening", () => {
	/** Wrap a body in the exact shape a valid model reply would have. */
	const replyWith = (body: string) => JSON.stringify([{ body }]);

	it.each([
		["LINE SEPARATOR", 0x2028],
		["PARAGRAPH SEPARATOR", 0x2029],
		["NEXT LINE (C1)", 0x0085],
		["C1 control", 0x009b],
		["ZERO WIDTH SPACE", 0x200b],
		["RIGHT-TO-LEFT OVERRIDE", 0x202e],
		["LEFT-TO-RIGHT ISOLATE", 0x2066],
		["ZERO WIDTH NO-BREAK SPACE / BOM", 0xfeff],
		["REPLACEMENT CHARACTER", 0xfffd],
		["lone surrogate", 0xd800],
	])("rejects a body carrying %s — it could fake structure or hide its content", (_name, code) => {
		const body = `Grep before ${codePoint(code)} reading whole files.`;
		expect(hasForbiddenChar(body)).toBe(true);
		expect(parseRulesJson(replyWith(body))).toBeNull();
	});

	it("rejects astral-plane characters (emoji are banned project-wide)", () => {
		// U+1F600 as its surrogate pair — a well-formed emoji, still refused.
		const body = `Grep before ${codePoint(0xd83d)}${codePoint(0xde00)} reading files.`;
		expect(hasForbiddenChar(body)).toBe(true);
		expect(parseRulesJson(replyWith(body))).toBeNull();
	});

	it("still accepts ordinary punctuation and accented latin text", () => {
		const body = "Grep for the symbol first; don't re-read a file (naive).";
		expect(hasForbiddenChar(body)).toBe(false);
		expect(parseRulesJson(replyWith(body))).toEqual([{ body }]);
	});

	it("trims surrounding whitespace before enforcing the length floor", () => {
		expect(parseRulesJson(replyWith("   short    "))).toBeNull();
		expect(parseRulesJson(replyWith("   Grep before reading.   "))).toEqual([
			{ body: "Grep before reading." },
		]);
	});
});

describe("stripJsonFence", () => {
	it("removes a wrapping fence and leaves bare JSON untouched", () => {
		expect(stripJsonFence('```json\n[{"body":"x"}]\n```')).toBe(
			'[{"body":"x"}]',
		);
		expect(stripJsonFence("```\n[]\n```")).toBe("[]");
		expect(stripJsonFence('  [{"body":"x"}]  ')).toBe('[{"body":"x"}]');
	});
});

describe("parseClaudeEnvelope", () => {
	it("extracts the result text from a healthy envelope", () => {
		expect(
			parseClaudeEnvelope(
				JSON.stringify({ type: "result", is_error: false, result: "hello" }),
			),
		).toEqual({ ok: true, result: "hello" });
	});

	it("treats a missing result field as empty rather than crashing", () => {
		expect(parseClaudeEnvelope(JSON.stringify({ type: "result" }))).toEqual({
			ok: true,
			result: "",
		});
	});

	it("fails closed on JSON that is not an object", () => {
		// REGRESSION: `null` is valid JSON, so the old
		// `JSON.parse(stdout).result` threw a TypeError and took the caller
		// down instead of dropping the sample.
		for (const stdout of ["null", "true", '"a string"', "[1,2,3]", "123"]) {
			const parsed = parseClaudeEnvelope(stdout);
			expect(parsed.ok).toBe(false);
		}
	});

	it("fails closed on empty, absent, and non-JSON stdout", () => {
		expect(parseClaudeEnvelope("")).toMatchObject({ ok: false });
		expect(parseClaudeEnvelope("   ")).toMatchObject({ ok: false });
		expect(parseClaudeEnvelope(undefined)).toMatchObject({ ok: false });
		const junk = parseClaudeEnvelope("not json at all");
		expect(junk.ok).toBe(false);
		expect(junk.ok === false && junk.reason).toContain("not JSON");
	});

	it("fails closed when the CLI reports its own error", () => {
		const parsed = parseClaudeEnvelope(
			JSON.stringify({ is_error: true, result: "credit quota exhausted" }),
		);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reason).toContain("quota exhausted");
	});

	it("refuses an oversized stdout buffer", () => {
		const huge = `{"result":"${"x".repeat(MAX_MODEL_REPLY_CHARS)}"}`;
		const parsed = parseClaudeEnvelope(huge);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reason).toContain("cap");
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

		/** Seed a run that ended aborted or API-errored (completed = 0). */
		function seedIncompleteRun(sessionId: string, inputTokens: number) {
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
				completed: false,
				rulesetVersion: 0,
				ts: new Date().toISOString(),
			});
		}

		it("excludes aborted/errored runs from the priors", () => {
			// Only 4 completed real-work priors — an interrupted session is a
			// truncated, unrepresentative cost and must not count as a 5th.
			for (let i = 0; i < 4; i++) seedRun(`s${i}`, 10_000);
			seedIncompleteRun("aborted", 10_000);
			const current = seedRun("current", 99_000);
			expect(shouldDistill(db, "backend", current, 99_000)).toBe(false);
		});

		it("does not let cheap aborted runs drag the percentile down", () => {
			for (const [i, total] of [
				40_000, 44_000, 48_000, 52_000, 56_000,
			].entries()) {
				seedRun(`s${i}`, total);
			}
			// Five truncated sessions that died early. Counting them would drop
			// the p75 far enough for an ordinary 30k session to look expensive.
			for (let i = 0; i < 5; i++) seedIncompleteRun(`abort-${i}`, 100);
			const current = seedRun("current", 30_000);
			expect(shouldDistill(db, "backend", current, 30_000)).toBe(false);
			expect(shouldDistill(db, "backend", current, 60_000)).toBe(true);
		});

		it("still distills an expensive run that itself ended aborted", () => {
			// The predicate filters PRIORS only: an incomplete run is often
			// exactly the runaway session worth learning from.
			for (let i = 0; i < 5; i++) seedRun(`s${i}`, 10_000);
			const current = seedIncompleteRun("runaway", 99_000);
			expect(shouldDistill(db, "backend", current, 99_000)).toBe(true);
		});

		it("is served by the real-work index, with no table scan or sort", () => {
			// PERFORMANCE GUARD: this query runs on every session end inside the
			// 2-second Stop-hook budget. Without `completed = 1` the v16 partial
			// index cannot apply and SQLite scans every session the agent has
			// ever run, then sorts them in a temp B-tree. Assert the plan, not a
			// wall-clock time, so this stays fast and non-flaky.
			seedRun("plan-probe", 1000);
			const plan = db
				.prepare(
					`EXPLAIN QUERY PLAN
					 SELECT COALESCE(${RUN_TOTAL_TOKENS_SQL}, 0) AS total
					 FROM runs
					 WHERE agent = ? AND id != ? AND task_hash IS NULL AND completed = 1
					 ORDER BY ts DESC LIMIT ?`,
				)
				.all("backend", 1, 50) as { detail: string }[];
			const detail = plan.map((r) => r.detail).join("\n");

			expect(detail).toContain("idx_runs_realwork");
			expect(detail).not.toContain("SCAN runs");
			expect(detail).not.toContain("TEMP B-TREE");
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
		).toEqual({ runId: 7, transcriptPath: "/t.jsonl", k: 1 });
		expect(() => parseDistillArgs(["--run", "7"])).toThrow(/--transcript/);
		expect(() => parseDistillArgs(["--transcript", "/t.jsonl"])).toThrow(
			/--run/,
		);
	});

	it("parses --k within 1-3 and rejects out-of-range values", () => {
		expect(
			parseDistillArgs(["--run", "7", "--transcript", "/t.jsonl", "--k", "3"])
				.k,
		).toBe(3);
		expect(() =>
			parseDistillArgs(["--run", "7", "--transcript", "/t.jsonl", "--k", "0"]),
		).toThrow(/--k/);
		expect(() =>
			parseDistillArgs(["--run", "7", "--transcript", "/t.jsonl", "--k", "4"]),
		).toThrow(/--k/);
	});

	it("takes the default K from TOKEN_WARDEN_DISTILL_K, ignoring junk", () => {
		process.env.TOKEN_WARDEN_DISTILL_K = "2";
		try {
			expect(
				parseDistillArgs(["--run", "7", "--transcript", "/t.jsonl"]).k,
			).toBe(2);
			process.env.TOKEN_WARDEN_DISTILL_K = "banana";
			expect(
				parseDistillArgs(["--run", "7", "--transcript", "/t.jsonl"]).k,
			).toBe(1);
			process.env.TOKEN_WARDEN_DISTILL_K = "9";
			expect(
				parseDistillArgs(["--run", "7", "--transcript", "/t.jsonl"]).k,
			).toBe(1);
		} finally {
			delete process.env.TOKEN_WARDEN_DISTILL_K;
		}
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
