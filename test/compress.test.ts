import { mkdtempSync, rmSync } from "node:fs";
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

// The model boundary: requestRewrite spawns `claude`. Mocked so no test can
// ever make a real model call; everything else in node:child_process is left
// alone.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";
import {
	buildCompressPrompt,
	compressBudget,
	isTooShortToCompress,
	main,
	parseCompressArgs,
	parseRewriteJson,
	requestRewrite,
	runCompress,
} from "../src/compress.js";
import {
	decideRule,
	getRuleById,
	insertRule,
	listRulesByAgent,
	openDb,
	type RuleRow,
	type WardenDb,
} from "../src/db.js";
import { MAX_MODEL_REPLY_CHARS, parseRulesJson } from "../src/distill.js";

const spawnSyncMock = spawnSync as unknown as MockInstance;

describe("parseCompressArgs", () => {
	it("requires a known agent and an integer rule id", () => {
		expect(parseCompressArgs(["--agent", "sql", "--rule", "7"])).toEqual({
			agent: "sql",
			rule: 7,
			dryRun: false,
		});
		expect(
			parseCompressArgs(["--agent", "sql", "--rule", "7", "--dry-run"]).dryRun,
		).toBe(true);
		expect(() => parseCompressArgs(["--agent", "nope", "--rule", "7"])).toThrow(
			/--agent/,
		);
		expect(() => parseCompressArgs(["--agent", "sql"])).toThrow(/--rule/);
		expect(() => parseCompressArgs(["--agent", "sql", "--bogus"])).toThrow(
			/unknown flag: --bogus/,
		);
	});
});

describe("parseRewriteJson", () => {
	it("accepts a single {body} object, tolerating a markdown fence", () => {
		expect(parseRewriteJson('{"body":"Grep before reading files."}')).toEqual({
			body: "Grep before reading files.",
		});
		expect(
			parseRewriteJson('```json\n{"body":"Grep before reading files."}\n```'),
		).toEqual({ body: "Grep before reading files." });
	});

	it("returns null for arrays, junk, and control characters", () => {
		expect(
			parseRewriteJson('[{"body":"An array, not an object."}]'),
		).toBeNull();
		expect(parseRewriteJson("sorry, cannot")).toBeNull();
		expect(parseRewriteJson('{"body":"line\\nbreak inside body"}')).toBeNull();
		expect(parseRewriteJson('{"body":"too short"}')).toBeNull();
	});

	it("enforces the same body contract as a distilled rule", () => {
		expect(
			parseRewriteJson(JSON.stringify({ body: "x".repeat(201) })),
		).toBeNull();
	});

	// A compression rewrite becomes an ACTIVE rule and is compiled verbatim
	// into a real agent's prompt every session, so this path must be at least
	// as strict as the distiller — it used to be strictly weaker.
	it.each([
		["bidi override (Trojan Source)", 0x202e],
		["zero-width joiner", 0x200d],
		["zero-width space", 0x200b],
		["left-to-right isolate", 0x2066],
		["LINE SEPARATOR", 0x2028],
		["BOM", 0xfeff],
	])("rejects a rewrite body carrying a %s", (_name, code) => {
		const body = `Grep the symbol ${String.fromCharCode(code)} before editing.`;
		expect(parseRewriteJson(JSON.stringify({ body }))).toBeNull();
		// Parity with the distiller: same input, same refusal.
		expect(parseRulesJson(JSON.stringify([{ body }]))).toBeNull();
	});

	it("rejects an emoji in a rewrite (zero-emoji policy)", () => {
		const body = `Grep the symbol ${String.fromCharCode(0xd83d, 0xde00)} before editing.`;
		expect(parseRewriteJson(JSON.stringify({ body }))).toBeNull();
		expect(parseRulesJson(JSON.stringify([{ body }]))).toBeNull();
	});

	it("still accepts an ordinary printable rewrite", () => {
		const body = "Grep the symbol before editing.";
		expect(parseRewriteJson(JSON.stringify({ body }))).toEqual({ body });
	});

	it("refuses an absurdly long reply without parsing it", () => {
		expect(parseRewriteJson("{".repeat(MAX_MODEL_REPLY_CHARS + 1))).toBeNull();
	});
});

describe("compressBudget / isTooShortToCompress", () => {
	it("budgets half the original length", () => {
		expect(compressBudget("x".repeat(100))).toBe(50);
		expect(compressBudget("x".repeat(41))).toBe(20);
	});

	it("flags rules too short for any valid rewrite to exist", () => {
		// Half of a 19-char rule is 9 — under the 10-char minimum body length,
		// so no reply could ever be accepted.
		expect(isTooShortToCompress("x".repeat(19))).toBe(true);
		expect(isTooShortToCompress("x".repeat(20))).toBe(false);
	});
});

describe("buildCompressPrompt", () => {
	it("states the half-length budget and demands raw JSON", () => {
		const prompt = buildCompressPrompt({
			body: "A".repeat(100),
		} as RuleRow);
		expect(prompt).toContain("AT MOST 50 characters");
		expect(prompt).toContain('{"body": "..."}');
		expect(prompt).toContain("preserve the EXACT behavioral meaning");
	});

	it("asks for exactly the budget the acceptance check enforces", () => {
		// The budget used to be computed twice, and the prompt's copy had a
		// Math.max(10, ...) floor the check did not — so for a short rule the
		// model was asked for 10 characters and then rejected for exceeding 9.
		for (const length of [20, 21, 45, 100, 199]) {
			const body = "A".repeat(length);
			expect(buildCompressPrompt({ body } as RuleRow)).toContain(
				`AT MOST ${compressBudget(body)} characters`,
			);
		}
	});
});

describe("runCompress", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-compress-"));
		db = openDb(join(dir, "warden.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const LONG_BODY =
		"Always use Grep or Glob to locate the exact symbol you need before opening any file, and never read a whole file you are not about to edit.";

	function seedActiveRule(agent = "sql", body = LONG_BODY): number {
		const id = insertRule(db, {
			agent,
			body,
			contextCost: Math.ceil(body.length / 4),
			sourceRun: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		decideRule(db, id, "active", 5000, "earned", "2026-01-02T00:00:00.000Z");
		return id;
	}

	it("queues a valid shorter rewrite as a new candidate with provenance", () => {
		const id = seedActiveRule();
		const rewrite = vi.fn(
			() =>
				'{"body":"Grep the symbol first; never read files you will not edit."}',
		);

		const out = runCompress(
			db,
			{ agent: "sql", rule: id, dryRun: false },
			rewrite,
		);

		expect(rewrite).toHaveBeenCalledOnce();
		expect(out).toContain("Queued candidate");
		expect(out).toContain(`compressed variant of rule ${id}`);
		const rules = listRulesByAgent(db, "sql");
		expect(rules).toHaveLength(2);
		const variant = rules.find((r) => r.id !== id);
		expect(variant?.status).toBe("candidate");
		expect(variant?.born_digest).toContain(`compressed variant of rule ${id}`);
		// Swap provenance: the selector must measure the variant AGAINST the
		// active set minus the original, not on top of it.
		expect(variant?.replaces).toBe(id);
		expect(out).toContain("benched as a SWAP");
		// The original is untouched.
		expect(getRuleById(db, id)?.status).toBe("active");
	});

	it("--dry-run shows the rewrite without inserting", () => {
		const id = seedActiveRule();
		const out = runCompress(
			db,
			{ agent: "sql", rule: id, dryRun: true },
			() =>
				'{"body":"Grep the symbol first; never read files you will not edit."}',
		);
		expect(out).toContain("Dry run: nothing inserted");
		expect(listRulesByAgent(db, "sql")).toHaveLength(1);
	});

	it("rejects a rewrite that is not genuinely half the length", () => {
		const id = seedActiveRule();
		const nearlyAsLong = LONG_BODY.slice(0, LONG_BODY.length - 10);
		expect(() =>
			runCompress(db, { agent: "sql", rule: id, dryRun: false }, () =>
				JSON.stringify({ body: nearlyAsLong }),
			),
		).toThrow(/not within half/);
		expect(listRulesByAgent(db, "sql")).toHaveLength(1);
	});

	it("rejects invalid rewrite JSON without inserting", () => {
		const id = seedActiveRule();
		expect(() =>
			runCompress(
				db,
				{ agent: "sql", rule: id, dryRun: false },
				() => "I think the rule is fine as-is.",
			),
		).toThrow(/invalid rewrite JSON/);
		expect(listRulesByAgent(db, "sql")).toHaveLength(1);
	});

	it("rejects a near-duplicate rewrite (nothing to A/B)", () => {
		const id = seedActiveRule();
		// A "rewrite" that barely changes the original.
		const copy = LONG_BODY.replace("Always use", "Use");
		expect(() =>
			runCompress(db, { agent: "sql", rule: id, dryRun: false }, () =>
				JSON.stringify({ body: copy }),
			),
		).toThrow(/near-duplicate|not within half/);
		expect(listRulesByAgent(db, "sql")).toHaveLength(1);
	});

	it("rejects missing rules, other agents' rules, and unmeasured candidates", () => {
		expect(() =>
			runCompress(db, { agent: "sql", rule: 999, dryRun: false }, () => ""),
		).toThrow(/no rule 999/);

		const backendRule = seedActiveRule("backend");
		expect(() =>
			runCompress(
				db,
				{ agent: "sql", rule: backendRule, dryRun: false },
				() => "",
			),
		).toThrow(/no rule/);

		const candidate = insertRule(db, {
			agent: "sql",
			body: LONG_BODY,
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});
		expect(() =>
			runCompress(
				db,
				{ agent: "sql", rule: candidate, dryRun: false },
				() => "",
			),
		).toThrow(/only an active/);
	});

	it("refuses a rule too short to compress WITHOUT spending a model call", () => {
		// Half of an 18-char rule is 9, under the 10-char minimum body — every
		// possible reply is rejected by construction, so this must fail before
		// the model is asked, not after.
		const id = seedActiveRule("sql", "Grep before edit.");
		const rewrite = vi.fn(() => '{"body":"Grep first."}');

		expect(() =>
			runCompress(db, { agent: "sql", rule: id, dryRun: false }, rewrite),
		).toThrow(/nothing to compress/);
		expect(rewrite).not.toHaveBeenCalled();
		expect(listRulesByAgent(db, "sql")).toHaveLength(1);
	});

	it("accepts a rewrite that exactly hits the budget", () => {
		const id = seedActiveRule();
		const exact = "x".repeat(compressBudget(LONG_BODY));
		const out = runCompress(db, { agent: "sql", rule: id, dryRun: true }, () =>
			JSON.stringify({ body: exact }),
		);
		expect(out).toContain("Dry run");
	});
});

describe("requestRewrite (model boundary)", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
	});

	function spawned(overrides: Record<string, unknown> = {}) {
		return {
			status: 0,
			stdout: JSON.stringify({ result: '{"body":"Grep first."}' }),
			stderr: "",
			error: undefined,
			...overrides,
		};
	}

	it("sends the prompt to a single-turn JSON call and returns the result", () => {
		spawnSyncMock.mockReturnValue(spawned());

		expect(requestRewrite("PROMPT TEXT")).toBe('{"body":"Grep first."}');

		const [cmd, argv] = spawnSyncMock.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("claude");
		expect(argv).toContain("PROMPT TEXT");
		expect(argv).toContain("--output-format");
		expect(argv).toContain("json");
		// One turn only: this is a single rewrite, never an agentic loop.
		expect(argv[argv.indexOf("--max-turns") + 1]).toBe("1");
	});

	it("reads TOKEN_WARDEN_DISTILL_MODEL at call time, not at import time", () => {
		// The model used to be frozen into a module-level const at import, so an
		// override set after import was silently ignored.
		spawnSyncMock.mockReturnValue(spawned());
		requestRewrite("p");
		expect((spawnSyncMock.mock.calls[0] as [string, string[]])[1]).toContain(
			"sonnet",
		);

		process.env.TOKEN_WARDEN_DISTILL_MODEL = "haiku";
		try {
			spawnSyncMock.mockReturnValue(spawned());
			requestRewrite("p");
			const argv = (spawnSyncMock.mock.calls[1] as [string, string[]])[1];
			expect(argv).toContain("haiku");
			expect(argv).not.toContain("sonnet");
		} finally {
			delete process.env.TOKEN_WARDEN_DISTILL_MODEL;
		}
	});

	it("rethrows a spawn error", () => {
		spawnSyncMock.mockReturnValue(
			spawned({ status: null, error: new Error("spawn claude ENOENT") }),
		);
		expect(() => requestRewrite("p")).toThrow(/ENOENT/);
	});

	it("reports the exit code, not a parse error, on a failed call", () => {
		// Exit code is the failure signal: a quota death with empty stdout must
		// not surface as "invalid JSON".
		spawnSyncMock.mockReturnValue(
			spawned({ status: 1, stdout: "", stderr: "credit quota exhausted" }),
		);
		expect(() => requestRewrite("p")).toThrow(/exited 1.*quota exhausted/);
	});

	it("fails closed on stdout that is not a result envelope", () => {
		spawnSyncMock.mockReturnValue(spawned({ stdout: "null" }));
		expect(() => requestRewrite("p")).toThrow(/claude /);

		spawnSyncMock.mockReturnValue(spawned({ stdout: "not json" }));
		expect(() => requestRewrite("p")).toThrow(/not JSON/);
	});

	it("fails closed when the CLI reports its own error", () => {
		spawnSyncMock.mockReturnValue(
			spawned({
				stdout: JSON.stringify({ is_error: true, result: "overloaded" }),
			}),
		);
		expect(() => requestRewrite("p")).toThrow(/overloaded/);
	});

	it("returns empty string when the envelope carries no result", () => {
		spawnSyncMock.mockReturnValue(
			spawned({ stdout: JSON.stringify({ type: "result" }) }),
		);
		expect(requestRewrite("p")).toBe("");
	});
});

describe("compress main()", () => {
	let dir: string;
	let logSpy: MockInstance;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-compress-main-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		spawnSyncMock.mockReset();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	const LONG =
		"Always grep for the exact symbol you need before opening any file at all.";

	/** Seed an active rule through main()'s own database. */
	function seed(): number {
		const db = openDb();
		try {
			const id = insertRule(db, {
				agent: "sql",
				body: LONG,
				contextCost: Math.ceil(LONG.length / 4),
				sourceRun: null,
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			decideRule(db, id, "active", 5000, "earned", "2026-01-02T00:00:00.000Z");
			return id;
		} finally {
			db.close();
		}
	}

	it("queues the variant and returns 0, closing the db", () => {
		const id = seed();
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({
				result: '{"body":"Grep symbols before opening files."}',
			}),
			stderr: "",
			error: undefined,
		});

		expect(main(["--agent", "sql", "--rule", String(id)])).toBe(0);
		expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
			"Queued candidate",
		);

		const db = openDb();
		try {
			expect(listRulesByAgent(db, "sql")).toHaveLength(2);
		} finally {
			db.close();
		}
	});

	it("propagates a bad argument before opening the db or spawning", () => {
		expect(() => main(["--agent", "nope", "--rule", "1"])).toThrow(/--agent/);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("propagates a rewrite rejection and inserts nothing", () => {
		const id = seed();
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({ result: "the rule is fine as-is" }),
			stderr: "",
			error: undefined,
		});

		expect(() => main(["--agent", "sql", "--rule", String(id)])).toThrow(
			/invalid rewrite JSON/,
		);

		const db = openDb();
		try {
			expect(listRulesByAgent(db, "sql")).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});
