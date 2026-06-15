/**
 * Ledger verification gate — team-shared rule ledgers, increment 3.
 *
 * CLI: npx tsx src/verify-ledger.ts [file...]   (default: .warden/*.rules.md)
 *
 * Validates that committed shared-ledger files are well-formed: each must
 * contain a parseable, schema-valid machine-readable block. Exits non-zero if
 * any file fails, so a CI job can gate a PR that hand-edits or corrupts a
 * ledger. Deterministic and offline — spends no model tokens and needs no
 * secrets. The deeper gate (re-measuring each rule's delta in CI) requires a
 * benchmark token budget and is a deployment choice (see README).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLedgerFile } from "./adopt.js";

export interface VerifyResult {
	file: string;
	ok: boolean;
	reason: string;
	ruleCount: number;
}

/** Validate one ledger file's content. Pure — no I/O. */
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

function main(argv: string[]): number {
	const files = collectLedgerFiles(argv, process.cwd());
	if (files.length === 0) {
		console.log("No ledger files to verify (.warden/*.rules.md).");
		return 0;
	}
	let failed = 0;
	for (const file of files) {
		const result = verifyLedgerContent(file, readFileSync(file, "utf8"));
		console.log(
			`${result.ok ? "ok  " : "FAIL"} ${file} — ` +
				`${result.ok ? `${result.ruleCount} rule(s)` : result.reason}`,
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

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
