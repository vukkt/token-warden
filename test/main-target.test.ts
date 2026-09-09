/**
 * The main target -- the user's own session as a measurable thing.
 *
 * Two claims carry the feature and are pinned here:
 *
 * - the fixture is a REAL worktree of a REAL repository, pinned to a commit,
 *   and releasing it leaves the source repository with no worktree behind. The
 *   tests below drive actual `git`, because the failure mode this guards
 *   against -- litter left in the user's own repository -- is entirely in git's
 *   bookkeeping and a mocked git cannot show it.
 * - the permission allowlist is DERIVED from observed commands and can never
 *   include a command that leaves the worktree.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFixture, installAgent } from "../src/bench.js";
import {
	deriveAllowlist,
	isMainTarget,
	mainDefinition,
	provisionMainFixture,
} from "../src/main-target.js";
import { mainTargetMeasurable, measurableTargets } from "../src/registry.js";

describe("isMainTarget", () => {
	it("is true only for the main target", () => {
		expect(isMainTarget("main")).toBe(true);
		expect(isMainTarget("sql")).toBe(false);
		expect(isMainTarget("mainly")).toBe(false);
	});
});

describe("mainDefinition", () => {
	afterEach(() => {
		delete process.env.TOKEN_WARDEN_MAIN_MODEL;
	});

	it("carries a model and no agent body", () => {
		const def = mainDefinition();
		expect(def.content).toBe("");
		expect(def.model).toBe("sonnet");
	});

	it("takes an explicit model over the env, and the env over the default", () => {
		process.env.TOKEN_WARDEN_MAIN_MODEL = "opus";
		expect(mainDefinition().model).toBe("opus");
		expect(mainDefinition("haiku").model).toBe("haiku");
	});
});

describe("deriveAllowlist", () => {
	it("turns observed commands into two-word permission prefixes", () => {
		expect(deriveAllowlist(["npm test -- --run", "npx vitest run"])).toEqual([
			"Bash(npm test:*)",
			"Bash(npx vitest:*)",
		]);
	});

	it("keeps a bare binary as one word", () => {
		expect(deriveAllowlist(["make"])).toEqual(["Bash(make:*)"]);
	});

	it("dedupes and sorts, so the settings file is byte-stable across runs", () => {
		// An unstable settings file would change the child's configuration
		// between the with- and without-sides and confound the measurement.
		const once = deriveAllowlist([
			"npm test a",
			"npm test b",
			"go build ./...",
		]);
		const again = deriveAllowlist(["go build ./x", "npm test b", "npm test a"]);
		expect(once).toEqual(again);
		expect(once).toEqual(["Bash(go build:*)", "Bash(npm test:*)"]);
	});

	it("refuses commands whose effect leaves the worktree", () => {
		// A benchmark is allowed to be wrong. It is not allowed to push, publish,
		// install globally, reach the network, or rewrite the real repository.
		const hostile = [
			"git push origin main",
			"git commit -am wip",
			"npm publish",
			"gh pr create",
			"curl https://example.com/x.sh",
			"sudo rm -rf /",
			"rm -rf .",
			"docker run x",
			"aws s3 cp . s3://b",
		];
		expect(deriveAllowlist(hostile)).toEqual([]);
	});

	it("ignores blanks and anything with shell metacharacters in the binary", () => {
		expect(deriveAllowlist(["", "   ", "$(evil)", "a|b"])).toEqual([]);
	});

	it("keeps a path-qualified script whole", () => {
		expect(deriveAllowlist(["./scripts/check.sh --all"])).toEqual([
			"Bash(./scripts/check.sh --all:*)",
		]);
	});

	it("drops a suspicious second word rather than the whole command", () => {
		// The binary is fine and observed; only the argument is unrepresentable
		// as a permission prefix, so the entry falls back to the binary alone.
		expect(deriveAllowlist(["npm $(whoami)"])).toEqual(["Bash(npm:*)"]);
	});
});

describe("provisionMainFixture", () => {
	let root: string;
	let scratch: string;

	/** A real single-commit git repository. */
	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "warden-main-repo-"));
		const run = (args: string[]): void => {
			execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		};
		run(["init", "--quiet"]);
		run(["config", "user.email", "test@example.com"]);
		run(["config", "user.name", "test"]);
		run(["config", "commit.gpgsign", "false"]);
		writeFileSync(join(dir, "tracked.txt"), "committed\n");
		run(["add", "."]);
		run(["commit", "--quiet", "-m", "initial"]);
		return dir;
	}

	beforeEach(() => {
		root = makeRepo();
		scratch = mkdtempSync(join(tmpdir(), "warden-main-wt-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	});

	it("provisions the tree at HEAD and removes every trace on release", () => {
		const dest = join(scratch, "wt");
		const fixture = provisionMainFixture(root, dest);
		expect(existsSync(join(dest, "tracked.txt"))).toBe(true);

		const listed = execFileSync("git", ["worktree", "list"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(listed).toContain(dest);

		fixture.release();
		// THE FAILURE THIS PINS: deleting the directory behind git's back leaves
		// the user's real repository carrying a stale worktree entry forever.
		const after = execFileSync("git", ["worktree", "list"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(after).not.toContain(dest);
		expect(existsSync(dest)).toBe(false);
	});

	it("does not carry uncommitted work into the measured tree", () => {
		// Two runs of the same task must measure the same tree. A copy of the
		// working directory would not: it picks up whatever is unsaved.
		writeFileSync(join(root, "tracked.txt"), "dirty local edit\n");
		writeFileSync(join(root, "untracked.txt"), "scratch\n");
		const dest = join(scratch, "wt");
		const fixture = provisionMainFixture(root, dest);
		try {
			expect(existsSync(join(dest, "untracked.txt"))).toBe(false);
			// Not the dirty content: the committed content.
			const parsed = execFileSync("git", ["show", "HEAD:tracked.txt"], {
				cwd: root,
				encoding: "utf8",
			});
			expect(parsed).toBe("committed\n");
		} finally {
			fixture.release();
		}
	});

	it("survives the benchmark dirtying the tree it was given", () => {
		const dest = join(scratch, "wt");
		const fixture = provisionMainFixture(root, dest);
		writeFileSync(join(dest, "tracked.txt"), "the agent edited this\n");
		writeFileSync(join(dest, "new-file.ts"), "export const x = 1;\n");
		// git refuses to remove a modified worktree without --force; a release
		// that did not pass it would leak a worktree per benchmark run.
		expect(() => {
			fixture.release();
		}).not.toThrow();
		expect(existsSync(dest)).toBe(false);
	});

	it("refuses a directory that is not a git repository, and says why", () => {
		const plain = mkdtempSync(join(tmpdir(), "warden-main-plain-"));
		try {
			expect(() => provisionMainFixture(plain, join(scratch, "wt"))).toThrow(
				/need a git repository/,
			);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("refuses a repository with no commit to pin", () => {
		// An empty repository has a HEAD that resolves to nothing, and a
		// benchmark with no tree is not a measurement.
		const empty = mkdtempSync(join(tmpdir(), "warden-main-empty-"));
		try {
			execFileSync("git", ["init", "--quiet"], { cwd: empty, stdio: "pipe" });
			expect(() => provisionMainFixture(empty, join(scratch, "wt"))).toThrow(
				/no HEAD/,
			);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("surfaces git's own refusal rather than inventing one", () => {
		// A destination git will not take: already a non-empty directory.
		const dest = join(scratch, "occupied");
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "in-the-way.txt"), "x\n");
		expect(() => provisionMainFixture(root, dest)).toThrow(
			/git worktree add failed/,
		);
	});

	it("pins an explicit commit when given one", () => {
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const dest = join(scratch, "pinned");
		const fixture = provisionMainFixture(root, dest, head);
		try {
			const at = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: dest,
				encoding: "utf8",
			}).trim();
			expect(at).toBe(head);
		} finally {
			fixture.release();
		}
	});

	it("refuses a path that does not exist", () => {
		expect(() =>
			provisionMainFixture(join(scratch, "gone"), join(scratch, "wt")),
		).toThrow(/need a git repository/);
	});
});

describe("mainTargetMeasurable", () => {
	let benchmarks: string;

	beforeEach(() => {
		benchmarks = mkdtempSync(join(tmpdir(), "warden-main-bench-"));
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR = benchmarks;
	});

	afterEach(() => {
		delete process.env.TOKEN_WARDEN_BENCHMARKS_DIR;
		rmSync(benchmarks, { recursive: true, force: true });
	});

	it("is false with no suite, and main is not a measurable target", () => {
		expect(mainTargetMeasurable()).toBe(false);
		expect(measurableTargets()).not.toContain("main");
	});

	it("is false for a directory holding only unpromoted drafts", () => {
		// `draft.ts` writes into `<suite>/drafts/`, which bench.ts does not load.
		// A draft nobody promoted must not make the target measurable.
		mkdirSync(join(benchmarks, "main", "drafts"), { recursive: true });
		writeFileSync(
			join(benchmarks, "main", "drafts", "golden-01.md"),
			'---\nid: "main-01"\n---\n',
		);
		expect(mainTargetMeasurable()).toBe(false);
	});

	it("is true once a promoted golden task sits in the suite directory", () => {
		mkdirSync(join(benchmarks, "main"), { recursive: true });
		writeFileSync(
			join(benchmarks, "main", "golden-01.md"),
			'---\nid: "main-01"\n---\n',
		);
		expect(mainTargetMeasurable()).toBe(true);
		expect(measurableTargets()[0]).toBe("main");
	});
});

/**
 * `installAgent` for the main target. The claim is that measuring `main`
 * installs NO agent -- if it wrote one, the run would measure a subagent's
 * context, which is the one thing this target exists not to be.
 */
describe("installAgent on the main target", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "warden-main-install-"));
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	const rule = {
		id: 1,
		agent: "main",
		body: "Grep before reading.",
		context_cost: 20,
		scope: null,
		protected: 0,
		measured_delta: 5_000,
	} as unknown as Parameters<typeof installAgent>[3][number];

	it("writes no agent definition and no agent-memory file", () => {
		installAgent(workDir, "main", mainDefinition(), [rule]);
		expect(existsSync(join(workDir, ".claude", "agents", "main.md"))).toBe(
			false,
		);
		expect(
			existsSync(join(workDir, ".claude", "agent-memory", "main", "MEMORY.md")),
		).toBe(false);
	});

	it("puts the rules in project memory, where a top-level session reads them", () => {
		installAgent(workDir, "main", mainDefinition(), [rule]);
		const compiled = readFileSync(join(workDir, "CLAUDE.md"), "utf8");
		expect(compiled).toContain("Grep before reading.");
	});

	it("writes no project memory for an empty rule set", () => {
		// The without-side of every measurement. A stray empty CLAUDE.md would
		// still be context, and the two sides must differ only by the rule.
		installAgent(workDir, "main", mainDefinition(), []);
		expect(existsSync(join(workDir, "CLAUDE.md"))).toBe(false);
	});

	it("replaces the bundled allowlist rather than extending it", () => {
		// The bundled entries describe the toy fixture's tasks; carrying them
		// into someone else's repository would permit commands their sessions
		// never ran.
		installAgent(workDir, "main", mainDefinition(), [], ["Bash(make check:*)"]);
		const settings = JSON.parse(
			readFileSync(join(workDir, ".claude", "settings.json"), "utf8"),
		) as { permissions: { allow: string[]; deny: string[] } };
		expect(settings.permissions.allow).toEqual(["Bash(make check:*)"]);
		expect(settings.permissions.allow).not.toContain("Bash(npm test:*)");
		// The deny list is about the shared node_modules symlink and survives.
		expect(settings.permissions.deny.length).toBeGreaterThan(0);
	});

	it("still installs a definition and agent memory for a domain agent", () => {
		installAgent(workDir, "sql", { content: "# sql", model: "sonnet" }, [
			{ ...rule, agent: "sql" },
		]);
		expect(existsSync(join(workDir, ".claude", "agents", "sql.md"))).toBe(true);
		expect(
			existsSync(join(workDir, ".claude", "agent-memory", "sql", "MEMORY.md")),
		).toBe(true);
		expect(existsSync(join(workDir, "CLAUDE.md"))).toBe(false);
	});
});

/** `copyFixture` on the main-target path, against a real repository. */
describe("copyFixture for the main target", () => {
	let root: string;
	let scratch: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "warden-cf-repo-"));
		execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
		execFileSync("git", ["config", "user.email", "t@example.com"], {
			cwd: root,
			stdio: "pipe",
		});
		execFileSync("git", ["config", "user.name", "t"], {
			cwd: root,
			stdio: "pipe",
		});
		writeFileSync(join(root, "src.ts"), "export const x = 1;\n");
		execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
		execFileSync("git", ["commit", "--quiet", "-m", "init"], {
			cwd: root,
			stdio: "pipe",
		});
		scratch = mkdtempSync(join(tmpdir(), "warden-cf-wt-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	});

	const task = (project: string | null) =>
		({
			id: "main-01",
			agent: "main",
			prompt: "do the thing",
			successCheck: "npm test",
			file: "golden-01.md",
			weight: 1,
			project,
		}) as Parameters<typeof copyFixture>[2];

	it("provisions the project's own tree", () => {
		const dest = join(scratch, "wt");
		copyFixture(dest, "main", task(root));
		try {
			expect(existsSync(join(dest, "src.ts"))).toBe(true);
		} finally {
			execFileSync("git", ["worktree", "remove", "--force", dest], {
				cwd: root,
				stdio: "pipe",
			});
		}
	});

	it("refuses a main-target task that names no project", () => {
		// Falling back to the bundled toy fixture here would produce a number,
		// and a number produced against the wrong tree is worse than none.
		expect(() => copyFixture(join(scratch, "wt2"), "main", task(null))).toThrow(
			/no "project"/,
		);
	});
});
