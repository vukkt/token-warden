import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectLedgerFiles,
	verifyLedgerContent,
} from "../src/verify-ledger.js";

const validLedger = `# token-warden rules — sql

<!-- token-warden:ledger -->
\`\`\`json
{ "agent": "sql", "exportedAt": "t", "rules": [ { "body": "Use Grep before reading any file.", "measuredDelta": 100, "contextCost": 8, "sourceRun": null, "createdAt": "t" } ] }
\`\`\`
`;

describe("verifyLedgerContent", () => {
	it("accepts a well-formed ledger and counts its rules", () => {
		const r = verifyLedgerContent("a.md", validLedger);
		expect(r.ok).toBe(true);
		expect(r.ruleCount).toBe(1);
	});

	it("rejects a file with no ledger block", () => {
		const r = verifyLedgerContent("b.md", "# hand-edited, block deleted");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("no valid");
	});

	it("rejects a corrupt JSON block", () => {
		const r = verifyLedgerContent("c.md", "```json\n{ broken,, }\n```");
		expect(r.ok).toBe(false);
	});
});

describe("collectLedgerFiles", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-verify-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("uses explicit args verbatim when given", () => {
		expect(collectLedgerFiles(["x.md", "y.md"], dir)).toEqual(["x.md", "y.md"]);
	});

	it("scans .warden/*.rules.md when no args, sorted", () => {
		const warden = join(dir, ".warden");
		mkdirSync(warden);
		writeFileSync(join(warden, "sql.rules.md"), "x");
		writeFileSync(join(warden, "backend.rules.md"), "x");
		writeFileSync(join(warden, "notes.txt"), "ignored");
		expect(collectLedgerFiles([], dir)).toEqual([
			join(warden, "backend.rules.md"),
			join(warden, "sql.rules.md"),
		]);
	});

	it("returns empty when there is no .warden directory", () => {
		expect(collectLedgerFiles([], dir)).toEqual([]);
	});
});
