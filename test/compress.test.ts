import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCompressPrompt,
	parseCompressArgs,
	parseRewriteJson,
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
});
