import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards against invisible non-text bytes in source. A stray NUL or ANSI/
 * control byte compiles fine and passes other tests, but makes tools treat
 * the file as binary and is not production-clean. (We once shipped two NUL
 * bytes as a map-key delimiter in attribute.ts.) Adversarial inputs in tests
 * must be written as JS escapes (\x00, \x1b, …), not literal bytes.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function disallowedBytes(buf: Buffer): number[] {
	const offsets: number[] = [];
	for (let i = 0; i < buf.length; i++) {
		const b = buf[i] as number;
		if ((b < 0x20 && !ALLOWED_CONTROL.has(b)) || b === 0x7f) offsets.push(i);
	}
	return offsets;
}

describe("source hygiene", () => {
	const files = [
		...tsFiles(join(repoRoot, "src")),
		...tsFiles(join(repoRoot, "test")),
	];

	it("finds source files to scan", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it.each(files)("%s contains no NUL or disallowed control bytes", (file) => {
		const offsets = disallowedBytes(readFileSync(file));
		expect(
			offsets,
			`disallowed bytes at offsets ${offsets.join(", ")}`,
		).toEqual([]);
	});
});

/**
 * Every command module must be an ENTRY in knip.json.
 *
 * knip is the guard that caught the v0.41.0 false shipping claim, where the
 * SQLITE_BUSY machinery was written, tested, and never connected to a call
 * site. It only works on what it can reach from an entry, and its vitest
 * plugin makes every `test/*.test.ts` an entry too — so a module reachable
 * ONLY from its own test still looks used. A command absent from `entry` is
 * therefore not merely unchecked; it is checked in a way that reports clean.
 *
 * The guard exists because of `src/ragbench.ts`, which shipped in v0.42.0 as
 * `/warden-ragbench` and was never added, putting its whole subtree — corpus,
 * retrieve, extract, interrogate, 2,271 lines — outside the check. Adding it
 * immediately surfaced two exports (`isStrategy`, `extractFromStdout`) that
 * were written and tested and called from nowhere. That subtree was removed
 * wholesale in v1.0.0; the guard it motivated stays, because the failure mode
 * it catches is a property of the knip config, not of that one module.
 */
describe("knip sees every command", () => {
	/**
	 * Entrypoints knip reaches through a PLUGIN rather than through `entry`,
	 * named so the exception is a decision rather than an oversight. Adding a
	 * redundant `entry` line for these makes knip emit a configuration hint,
	 * which invites a future cleanup that would silently remove the real one.
	 */
	const REACHED_BY_PLUGIN = new Map([
		[
			"src/status.ts",
			"referenced by .github/workflows/ci.yml (knip CI plugin)",
		],
	]);

	const knipEntries: string[] = JSON.parse(
		readFileSync(join(repoRoot, "knip.json"), "utf8"),
	).entry;

	// A command module is one carrying the shared CLI entry shim. The four
	// fail-open hooks (collect, notify, gate, distill) use their own shim and
	// are listed in knip.json on their own account.
	const commandModules = readdirSync(join(repoRoot, "src"))
		.filter((f) => f.endsWith(".ts"))
		.filter((f) =>
			readFileSync(join(repoRoot, "src", f), "utf8").includes(
				"runCli(import.meta.url",
			),
		)
		.map((f) => `src/${f}`);

	it("finds the command modules to check", () => {
		// v1.0.0 cut the command surface from 22 to 6; five of those carry the
		// shared shim (bench.ts is run directly by /warden-bench and has none).
		// The floor is a canary against an empty scan, so it tracks the real
		// count rather than a comfortable margin above it.
		expect(commandModules.length).toBeGreaterThanOrEqual(5);
		// A canary on the DISCOVERY, not on any one command: if the shim string
		// is ever reworded, the filter above silently matches nothing and every
		// `it.each` case below vanishes, leaving a suite that passes while
		// checking no commands at all. `select.ts` is the gate itself, so it is
		// the last module that could legitimately stop being a command.
		expect(commandModules).toContain("src/select.ts");
	});

	it.each(commandModules)("%s is a knip entry", (module) => {
		if (REACHED_BY_PLUGIN.has(module)) {
			expect(REACHED_BY_PLUGIN.get(module)).toBeTruthy();
			return;
		}
		expect(
			knipEntries,
			`${module} is a command but is not in knip.json "entry", so knip cannot ` +
				"see dead code beneath it. Add it, or record it in REACHED_BY_PLUGIN " +
				"with the reason.",
		).toContain(module);
	});
});

/**
 * MODULE BOUNDARIES ARE HONEST: nothing is `export`ed that nothing can use.
 *
 * knip does not catch this class. Its `ignoreExportsUsedInFile: true` suppresses
 * any export that is also referenced inside its declaring file, which is exactly
 * what an internal type or constant looks like -- so 21 gratuitous `export`
 * keywords accumulated invisibly through v1.0.0 and were removed by hand.
 *
 * The rule applied there, and enforced here, has two escape hatches because a
 * bare "is it referenced elsewhere" check gets this wrong:
 *
 *  1. Referenced anywhere outside its own file -- genuinely public.
 *  2. A TYPE appearing in an EXPORTED signature in its own file -- a caller
 *     receives or supplies this shape, so it must stay nameable even if no
 *     current call site spells it out. Un-exporting these would save seven
 *     characters and cost the caller the ability to name what it is handed.
 *
 *     This hatch is deliberately restricted to types. Applied to values it
 *     exempts EVERYTHING, because `export const X = ...` trivially contains its
 *     own name -- which is exactly how the first version of this guard passed
 *     while a re-added gratuitous export sat in front of it. A guard is not
 *     trusted here until it has been watched to fail.
 *
 * Anything else is decoration, and decoration on a module boundary is a lie
 * about what the module offers.
 */
describe("exports are reachable", () => {
	const srcFiles = readdirSync(join(repoRoot, "src")).filter((f) =>
		f.endsWith(".ts"),
	);
	const sources = new Map(
		srcFiles.map((f) => [f, readFileSync(join(repoRoot, "src", f), "utf8")]),
	);

	/** Every file that could legitimately reference a src export. */
	const consumers: string[] = [];
	for (const dir of ["src", "test", "validation"]) {
		let entries: string[] = [];
		try {
			entries = readdirSync(join(repoRoot, dir));
		} catch {
			continue; // validation/ is optional in a trimmed checkout
		}
		for (const f of entries) {
			if (f.endsWith(".ts")) {
				consumers.push(readFileSync(join(repoRoot, dir, f), "utf8"));
			}
		}
	}

	it("finds source files to audit at all", () => {
		expect(srcFiles.length).toBeGreaterThanOrEqual(20);
		expect(consumers.length).toBeGreaterThanOrEqual(50);
	});

	it("exports nothing that only its own file can see", () => {
		const gratuitous: string[] = [];

		for (const [file, source] of sources) {
			const own = source;
			// Exported signatures, for escape hatch 2: the head of every exported
			// function up to its return type, plus exported const declarations.
			const signatures = [
				...(own.match(
					/^export (?:async )?function \w+[\s\S]*?\)\s*:\s*[^{]+/gm,
				) ?? []),
				...(own.match(/^export const \w+[^=]*=/gm) ?? []),
			].join("\n");

			const declared =
				own.match(
					/^export (?:async function |function |const |interface |type |class )(\w+)/gm,
				) ?? [];

			for (const decl of declared) {
				const name = decl.split(/\s+/).pop() as string;
				const word = new RegExp(`\\b${name}\\b`);
				const isType = /\b(?:interface|type)\b/.test(decl);

				const usedElsewhere = consumers.some((c) => c !== own && word.test(c));
				if (usedElsewhere) continue;
				// Hatch 2 is TYPES ONLY. Applied to values it exempts everything,
				// because `export const X = ...` trivially contains its own name --
				// which is exactly how the first version of this guard passed while a
				// deliberately re-added gratuitous export sat in front of it.
				if (isType && word.test(signatures)) continue;

				gratuitous.push(`src/${file}: ${name}`);
			}
		}

		expect(
			gratuitous,
			"these are exported but nothing outside their own file can reach them, " +
				"and they appear in no exported signature. Drop the `export`, or " +
				"give them a caller.",
		).toEqual([]);
	});
});
