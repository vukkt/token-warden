/**
 * STRUCTURAL ENFORCEMENT of the `sanitize.ts` rendering contract.
 *
 * `sanitize.ts` opens by calling itself "the single chokepoint every model- or
 * environment-derived string must pass through before it is rendered into a
 * report, a log line, or a user-facing permission prompt." That contract was
 * real, documented, and honoured by `status.ts`, `scope.ts` and `collect.ts` —
 * and violated in SEVEN other places, found across two audit passes by six
 * agents working independently, none of whom could see each other's findings:
 *
 *   select.ts        rule bodies printed raw in the selector's own decision
 *                    report — the one place a reader looks to see what was kept
 *   distill.ts       unsanitized model replies to distill.log — PROVEN
 *                    exploitable: a newline in a rejected reply forged a second
 *                    timestamped entry
 *   evolve.ts        hostile stderr could forge an evolve.log entry
 *   contradict.ts    }
 *   sample-tasks.ts  } three render paths in the commands cluster
 *   share.ts         }
 *   cost.ts          a body with a newline forged an extra priced-report row
 *   compress.ts      a rejected rewrite could fake a "Queued candidate ..." line
 *
 * Six independent rediscoveries of one rule is not six mistakes; it is a rule
 * that cannot be held by discipline. The lesson this repo keeps re-learning is
 * that A CAVEAT IS NOT A TEST — a documented invariant with nothing checking it
 * drifts, exactly as an accurate caveat once travelled for weeks beside a false
 * headline. So the contract is now checked.
 *
 * WHAT THIS CHECKS: every interpolation of a model-derived field into a
 * template literal in `src/` must either pass through `displayText` (or
 * `truncateBody`, which is a thin wrapper over it) at the call site, or appear
 * in ALLOWED below with a stated reason. The allowlist is the thing a reviewer
 * has to argue with — the same device `test/golden-checks.test.ts` uses for its
 * known-vacuous checks.
 *
 * WHAT IT DOES NOT CHECK: this is a source-text guard, not a taint tracker. It
 * cannot follow a body through a variable, an array, or a helper. It catches
 * the shape all seven real violations actually took — a tainted field
 * interpolated directly into a rendered string — and it is deliberately narrow
 * so that a failure is always a real finding rather than noise to be silenced.
 *
 * Zero tokens: no model is involved.
 */
// The test fixtures here are SAMPLE SOURCE CODE that the guard parses, so their
// `${...}` sequences are data under test, not accidental un-interpolated
// templates.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures are source text
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Fields carrying model-written text. `sanitize.ts` names these explicitly:
 * "Rule bodies and eviction reasons are model-generated". `.length` and other
 * numeric reads are excluded at the match site — a number cannot forge a row.
 */
const TAINTED_FIELD = /\b(?:body|decided_reason)\b/;

/** `truncateBody` (gate.ts) is `displayText` with a preview cap. */
const SANITIZER = /\bdisplayText\s*\(|\btruncateBody\s*\(/;

/**
 * Interpolations that are NOT renders, each with the reason it is exempt.
 * Keyed by `file:function`, because line numbers drift and function names do
 * not. Adding an entry here is a claim that the text never reaches a terminal
 * or a log unsanitized — make it deliberately.
 */
const ALLOWED = new Map<string, string>([
	[
		"compress.ts:buildCompressPrompt",
		"prompt text sent to the model; the body must reach it verbatim or the rewrite is of a different rule",
	],
	[
		"distill.ts:buildPrompt",
		"prompt text sent to the model; banked and evicted bodies must reach it verbatim",
	],
	[
		"distill.ts:distill",
		"every one of these is an argument to logLine(), which applies displayText at the sink",
	],
	[
		"memory.ts:lines",
		"compiles MEMORY.md, where the body IS the payload the agent loads; insert-time ruleBodySchema is the defence, and sanitizing here would silently alter the rule the agent carries",
	],
	[
		"compress.ts:runCompress",
		"bornDigest is persisted to the ledger, not rendered; provenance must record the original body verbatim",
	],
]);

interface Finding {
	file: string;
	line: number;
	fn: string;
	text: string;
}

/** Enclosing function name, tracked by declaration order. Good enough for a
 * source-text guard, and it degrades to `<top-level>` rather than guessing. */
const FUNCTION_DECL =
	/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*[:=][^=]*(?:=>|function)/;

function findUnsanitizedRenders(source: string, file: string): Finding[] {
	const findings: Finding[] = [];
	let fn = "<top-level>";
	let inBlockComment = false;
	source.split("\n").forEach((raw, i) => {
		const line = raw;
		// Comments describe violations as often as they commit them (protect.ts
		// documents the MEMORY.md render in prose); never flag one.
		if (inBlockComment) {
			if (line.includes("*/")) inBlockComment = false;
			return;
		}
		const trimmed = line.trim();
		if (trimmed.startsWith("/*")) {
			if (!line.includes("*/")) inBlockComment = true;
			return;
		}
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

		const decl = FUNCTION_DECL.exec(line);
		if (decl) fn = decl[1] ?? decl[2] ?? fn;

		for (const m of line.matchAll(/\$\{([^{}]*)\}/g)) {
			const expr = m[1] ?? "";
			// A fallback string can mention the word without reading the field:
			// protect.ts says `?? "does not meet the rule body contract"`. Match
			// against code only, never against quoted text.
			const code = expr.replace(/"[^"]*"|'[^']*'/g, "");
			if (!TAINTED_FIELD.test(code)) continue;
			// A numeric read of a tainted field is inert.
			if (/\.length\b/.test(code)) continue;
			if (SANITIZER.test(code)) continue;
			findings.push({ file, line: i + 1, fn, text: m[0] });
		}
	});
	return findings;
}

describe("sanitize.ts rendering contract", () => {
	const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

	it("finds source files to audit at all", () => {
		expect(files.length).toBeGreaterThan(30);
	});

	it("every model-derived interpolation is sanitized or explicitly exempt", () => {
		const unexplained: string[] = [];
		for (const file of files) {
			const source = readFileSync(join(srcDir, file), "utf8");
			for (const f of findUnsanitizedRenders(source, file)) {
				const key = `${f.file}:${f.fn}`;
				if (ALLOWED.has(key)) continue;
				unexplained.push(
					`${f.file}:${f.line} in ${f.fn}() renders ${f.text} without displayText`,
				);
			}
		}
		expect(unexplained).toEqual([]);
	});

	it("catches a reintroduced violation", () => {
		// A guard nobody has watched fail is not yet a guard. This is the exact
		// shape select.ts carried until it was fixed.
		const source = [
			"function reportLine(rule: RuleRow): string {",
			'\treturn `  rule ${rule.id}: "${rule.body}"`;',
			"}",
		].join("\n");
		const found = findUnsanitizedRenders(source, "example.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.fn).toBe("reportLine");
	});

	it("accepts the sanitized form of that same line", () => {
		const source = [
			"function reportLine(rule: RuleRow): string {",
			'\treturn `  rule ${rule.id}: "${displayText(rule.body)}"`;',
			"}",
		].join("\n");
		expect(findUnsanitizedRenders(source, "example.ts")).toEqual([]);
	});

	it("ignores numeric reads and commentary", () => {
		const source = [
			"function describe(rule: RuleRow): string {",
			"\t// renders it as `- ${rule.body}` with no escaping of its own",
			"\treturn `${rule.body.length} chars`;",
			"}",
		].join("\n");
		expect(findUnsanitizedRenders(source, "example.ts")).toEqual([]);
	});

	it("every allowlist entry still matches a real site", () => {
		// An exemption that no longer applies is a licence nobody revoked.
		const live = new Set<string>();
		for (const file of files) {
			const source = readFileSync(join(srcDir, file), "utf8");
			for (const f of findUnsanitizedRenders(source, file)) {
				live.add(`${f.file}:${f.fn}`);
			}
		}
		expect([...ALLOWED.keys()].filter((k) => !live.has(k))).toEqual([]);
	});
});
