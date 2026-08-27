import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

	/**
	 * Comments are NOT usage, and this guard used to think they were.
	 *
	 * `consumers` is raw file text, so a `\b<name>\b` match was satisfied by any
	 * mention -- including a test comment explaining what a constant means. That
	 * is how `distill.ts#MIN_PRIOR_RUNS` stayed `export`ed after the only command
	 * that read it was deleted: two test comments name it, no code imports it,
	 * and the guard reported clean. Stripping comments first is the difference
	 * between "somebody wrote this word down" and "somebody calls this".
	 *
	 * Over-stripping is the safe direction: it can only turn a real use
	 * invisible, which FAILS the build and gets looked at. Under-stripping is
	 * what let the export through silently.
	 */
	const stripComments = (src: string): string =>
		src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

	/** Every file that could legitimately reference a src export, keyed by its
	 * repo-relative path so a file is excluded from its own audit by IDENTITY
	 * rather than by comparing text that has since been rewritten. */
	const consumers = new Map<string, string>();
	for (const dir of ["src", "test", "validation"]) {
		let entries: string[] = [];
		try {
			entries = readdirSync(join(repoRoot, dir));
		} catch {
			continue; // validation/ is optional in a trimmed checkout
		}
		for (const f of entries) {
			if (f.endsWith(".ts")) {
				consumers.set(
					`${dir}/${f}`,
					stripComments(readFileSync(join(repoRoot, dir, f), "utf8")),
				);
			}
		}
	}

	it("finds source files to audit at all", () => {
		expect(srcFiles.length).toBeGreaterThanOrEqual(20);
		expect(consumers.size).toBeGreaterThanOrEqual(50);
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

				const usedElsewhere = [...consumers].some(
					([path, body]) => path !== `src/${file}` && word.test(body),
				);
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

/**
 * THE README'S OWN NUMBERS ARE TRUE.
 *
 * The stats block at the top of README.md is the first thing a reader sees, and
 * it has silently drifted after almost every deletion in this rework -- module
 * counts, test counts, coverage, source size. Hand-restamping it has now been
 * done five times and been wrong on several of those. For a project whose only
 * real claim is that it does not overstate, a stale front page is the worst
 * place to be sloppy.
 *
 * WHAT IS PINNED here is everything derivable from the tree without running
 * anything: version, module count, command count, test-file count, and source
 * size. Those cannot drift again without this failing.
 *
 * WHAT IS NOT, and why the README states them approximately rather than
 * exactly:
 *
 *  - TEST COUNT cannot be counted statically. `it.each` expands at runtime, so
 *    the 35 files hold 768 literal `it(` calls and vitest reports 921. Any
 *    static number would be a different number, confidently wrong.
 *  - COVERAGE requires a coverage run, and a guard that reads a report only
 *    when one happens to be present passes vacuously the rest of the time --
 *    the exact failure this suite has already shipped twice.
 *
 * So the README says "~920" and "96%", which small drift cannot falsify, and
 * this guard covers the rest exactly. Approximate-and-true beats
 * precise-and-stale.
 */
describe("README stats block matches the repository", () => {
	const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
	const stats = readme.slice(
		readme.indexOf("```text"),
		readme.indexOf("```", readme.indexOf("```text") + 7),
	);

	it("finds the stats block at all", () => {
		expect(stats).toContain("version");
		expect(stats).toContain("commands");
	});

	it("states the shipped version", () => {
		const version = JSON.parse(
			readFileSync(join(repoRoot, "package.json"), "utf8"),
		).version;
		expect(stats).toContain(version);
	});

	it("states the real module and command counts", () => {
		const modules = readdirSync(join(repoRoot, "src")).filter((f) =>
			f.endsWith(".ts"),
		).length;
		const commands = readdirSync(join(repoRoot, "commands")).filter((f) =>
			f.endsWith(".md"),
		).length;
		expect(stats).toContain(`${modules} modules`);
		expect(stats).toContain(`commands    ${commands}`);
	});

	it("states the real test-file count", () => {
		const files = readdirSync(join(repoRoot, "test")).filter((f) =>
			f.endsWith(".test.ts"),
		).length;
		expect(stats).toContain(`across ${files} files`);
	});

	it("states the source size to the nearest tenth of a thousand lines", () => {
		const total = readdirSync(join(repoRoot, "src"))
			.filter((f) => f.endsWith(".ts"))
			.reduce(
				(sum, f) =>
					sum +
					readFileSync(join(repoRoot, "src", f), "utf8").split("\n").length -
					1,
				0,
			);
		const claimed = /([\d.]+)k lines/.exec(stats)?.[1];
		expect(claimed, "README states no source size").toBeDefined();
		// Rounded to 0.1k, so a handful of lines does not fail the build -- but a
		// deletion of any real size does.
		expect(Number(claimed)).toBeCloseTo(total / 1000, 1);
	});
});

/**
 * EVERY DIRECTORY OF TYPESCRIPT IS ACTUALLY CHECKED.
 *
 * `validation/` holds 3,864 lines of measurement harness -- including
 * `stream-calibration.ts`, whose output is the evidence for the shipped
 * `confidenceZ()` default of 1.5. For most of this project's life tsconfig's
 * `include` was `["src", "test"]`, so only the validation files a TEST happened
 * to import were typechecked. Six were not, totalling 1,456 lines, and a
 * deliberate `const x: number = "string"` in `stream-calibration.ts` passed
 * `npm run typecheck` cleanly.
 *
 * That is the failure mode this repository keeps producing: a check that
 * reports success while looking at nothing. knip's `@public` tag did it, knip
 * being blind to test-only imports did it, `biome check` exiting 0 on warnings
 * did it, and `knip.json` never listing `ragbench.ts` did it.
 *
 * The cost here is specific rather than theoretical. A harness that silently
 * stops compiling is discovered at the moment someone tries to reproduce a
 * published number -- which is exactly when it needs to work.
 */
describe("every TypeScript directory is in scope", () => {
	const CHECKED_DIRS = ["src", "test", "validation"];

	it("tsconfig typechecks every directory holding TypeScript", () => {
		const tsconfig = JSON.parse(
			readFileSync(join(repoRoot, "tsconfig.json"), "utf8"),
		);
		for (const dir of CHECKED_DIRS) {
			expect(
				tsconfig.include,
				`${dir}/ holds TypeScript but tsconfig does not include it, so ` +
					"`tsc --noEmit` reports clean without reading most of it",
			).toContain(dir);
		}
	});

	/**
	 * The general form, rather than a list of directories someone has to
	 * remember to extend. Naming `validation` fixed the case that had already
	 * gone wrong; this catches the NEXT one -- a `.ts` file added at the root,
	 * or in a new directory, that no `include` entry reaches.
	 *
	 * It found `.perfcheck.ts`: a tracked root dotfile importing from
	 * `src/db.js`, referenced by no script, workflow or config, outside
	 * typecheck scope, and answering a question that shipped long ago.
	 */
	it("leaves no TypeScript file outside tsconfig's reach", () => {
		const tsconfig = JSON.parse(
			readFileSync(join(repoRoot, "tsconfig.json"), "utf8"),
		);
		const include: string[] = tsconfig.include;

		// Everything git tracks, so build output and node_modules cannot appear.
		const tracked = execSync("git ls-files -- '*.ts'", {
			cwd: repoRoot,
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean)
			// The frozen fixture is a benchmark input, deliberately not compiled.
			.filter((f) => !f.startsWith("benchmarks/"));

		// CANARY FIRST. `unreachable` is a filter over `tracked`, so an empty
		// `tracked` yields an empty result and this guard passes having examined
		// nothing -- if git is absent, the cwd is not a repository, or the
		// pathspec is ever mistyped. That is the precise failure this suite has
		// now shipped four times, and it went into THIS test the day it was
		// written. Assert the scan found the tree before trusting its verdict.
		expect(
			tracked.length,
			"git ls-files returned no TypeScript; the scan below would pass vacuously",
		).toBeGreaterThan(50);
		expect(tracked).toContain("src/select.ts");

		const unreachable = tracked.filter(
			(f) => !include.some((inc) => f === inc || f.startsWith(`${inc}/`)),
		);

		expect(
			unreachable,
			"these .ts files are tracked but no tsconfig `include` entry reaches " +
				"them, so `tsc --noEmit` never reads them",
		).toEqual([]);
	});

	it("knip analyses every directory holding TypeScript", () => {
		const knip = JSON.parse(readFileSync(join(repoRoot, "knip.json"), "utf8"));
		const project: string[] = knip.project;
		for (const dir of CHECKED_DIRS.filter((d) => d !== "test")) {
			expect(
				project.some((p) => p.startsWith(`${dir}/`)),
				`${dir}/ is outside knip's "project", so knip cannot see dead code in it`,
			).toBe(true);
		}
	});

	it("every UNIMPORTED validation harness is a knip entry", () => {
		// These are standalone CLI harnesses. Nothing imports them, so without an
		// explicit entry knip reports each as an unused FILE rather than analysing
		// what is dead inside it.
		//
		// Only the unimported ones. A harness a test already imports is reachable
		// through knip's vitest plugin, and adding a redundant `entry` line makes
		// knip emit a configuration hint -- which, as the knip-sees-every-command
		// block above records, invites a future cleanup that removes the real one.
		const knip = JSON.parse(readFileSync(join(repoRoot, "knip.json"), "utf8"));
		const entries: string[] = knip.entry;

		const importers = [
			...readdirSync(join(repoRoot, "test")).map((f) => join("test", f)),
			...readdirSync(join(repoRoot, "validation")).map((f) =>
				join("validation", f),
			),
		]
			.filter((f) => f.endsWith(".ts"))
			.map((f) => [f, readFileSync(join(repoRoot, f), "utf8")] as const);

		const files = readdirSync(join(repoRoot, "validation")).filter((f) =>
			f.endsWith(".ts"),
		);
		expect(files.length).toBeGreaterThan(5);

		for (const f of files) {
			const self = join("validation", f);
			const imported = importers.some(
				([path, body]) =>
					path !== self && body.includes(`validation/${f.slice(0, -3)}.js`),
			);
			if (imported) continue;
			expect(
				entries,
				`validation/${f} is imported by nothing, so knip needs it as an entry ` +
					"to look inside it at all",
			).toContain(`validation/${f}`);
		}
	});
});

/**
 * DOCSTRINGS THAT DESCRIBE A REPOSITORY THAT NO LONGER EXISTS.
 *
 * v1.0.0 deleted 23 modules and ten commands. The survivors' headers went on
 * explaining themselves in terms of the dead ones -- `rules.ts` justified its
 * own existence by naming five callers, ALL FIVE of which had been deleted;
 * `memory.ts` cited two commands that were gone; `bench.ts` said a class of
 * recorded row was "handled where they are read (`compare.ts`)", which was no
 * longer true anywhere, because nothing replaced the re-derivation when that
 * module went.
 *
 * That last one is the reason this is a guard and not a tidy-up. A reader
 * chasing a correctness claim to a file that does not exist cannot tell
 * whether the handling moved or evaporated, and here it had evaporated.
 *
 * Backticked `x.ts` and `/warden-x` references are checked because those are
 * the forms this repo uses for a real file or command. Past-tense history is
 * explicitly allowed -- this project keeps its corrections -- so a mention is
 * only a failure when nothing near it marks the thing as gone.
 */
describe("no docstring points at a file or command that was deleted", () => {
	/** Words that mark a reference as history rather than a live claim. */
	const PAST_MARKERS =
		/\b(deleted|removed|gone|gave way|gave up|gone with|gone in|gone at|since|gone,|was |were |used to|gone\.|no longer|gone --|expired|evaporated|dead|old |gone;|previously|gone -)/i;

	function livingFile(name: string): boolean {
		return ["src", "validation", "test", "scripts"].some((d) =>
			existsSync(join(repoRoot, d, name)),
		);
	}

	/**
	 * Context for a mention is its whole COMMENT BLOCK, not its neighbouring
	 * lines. A header explaining a deletion routinely names the dead modules in
	 * one sentence and marks them dead in the next, several lines down; a
	 * three-line window called those stale and would have pushed the marker
	 * next to every name just to satisfy the check.
	 */
	function blockAround(lines: string[], index: number): string {
		let start = index;
		while (start > 0 && !/^\s*(\/\*|$)/.test(lines[start] as string)) start--;
		let end = index;
		while (end < lines.length - 1 && !/\*\/\s*$/.test(lines[end] as string))
			end++;
		return lines.slice(start, end + 1).join(" ");
	}

	it("names only modules that exist, or marks the mention as history", () => {
		const sources = readdirSync(join(repoRoot, "src")).filter((f) =>
			f.endsWith(".ts"),
		);
		expect(
			sources.length,
			"read no sources; the scan below would pass vacuously",
		).toBeGreaterThan(15);

		const stale: string[] = [];
		for (const file of sources) {
			const lines = readFileSync(join(repoRoot, "src", file), "utf8").split(
				"\n",
			);
			lines.forEach((line, i) => {
				for (const m of line.matchAll(/`([a-z][a-z0-9-]*\.ts)`/g)) {
					const named = m[1] as string;
					if (livingFile(named)) continue;
					// Allowed when the surrounding block marks it as history.
					if (PAST_MARKERS.test(blockAround(lines, i))) continue;
					stale.push(`src/${file}:${i + 1} names ${named}`);
				}
			});
		}
		expect(stale, stale.join("\n")).toEqual([]);
	});

	it("names only commands that exist, or marks the mention as history", () => {
		const commands = readdirSync(join(repoRoot, "commands")).filter((f) =>
			f.endsWith(".md"),
		);
		expect(
			commands.length,
			"read no commands; the scan below would pass vacuously",
		).toBeGreaterThan(3);
		const live = new Set(commands.map((f) => `/${f.slice(0, -3)}`));

		const stale: string[] = [];
		for (const file of readdirSync(join(repoRoot, "src")).filter((f) =>
			f.endsWith(".ts"),
		)) {
			const lines = readFileSync(join(repoRoot, "src", file), "utf8").split(
				"\n",
			);
			lines.forEach((line, i) => {
				for (const m of line.matchAll(/`(\/warden-[a-z-]+)`/g)) {
					if (live.has(m[1] as string)) continue;
					if (PAST_MARKERS.test(blockAround(lines, i))) continue;
					stale.push(`src/${file}:${i + 1} names ${m[1]}`);
				}
			});
		}
		expect(stale, stale.join("\n")).toEqual([]);
	});
});

/**
 * THE PLUGIN MANIFEST DESCRIBES THE PLUGIN THAT EXISTS.
 *
 * `.claude-plugin/plugin.json` holds the install-time copy -- the most widely
 * READ text in the repository and the least often edited, which is exactly the
 * combination that rots. After v1.0.0 it still advertised per-tool/skill/MCP
 * cost attribution, model and prompt A/B benchmarking, and team-shareable rule
 * ledgers: every one of those commands and modules had been deleted. It also
 * claimed 98% test coverage against a real 96.1% lines / 89.8% branches.
 *
 * A docstring that lies costs a maintainer an hour. This costs a stranger
 * their first impression, and it is the one file no test had ever looked at.
 */
describe("the plugin manifest is true", () => {
	const manifest = JSON.parse(
		readFileSync(join(repoRoot, ".claude-plugin", "plugin.json"), "utf8"),
	);

	it("states the same version as package.json", () => {
		const pkg = JSON.parse(
			readFileSync(join(repoRoot, "package.json"), "utf8"),
		);
		expect(manifest.version).toBe(pkg.version);
	});

	it("advertises no capability whose command was deleted", () => {
		const commands = readdirSync(join(repoRoot, "commands")).filter((f) =>
			f.endsWith(".md"),
		);
		expect(
			commands.length,
			"read no commands; the scan below would pass vacuously",
		).toBeGreaterThan(3);

		// Each word is the distinctive noun of a capability the manifest once
		// promised and the tree no longer provides. A word is allowed back only
		// when a command or module actually restores the feature.
		const removed = [
			["attribution", "attribute"],
			["modelbench", "modelbench"],
			["promptbench", "promptbench"],
			["shareable", "share"],
		] as const;

		const text: string = manifest.description.toLowerCase();
		for (const [word, slug] of removed) {
			const restored =
				commands.includes(`warden-${slug}.md`) ||
				existsSync(join(repoRoot, "src", `${slug}.ts`));
			if (restored) continue;
			expect(
				text,
				`the manifest advertises "${word}" but nothing implements it — ` +
					"this is the install-time copy a stranger reads first",
			).not.toContain(word);
		}
	});

	it("claims no coverage figure the suite does not meet", () => {
		// A bare percentage in the description is a claim the CI floor must
		// already enforce; the floor is the only number that cannot drift.
		const claimed = /(\d{2,3})%\s*test coverage/i.exec(manifest.description);
		if (claimed === null) return; // no claim is the safest claim
		const config = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
		const floor = /lines:\s*(\d+)/.exec(config)?.[1];
		expect(floor, "vitest.config.ts states no lines floor").toBeDefined();
		expect(Number(claimed[1])).toBeLessThanOrEqual(Number(floor));
	});
});

/**
 * The README's migration count is the schema's, not a memory of it.
 *
 * Three separate figures in that file had drifted by the time anyone looked:
 * the test count, the source size, and this one — the README said 16 versioned
 * migrations against a real 17. Migrations are append-only, so this number only
 * ever grows, which is exactly the kind of figure nobody thinks to re-check.
 */
describe("the README's migration count is the real one", () => {
	it("matches MIGRATION_COUNT", async () => {
		const { MIGRATION_COUNT } = await import("../src/db.js");
		const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
		const claimed = /(\d+) versioned migrations/.exec(readme);
		expect(claimed, "README states no migration count").not.toBeNull();
		expect(Number((claimed as RegExpExecArray)[1])).toBe(MIGRATION_COUNT);
	});
});

/**
 * NO MARKDOWN LINK POINTS AT A FILE THAT IS NOT THERE.
 *
 * A dead link in a README is the cheapest possible way to look careless, and
 * this repository generates them structurally: it deletes modules on purpose,
 * and it keeps the prose that measured them. `FINDINGS.md` linked
 * `[src/moderate.ts](src/moderate.ts)` for three releases after the module was
 * deleted — the sentence around it was correct, the link was rubble.
 *
 * Prose may still NAME a deleted file (that is history, and the docstring guard
 * above governs it). What it may not do is offer a link that 404s.
 */
describe("every relative markdown link resolves", () => {
	it("finds no link to a missing file", () => {
		const docs = execSync("git ls-files '*.md'", {
			cwd: repoRoot,
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean)
			// The frozen fixture is benchmark input, not documentation.
			.filter((f) => !f.startsWith("benchmarks/"));
		expect(
			docs.length,
			"git ls-files returned no markdown; the scan below would pass vacuously",
		).toBeGreaterThan(5);
		expect(docs).toContain("README.md");

		const broken: string[] = [];
		for (const doc of docs) {
			const dir = dirname(join(repoRoot, doc));
			const body = readFileSync(join(repoRoot, doc), "utf8");
			for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
				const href = m[1] as string;
				// External, anchor-only, and absolute links are somebody else's
				// problem; only repo-relative paths are checkable here.
				if (/^(https?:|mailto:|#|\/)/.test(href)) continue;
				const target = join(dir, href.split("#")[0] as string);
				if (!existsSync(target)) broken.push(`${doc} -> ${href}`);
			}
		}
		expect(broken, broken.join("\n")).toEqual([]);
	});
});
