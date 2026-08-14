/**
 * GUARDS validation/ AGAINST A BREAK TYPECHECK CANNOT SEE.
 *
 * `validation/` is outside tsconfig's `include`, so `tsc --noEmit` never looks
 * at it. A shared-module extraction that moves a symbol out of `src/a.ts` into
 * `src/b.ts` therefore leaves any `validation/` importer of `src/a.js` broken
 * with nothing failing: not the typecheck, not the tests, not the lint. The
 * script simply refuses to LOAD the next time somebody runs it.
 *
 * That happened. `validation/full-loop-experiment.ts` imported `contextCost`
 * from `../src/distill.js`; the v0.41.0 extraction moved it to `src/rules.ts`
 * and distill.ts re-exports nothing, so the script died at module load with
 * "does not provide an export named 'contextCost'". It went unnoticed across
 * three releases while the project's own notes listed running that experiment
 * as the next token burn — it would have failed instantly, after setup.
 *
 * HOW THIS CHECKS WITHOUT RUNNING ANYTHING. Several validation scripts execute
 * their whole report at module scope (`process.exit(main())`), so importing one
 * to inspect it would run a full Monte-Carlo and then kill the test process.
 * So the validation file is only ever READ as text; the modules actually
 * imported are the `src/` targets, which are side-effect-free libraries the
 * rest of the suite already imports.
 *
 * Type-only bindings are skipped: they are erased before runtime and are
 * already covered by the typecheck for anything inside `src/`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const validationDir = join(repoRoot, "validation");

interface SrcImport {
	/** The validation file doing the importing. */
	file: string;
	/** Module specifier as written, e.g. "../src/rules.js". */
	specifier: string;
	/** Runtime binding names, `as` aliases resolved back to the exported name. */
	names: string[];
}

/** Named imports of `../src/*.js`, as written. Text only — nothing is loaded. */
function srcImports(file: string): SrcImport[] {
	const source = readFileSync(join(validationDir, file), "utf8");
	const out: SrcImport[] = [];
	// Only the braced form carries names to check. `[^}]*` cannot cross a closing
	// brace, so a match can never span two import statements — an earlier version
	// used a lazy `[\s\S]*?` and swallowed the intervening `import Database from
	// "better-sqlite3";` into the clause it was parsing.
	const pattern =
		/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"(\.\.\/src\/[^"]+)"/g;
	for (const match of source.matchAll(pattern)) {
		// `import type { … }` erases entirely.
		if (match[1] !== undefined) continue;
		const specifier = match[3] as string;
		const names = (match[2] as string)
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0 && !/^type\b/.test(part))
			// "foo as bar" is an export named foo.
			.map((part) => (part.split(/\s+as\s+/)[0] as string).trim());
		if (names.length > 0) out.push({ file, specifier, names });
	}
	return out;
}

const files = readdirSync(validationDir).filter((f) => f.endsWith(".ts"));
const imports = files.flatMap(srcImports);

describe("validation/ imports resolve against src/", () => {
	it("found validation scripts importing src/", () => {
		// If this ever drops to nothing the parser has broken, and every
		// assertion below would pass vacuously — the failure mode this whole
		// file exists to prevent.
		expect(files.length).toBeGreaterThan(5);
		expect(imports.length).toBeGreaterThan(10);
	});

	it.each(
		imports.map((i) => [`${i.file} -> ${i.specifier}`, i] as const),
	)("%s", async (_label, entry) => {
		const target = join(
			repoRoot,
			"src",
			`${(entry.specifier.split("/").pop() as string).replace(/\.js$/, "")}.ts`,
		);
		const mod: Record<string, unknown> = await import(
			pathToFileURL(target).href
		);
		for (const name of entry.names) {
			expect(
				Object.hasOwn(mod, name),
				`${entry.file} imports { ${name} } from ${entry.specifier}, which does not export it`,
			).toBe(true);
		}
	});
});
