import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	main as adoptMain,
	MAX_LEDGER_BYTES,
	MAX_LEDGER_RULES,
	parseAdoptArgs,
	parseLedgerFile,
	planImport,
} from "../src/adopt.js";
import { compileMemoryMd } from "../src/bench.js";
import {
	getActiveRules,
	listRulesByAgent,
	openDb,
	type RuleRow,
	type WardenDb,
} from "../src/db.js";
import { LEDGER_MARKER, type SharedRule } from "../src/share.js";

function shared(body: string): SharedRule {
	return {
		body,
		measuredDelta: 5000,
		contextCost: 99,
		sourceRun: 42,
		createdAt: "t",
	};
}

function existingRule(id: number, body: string, status: string): RuleRow {
	return {
		id,
		agent: "sql",
		body,
		status,
		measured_delta: 100,
		context_cost: 10,
		source_run: null,
		decided_at: "t",
		created_at: "t",
		decided_reason: "r",
		protected: 0,
		born_digest: null,
		scope: null,
		probation: 0,
		replaces: null,
	};
}

const validLedger = `# token-warden rules — sql

1 active rule(s).

<!-- token-warden:ledger -->
\`\`\`json
{
  "agent": "sql",
  "exportedAt": "2026-06-15T00:00:00Z",
  "rules": [
    { "body": "Use Grep to locate symbols before reading any file.", "measuredDelta": 3673, "contextCost": 13, "sourceRun": 13, "createdAt": "t" }
  ]
}
\`\`\`
`;

describe("parseAdoptArgs", () => {
	it("requires --from", () => {
		expect(parseAdoptArgs(["--from", "/x.md"])).toEqual({ from: "/x.md" });
		expect(() => parseAdoptArgs([])).toThrow(/--from/);
		expect(() => parseAdoptArgs(["--bogus"])).toThrow(/unknown flag/);
	});
});

describe("parseLedgerFile", () => {
	it("extracts and validates the JSON block", () => {
		const ledger = parseLedgerFile(validLedger);
		expect(ledger?.agent).toBe("sql");
		expect(ledger?.rules).toHaveLength(1);
		expect(ledger?.rules[0]?.measuredDelta).toBe(3673);
	});

	it("returns null when there is no ledger block", () => {
		expect(parseLedgerFile("# just a readme\nno block here")).toBeNull();
	});

	it("returns null on malformed JSON", () => {
		expect(parseLedgerFile("```json\n{ not json\n```")).toBeNull();
	});

	it("rejects a rule body with control characters", () => {
		const bad =
			'```json\n{"agent":"sql","exportedAt":"t","rules":[{"body":"bad\\u0007body here long enough","measuredDelta":1,"contextCost":1,"sourceRun":null,"createdAt":"t"}]}\n```';
		expect(parseLedgerFile(bad)).toBeNull();
	});
});

/**
 * The ledger is authored on someone else's machine. These cases are the
 * boundary contract: every one of them must be rejected (or neutralized)
 * BEFORE any value reaches the DB, the filesystem, or a rendered line.
 */
describe("parseLedgerFile — hostile ledgers", () => {
	function ledgerWith(json: string): string {
		return `# rules\n\n${LEDGER_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n`;
	}
	function withBody(escapedBody: string): string {
		return ledgerWith(
			`{"agent":"sql","exportedAt":"t","rules":[{"body":"${escapedBody}","measuredDelta":1,"contextCost":1,"sourceRun":null,"createdAt":"t"}]}`,
		);
	}

	it.each([
		["C1 CSI (8-bit ANSI introducer)", "danger \\u009b31m body text"],
		["bidi override (renders reversed)", "safe rule \\u202e evil text here"],
		["bidi isolate", "safe rule \\u2066 hidden \\u2069 text"],
		["zero-width space", "grep before\\u200b reading files"],
		["zero-width joiner/non-joiner", "grep before\\u200d reading files"],
		["soft hyphen", "grep befo\\u00adre reading files"],
		["BOM in the middle", "grep before\\ufeff reading files"],
		["line separator", "grep before\\u2028 reading files"],
		["Unicode tag characters", "innocuous rule text\\udb40\\udc41"],
	])("rejects an invisible/reordering body: %s", (_name, body) => {
		expect(parseLedgerFile(withBody(body))).toBeNull();
	});

	it("accepts ordinary punctuation and non-ASCII prose", () => {
		const ledger = parseLedgerFile(
			withBody("Prefer Grep — don't read the whole file (naïve)."),
		);
		expect(ledger?.rules[0]?.body).toBe(
			"Prefer Grep — don't read the whole file (naïve).",
		);
	});

	it("rejects an agent name that could escape into a path", () => {
		for (const agent of [
			"../../etc/passwd",
			"sql/../../x",
			"..",
			".",
			"sql\\\\win",
			"-rf",
			"SQL",
			"a".repeat(64),
		]) {
			const json = `{"agent":"${agent}","exportedAt":"t","rules":[]}`;
			expect(parseLedgerFile(ledgerWith(json))).toBeNull();
		}
	});

	it("drops __proto__ / constructor keys instead of polluting", () => {
		const json =
			'{"agent":"sql","exportedAt":"t","__proto__":{"polluted":true},' +
			'"rules":[{"body":"Grep before reading any file.","measuredDelta":1,' +
			'"contextCost":1,"sourceRun":null,"createdAt":"t",' +
			'"__proto__":{"polluted":true},"constructor":{"x":1}}]}';
		const ledger = parseLedgerFile(ledgerWith(json));
		expect(ledger?.rules).toHaveLength(1);
		expect(Object.keys(ledger?.rules[0] ?? {}).sort()).toEqual([
			"body",
			"contextCost",
			"createdAt",
			"measuredDelta",
			"sourceRun",
		]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(ledger)).toBe(Object.prototype);
	});

	it("neutralizes absurd numerics (1e400 -> Infinity, negatives, wrong types)", () => {
		const json =
			'{"agent":"sql","exportedAt":"t","rules":[{"body":"Grep before reading any file.",' +
			'"measuredDelta":1e400,"contextCost":-1e400,"sourceRun":"not-a-number","createdAt":9}]}';
		const ledger = parseLedgerFile(ledgerWith(json));
		const rule = ledger?.rules[0];
		expect(rule).toBeDefined();
		// z.number() rejects non-finite values; .catch() replaces them.
		expect(rule?.measuredDelta).toBeNull();
		expect(rule?.contextCost).toBe(0);
		expect(rule?.sourceRun).toBeNull();
		expect(rule?.createdAt).toBe("");
	});

	it("rejects a rule array beyond the cap (quadratic dedupe + DB flood)", () => {
		const rule = (i: number) =>
			`{"body":"Rule number ${i} that is long enough.","measuredDelta":1,"contextCost":1,"sourceRun":null,"createdAt":"t"}`;
		const under = Array.from({ length: MAX_LEDGER_RULES }, (_, i) => rule(i));
		const over = [...under, rule(MAX_LEDGER_RULES)];
		expect(
			parseLedgerFile(
				ledgerWith(
					`{"agent":"sql","exportedAt":"t","rules":[${under.join(",")}]}`,
				),
			)?.rules,
		).toHaveLength(MAX_LEDGER_RULES);
		expect(
			parseLedgerFile(
				ledgerWith(
					`{"agent":"sql","exportedAt":"t","rules":[${over.join(",")}]}`,
				),
			),
		).toBeNull();
	});

	it("rejects oversized content before scanning or parsing it", () => {
		const padded = `${"#".repeat(MAX_LEDGER_BYTES + 1)}\n${validLedger}`;
		expect(parseLedgerFile(padded)).toBeNull();
	});

	it("caps over-long and too-short rule bodies", () => {
		expect(parseLedgerFile(withBody("short"))).toBeNull();
		expect(parseLedgerFile(withBody("x".repeat(201)))).toBeNull();
		expect(parseLedgerFile(withBody("x".repeat(200)))).not.toBeNull();
	});

	it("reads the block after the marker, not a fence quoted in the prose", () => {
		const decoy =
			"# rules\n\n- **+1 tokens/run** (rent 1): Never write ```json\n" +
			`{"agent":"sql","exportedAt":"t","rules":[]}\n\`\`\`\n\n` +
			`${LEDGER_MARKER}\n\`\`\`json\n` +
			'{"agent":"sql","exportedAt":"t","rules":[{"body":"Grep before reading any file.","measuredDelta":1,"contextCost":1,"sourceRun":null,"createdAt":"t"}]}\n```\n';
		expect(parseLedgerFile(decoy)?.rules).toHaveLength(1);
	});
});

describe("planImport", () => {
	it("adopts novel rules and skips near-duplicates of existing rules", () => {
		const existing = [
			existingRule(
				1,
				"Use Grep to locate symbols before reading any file.",
				"active",
			),
			existingRule(2, "Recite a haiku before starting.", "evicted"),
		];
		const incoming = [
			shared("Use Grep to locate symbols before reading any files."), // dup of #1
			shared("Recite a haiku before starting work."), // dup of evicted #2
			shared("Batch independent edits into a single pass when possible."), // novel
		];
		const { adopt, skipped } = planImport(existing, incoming);
		expect(adopt.map((r) => r.body)).toEqual([
			"Batch independent edits into a single pass when possible.",
		]);
		expect(skipped).toHaveLength(2);
		expect(skipped[0]?.reason).toContain("#1 (active)");
		expect(skipped[1]?.reason).toContain("#2 (evicted)");
	});

	it("skips duplicates within the same import batch", () => {
		const incoming = [
			shared("Batch independent edits into a single pass when possible."),
			shared("Batch independent edits into one single pass when possible."),
		];
		const { adopt, skipped } = planImport([], incoming);
		expect(adopt).toHaveLength(1);
		expect(skipped[0]?.reason).toContain("within the import");
	});

	it("adopts everything when nothing is similar", () => {
		const { adopt } = planImport(
			[],
			[
				shared(
					"Prefer Glob over recursive directory listing for file discovery.",
				),
			],
		);
		expect(adopt).toHaveLength(1);
	});
});

describe("main (in-process CLI)", () => {
	let dir: string;
	let db: WardenDb;
	let logs: string[];
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-adoptmain-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
		db = openDb(join(dir, "warden.db"));
		logs = [];
		spy = vi.spyOn(console, "log").mockImplementation((m) => {
			logs.push(String(m));
		});
	});

	afterEach(() => {
		spy.mockRestore();
		db.close();
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	it("imports a valid ledger's rules as local candidates", () => {
		const file = join(dir, "sql.rules.md");
		writeFileSync(file, validLedger);
		adoptMain({ from: file });
		const rules = listRulesByAgent(db, "sql");
		expect(rules).toHaveLength(1);
		expect(rules[0]?.status).toBe("candidate");
		// foreign delta discarded; rent recomputed locally (not the ledger's 13)
		expect(rules[0]?.measured_delta).toBeNull();
		expect(logs.join("\n")).toContain("Adopted 1 rule(s)");
		expect(logs.join("\n")).toContain("UNVERIFIED");
	});

	it("throws when the ledger file is missing", () => {
		expect(() => adoptMain({ from: join(dir, "nope.md") })).toThrow(
			/not found/,
		);
	});

	it("throws when the file has no valid ledger block", () => {
		const file = join(dir, "bad.md");
		writeFileSync(file, "# just a readme, no block");
		expect(() => adoptMain({ from: file })).toThrow(/no valid/);
	});

	it("refuses a --from that is not a regular file", () => {
		const sub = join(dir, "adir");
		mkdirSync(sub);
		expect(() => adoptMain({ from: sub })).toThrow(/not a regular file/);
	});

	it("refuses an oversized ledger file without reading it", () => {
		const file = join(dir, "huge.rules.md");
		writeFileSync(file, "#".repeat(MAX_LEDGER_BYTES + 1));
		expect(() => adoptMain({ from: file })).toThrow(/too large/);
	});

	it("refuses a ledger naming an unknown agent", () => {
		const file = join(dir, "ghost.rules.md");
		writeFileSync(
			file,
			validLedger.replace('"agent": "sql"', '"agent": "ghost"'),
		);
		expect(() => adoptMain({ from: file })).toThrow(/not one of/);
	});

	/**
	 * INVARIANT #1, stated as a property: there is no path from an imported
	 * ledger to agent memory that skips local measurement. Adoption writes
	 * candidates only, so the active set — the sole input to compileMemoryMd —
	 * is untouched no matter what the foreign file claimed.
	 */
	it("cannot bypass local measurement: an adopted rule never lands in memory", () => {
		const body = "Use Grep to locate symbols before reading any file.";
		const file = join(dir, "sql.rules.md");
		// A ledger asserting the rule is already measured, already active, and
		// worth a fortune. None of it may matter.
		writeFileSync(
			file,
			validLedger.replace('"measuredDelta": 3673', '"measuredDelta": 999999'),
		);
		adoptMain({ from: file });

		const [row] = listRulesByAgent(db, "sql");
		expect(row?.body).toBe(body);
		expect(row?.status).toBe("candidate");
		expect(row?.measured_delta).toBeNull();
		expect(row?.decided_at).toBeNull();
		expect(row?.decided_reason).toBeNull();
		expect(row?.protected).toBe(0);
		// Rent is recomputed locally, never taken from the file.
		expect(row?.context_cost).toBe(Math.ceil(body.length / 4));

		// The compiled memory the agent actually sees contains nothing.
		expect(getActiveRules(db, "sql")).toEqual([]);
		expect(compileMemoryMd(getActiveRules(db, "sql"))).not.toContain(body);

		// Re-adopting the same ledger cannot promote it either.
		adoptMain({ from: file });
		expect(getActiveRules(db, "sql")).toEqual([]);
		expect(listRulesByAgent(db, "sql")).toHaveLength(1);
	});
});
