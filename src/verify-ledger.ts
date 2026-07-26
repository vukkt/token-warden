/**
 * Ledger verification gate — team-shared rule ledgers, increment 3.
 *
 * CLI: npx tsx src/verify-ledger.ts [file...]   (default: .warden/*.rules.md)
 *
 * Validates that committed shared-ledger files are well-formed: each must
 * contain a parseable, schema-valid machine-readable block, and every rule in
 * that block must also appear in the human-readable prose above it. Exits
 * non-zero if any file fails, so a CI job can gate a PR that corrupts a
 * ledger. Deterministic and offline — spends no model tokens and needs no
 * secrets.
 *
 * WHAT THIS DOES NOT GUARANTEE. The check is STRUCTURAL, not cryptographic.
 * There is no signature, no MAC, no content hash and no provenance record, so
 * it establishes nothing about *who* wrote a ledger or whether it was altered
 * in transit: a well-formed block authored by anyone at all passes, and an
 * attacker who can edit the file can equally re-render the prose to match. Its
 * honest value is (a) catching accidental corruption and truncation, and (b)
 * catching the divergence attack where the JSON block and the prose a reviewer
 * reads disagree, which is the only tampering a text diff would not show.
 * Trust in a ledger comes from git — reviewed diffs, signed commits, branch
 * protection — plus the fact that an imported rule is re-measured locally
 * before it can enter memory. The deeper gate (re-measuring each rule's delta
 * in CI) requires a benchmark token budget and is a deployment choice (see
 * README).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_LEDGER_BYTES, parseLedgerFile } from "./adopt.js";
import { runCli } from "./cli.js";
import { displayText } from "./sanitize.js";
import { LEDGER_MARKER } from "./share.js";

export interface VerifyResult {
	file: string;
	ok: boolean;
	reason: string;
	ruleCount: number;
}

/**
 * Validate one ledger file's content. Pure — no I/O.
 *
 * Two checks: the machine-readable block parses against the import schema, and
 * every rule body in it is present verbatim in the prose above the marker.
 * The second exists because the two halves have different audiences — a
 * reviewer reads the bullet list, `adopt.ts` reads only the JSON — so a ledger
 * whose halves disagree is either corrupt or crafted to smuggle a rule past
 * review.
 */
export function verifyLedgerContent(
	file: string,
	content: string,
): VerifyResult {
	const ledger = parseLedgerFile(content);
	if (ledger === null) {
		return {
			file,
			ok: false,
			reason:
				"no valid token-warden ledger block (missing/corrupt/hand-edited?)",
			ruleCount: 0,
		};
	}
	// Everything before the marker (or, in a ledger written without one, before
	// the fence) is what a reviewer reads. Deliberately NOT the whole file:
	// searching the JSON block for its own bodies would make this check
	// vacuous.
	const markerIndex = content.indexOf(LEDGER_MARKER);
	const cut = markerIndex >= 0 ? markerIndex : content.indexOf("```json");
	const prose = cut >= 0 ? content.slice(0, cut) : "";
	const hidden = ledger.rules.find((rule) => !prose.includes(rule.body));
	if (hidden !== undefined) {
		return {
			file,
			ok: false,
			reason:
				"a rule in the machine-readable block is missing from the " +
				"human-readable section above it (the reviewed text and the " +
				"imported text disagree)",
			ruleCount: ledger.rules.length,
		};
	}
	return { file, ok: true, reason: "ok", ruleCount: ledger.rules.length };
}

/** Explicit args, or every `.warden/*.rules.md` under the current directory. */
export function collectLedgerFiles(args: string[], cwd: string): string[] {
	if (args.length > 0) return args;
	const dir = join(cwd, ".warden");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".rules.md"))
		.sort()
		.map((f) => join(dir, f));
}

/** Read and verify one file. A file that is unreadable, not a regular file, or
 * larger than the import cap is a FAIL with a reason, not a crash — a CI gate
 * that dies on the first odd path reports nothing about the rest. */
function verifyOneFile(file: string): VerifyResult {
	try {
		const stat = statSync(file);
		if (!stat.isFile()) {
			return { file, ok: false, reason: "not a regular file", ruleCount: 0 };
		}
		if (stat.size > MAX_LEDGER_BYTES) {
			return {
				file,
				ok: false,
				reason: `too large to be a ledger: ${stat.size} bytes (max ${MAX_LEDGER_BYTES})`,
				ruleCount: 0,
			};
		}
		return verifyLedgerContent(file, readFileSync(file, "utf8"));
	} catch (err) {
		return {
			file,
			ok: false,
			reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
			ruleCount: 0,
		};
	}
}

export function main(argv: string[]): number {
	const files = collectLedgerFiles(argv, process.cwd());
	if (files.length === 0) {
		console.log("No ledger files to verify (.warden/*.rules.md).");
		return 0;
	}
	let failed = 0;
	for (const file of files) {
		const result = verifyOneFile(file);
		// The path comes from argv or from a directory a PR author controls, and
		// the reason can quote an OS error containing it: both go through the
		// shared sanitizer so no filename can forge a CI log line.
		console.log(
			`${result.ok ? "ok  " : "FAIL"} ${displayText(result.file, 400)} — ` +
				`${result.ok ? `${result.ruleCount} rule(s)` : displayText(result.reason, 400)}`,
		);
		if (!result.ok) failed++;
	}
	console.log(
		failed === 0
			? `All ${files.length} ledger(s) valid.`
			: `${failed} of ${files.length} ledger(s) invalid.`,
	);
	return failed === 0 ? 0 : 1;
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	return main(process.argv.slice(2));
});
/* v8 ignore stop */
