import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	main as adoptMain,
	parseAdoptArgs,
	parseLedgerFile,
	planImport,
} from "../src/adopt.js";
import {
	listRulesByAgent,
	openDb,
	type RuleRow,
	type WardenDb,
} from "../src/db.js";
import type { SharedRule } from "../src/share.js";

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
});
