/**
 * The MAIN TARGET: measuring the Claude Code session the user is already in.
 *
 * WHAT THIS REPLACES. Until now a rule could only be measured if the work ran
 * through one of four bundled domain agents, each with a frozen golden suite
 * and a toy fixture repository. `collect.ts` said so in one line -- "only
 * domain agents are distilled: rules for any other agent (incl. 'main') have no
 * golden suite and could never be measured" -- and that was true while the only
 * suites were the four shipped ones. `draft.ts` mines a runnable suite out of
 * recorded sessions, so the premise is gone.
 *
 * THREE THINGS A MEASURED TARGET NEEDS, and where `main` gets each:
 *
 *   A DEFINITION. The bundled agents have `agents/<name>.md`. `main` has none
 *   and must not have one: it is not an agent to adopt, it is the session. The
 *   synthetic definition below carries a model and nothing else, and the
 *   benchmark spawns WITHOUT `--agent`, so the child runs the same top-level
 *   configuration the recorded work ran under.
 *
 *   A SUITE. `benchmarks/<agent>/` for bundled agents; for `main`,
 *   `userBenchmarksDir()/main/`, which is exactly where `draft.ts` promotes
 *   drafts. No change to `loadGoldenTasks` was needed.
 *
 *   A FIXTURE. This is the one that could not be faked. A task mined from real
 *   work says "fix the N+1 in the orders repository" and its check runs the
 *   project's own test command; against the bundled toy e-commerce fixture it
 *   can only fail. The fixture for `main` is therefore THE USER'S OWN
 *   REPOSITORY, and the mechanism is a detached git worktree at HEAD.
 *
 * WHY A WORKTREE RATHER THAN A COPY. `cpSync` of a real repository is slow,
 * unbounded (node_modules, build output, caches), and silently picks up
 * uncommitted work, so two runs of the "same" task would measure two different
 * trees -- the exact confound the frozen fixtures exist to prevent. A worktree
 * at HEAD is cheap (git shares the object store), byte-identical across runs of
 * the same commit, and cannot touch the user's working tree: the benchmark's
 * edits land in a throwaway directory and are removed with it.
 *
 * NOT A GIT REPOSITORY, no measurement. That is a refusal, not a fallback. The
 * alternative -- running real-work tasks against the toy fixture -- produces a
 * number, and a number produced against the wrong tree is worse than no number.
 *
 * PERMISSIONS ARE DERIVED, NEVER ASSUMED. The bundled suites run under a fixed
 * Bash allowlist covering what those tasks need (`npm test`, `npx vitest`, ...).
 * A real-work task runs the user's own commands, which nobody can enumerate in
 * advance. `deriveAllowlist` builds the allowlist from the verification
 * commands the RECORDED SESSIONS actually ran and that actually succeeded --
 * the same commands `draft.ts` derives success checks from. A command the user
 * has never successfully run in that project is not allowlisted, so the
 * benchmark's blast radius is bounded by observed behaviour rather than by a
 * guess. The child still runs `acceptEdits`, never `bypassPermissions`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { MAIN_TARGET } from "./types.js";

/** Model the main target is benchmarked on when nothing overrides it.
 * Mirrors the bundled agents' `model: sonnet` so a main-target measurement is
 * comparable in kind to the numbers this project has published. */
const DEFAULT_MAIN_MODEL = "sonnet";

/** True for the one target that has no agent definition and no `--agent`. */
export function isMainTarget(agent: string): boolean {
	return agent === MAIN_TARGET;
}

/**
 * The synthetic definition for `main`.
 *
 * `content` is empty on purpose: there is no agent body to install. Everything
 * `installAgent` does with a definition -- writing `agents/<name>.md` into the
 * fixture copy -- is skipped for the main target, because the child inherits
 * the user's own top-level configuration instead.
 */
export function mainDefinition(model?: string | null): {
	content: string;
	model: string;
} {
	return {
		content: "",
		model: model ?? process.env.TOKEN_WARDEN_MAIN_MODEL ?? DEFAULT_MAIN_MODEL,
	};
}

/** Result of provisioning a fixture for one benchmark run. */
export interface MainFixture {
	/** Directory the golden task runs in. */
	dir: string;
	/** Release it. Idempotent; never throws. */
	release: () => void;
}

/** Run git in `cwd`, returning stdout trimmed, or null when git fails. */
function git(cwd: string, args: string[]): string | null {
	const out = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
	});
	if (out.status !== 0) return null;
	return (out.stdout ?? "").trim();
}

/**
 * The repository root for a recorded project path, or null when it is not a
 * git working tree.
 *
 * `--show-toplevel` rather than testing for a `.git` directory: the recorded
 * `project` is wherever the session ran, which is often a subdirectory, and a
 * worktree's `.git` is a FILE rather than a directory.
 */
function repoRootFor(project: string): string | null {
	if (!existsSync(project)) return null;
	const root = git(project, ["rev-parse", "--show-toplevel"]);
	return root === null || root === "" ? null : root;
}

/**
 * Provision a detached worktree at HEAD of `project`, or throw with the reason.
 *
 * The commit is resolved and pinned explicitly rather than passing `HEAD`: a
 * benchmark pass runs many tasks over minutes, and a commit landing mid-pass
 * would otherwise measure the with-side against a different tree than the
 * without-side -- a treatment effect made of someone else's commit.
 */
export function provisionMainFixture(
	project: string,
	dest: string,
	commit?: string,
): MainFixture {
	const root = repoRootFor(project);
	if (root === null) {
		throw new Error(
			`main-target benchmarks need a git repository: "${project}" is not one. ` +
				"The fixture for real-work tasks is a worktree of the project they " +
				"were recorded in; there is nothing honest to run them against here.",
		);
	}
	const head = commit ?? git(root, ["rev-parse", "HEAD"]);
	if (head === null) {
		throw new Error(
			`main-target benchmarks need a commit to pin: "${root}" has no HEAD ` +
				"(an empty repository has no tree to measure against).",
		);
	}
	const added = spawnSync(
		"git",
		["worktree", "add", "--detach", "--quiet", dest, head],
		{ cwd: root, encoding: "utf8", timeout: 120_000 },
	);
	if (added.status !== 0) {
		const why = (added.stderr ?? "").trim();
		throw new Error(`git worktree add failed${why ? `: ${why}` : ""}`);
	}
	return {
		dir: dest,
		release: () => {
			// `--force` because the benchmark deliberately dirties the tree; git
			// refuses to remove a modified worktree without it. Prune afterwards
			// so a killed run cannot leave the administrative entry behind.
			spawnSync("git", ["worktree", "remove", "--force", dest], {
				cwd: root,
				encoding: "utf8",
				timeout: 60_000,
			});
			spawnSync("git", ["worktree", "prune"], {
				cwd: root,
				encoding: "utf8",
				timeout: 60_000,
			});
			try {
				if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
			} catch {
				// Best-effort: a leftover temp directory is not worth failing a
				// measurement over, and `worktree prune` has already detached it.
			}
		},
	};
}

/** The command shapes a derived allowlist will never include, whatever the
 * transcript shows. Each is a command whose effect leaves the worktree: it
 * publishes, installs globally, or rewrites the user's real repository.
 * A benchmark is allowed to be wrong; it is not allowed to push. */
const NEVER_ALLOWED = [
	/^git\s+push/,
	/^git\s+(commit|tag|reset|clean|checkout|switch|rebase|merge|cherry-pick)/,
	/^npm\s+(publish|login|adduser|token)/,
	/^(gh|glab)\s/,
	/^(curl|wget|ssh|scp|rsync|nc)\s/,
	/^sudo\s/,
	/^rm\s/,
	/^docker\s/,
	/^kubectl\s/,
	/^terraform\s/,
	/^aws\s/,
	/^gcloud\s/,
];

/** First two words of a command, which is the granularity the permission
 * matcher works at (`Bash(npm test:*)`). A bare binary keeps one word. */
function commandPrefix(command: string): string | null {
	const words = command.trim().split(/\s+/).filter(Boolean);
	const head = words[0];
	if (head === undefined) return null;
	// A path-qualified binary (`./scripts/check.sh`) is kept whole; anything
	// with a shell metacharacter was already refused upstream by draft.ts.
	if (/[^\w./-]/.test(head)) return null;
	const second = words[1];
	if (second === undefined || /[^\w:./-]/.test(second)) return head;
	return `${head} ${second}`;
}

/**
 * Bash allowlist entries for the main target, derived from commands observed
 * succeeding in the recorded sessions.
 *
 * Deduped and sorted so the permission file is byte-stable across runs: an
 * unstable settings file would change the child's configuration between the
 * with- and without-sides and confound the measurement it exists to permit.
 */
export function deriveAllowlist(observed: readonly string[]): string[] {
	const prefixes = new Set<string>();
	for (const raw of observed) {
		const command = raw.trim();
		if (command === "") continue;
		if (NEVER_ALLOWED.some((pattern) => pattern.test(command))) continue;
		const prefix = commandPrefix(command);
		if (prefix !== null) prefixes.add(prefix);
	}
	return [...prefixes].sort().map((prefix) => `Bash(${prefix}:*)`);
}
