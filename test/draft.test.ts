/**
 * Golden-suite drafting.
 *
 * The claim under test is narrow and load-bearing: what this module emits is
 * RUNNABLE. Not "well-formed", not "a good starting point" — parseable by the
 * exact parser `bench.ts` uses, and loadable by the exact loader, with a real
 * success check rather than a `TODO`. Several tests below therefore end by
 * feeding the output back through `parseGoldenTask` / `loadGoldenTasks`
 * instead of asserting on the text, because asserting on the text is how the
 * predecessor command shipped files nothing could run.
 *
 * Every input is a committed fixture under test/fixtures/draft; nothing here
 * reads the user's ledger or their transcripts.
 *
 * Zero tokens: no model is involved.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGoldenTasks, parseGoldenTask } from "../src/bench.js";
import {
	openDb,
	type RealWorkSession,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import {
	assessRepeatability,
	checkFailsPristine,
	clusterSessions,
	deriveSuccessCheck,
	draftFileName,
	extractOpeningPrompt,
	extractVerificationCommands,
	main,
	parseDraftArgs,
	planDrafts,
	type RejectedCandidate,
	redactSensitive,
	renderDraft,
	renderPlan,
	repeatabilityRefusal,
	type SessionTranscript,
	sanitizeDraftPrompt,
} from "../src/draft.js";

const fixtureDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"draft",
);

function fixture(name: string): string {
	return readFileSync(join(fixtureDir, `${name}.jsonl`), "utf8");
}

function transcript(name: string, sessionId = name): SessionTranscript {
	return { sessionId, jsonl: fixture(name) };
}

/** A ledger row with sane defaults; only what a test cares about is passed. */
function session(
	sessionId: string,
	total: number,
	over: Partial<RealWorkSession> = {},
): RealWorkSession {
	return {
		sessionId,
		project: "/repo",
		total,
		toolCalls: 10,
		fileRereads: 0,
		durationMs: 60_000,
		completed: 1,
		...over,
	};
}

const GATE = { minSessions: 3, maxSpread: 0.25 };

describe("extractOpeningPrompt", () => {
	it("returns the first substantive user instruction", () => {
		expect(extractOpeningPrompt(fixture("paginate-1"))).toBe(
			"Add cursor pagination to the orders list endpoint and keep the existing tests green.",
		);
	});

	it("reads a content-block message as well as a bare string", () => {
		expect(extractOpeningPrompt(fixture("paginate-3"))).toContain(
			"orders listing endpoint",
		);
	});

	it("skips acknowledgements and envelope entries", () => {
		// The fixture opens with "ok" (too short) and a <system-reminder> before
		// the real instruction; neither may be mistaken for the task.
		const prompt = extractOpeningPrompt(fixture("sensitive"));
		expect(prompt).not.toBeNull();
		expect(prompt).toContain("Deploy the billing worker");
	});

	it("returns null when a transcript holds no usable prompt", () => {
		expect(extractOpeningPrompt("")).toBeNull();
		expect(extractOpeningPrompt("not json\n{}\n")).toBeNull();
	});
});

describe("extractVerificationCommands", () => {
	it("keeps a verification command whose result was not an error", () => {
		expect(extractVerificationCommands(fixture("paginate-1"))).toEqual([
			"npm test",
		]);
	});

	it("drops a verification command that FAILED", () => {
		// paginate-2 ran `npm test` twice: the first errored, the second passed.
		// Only the successful call may be derived from -- a check the session
		// itself could not pass is not a definition of done.
		expect(extractVerificationCommands(fixture("paginate-2"))).toEqual([
			"npm test",
		]);
	});

	it("drops compound commands and normalizes whitespace", () => {
		// `npm test | head -20` exits on `head`, which succeeds whatever the
		// suite did; `npm  test ` is the same invocation as `npm test`.
		expect(extractVerificationCommands(fixture("paginate-3"))).toEqual([
			"npm test",
		]);
	});

	it("ignores exploration that is not verification", () => {
		expect(extractVerificationCommands(fixture("schema-1"))).toEqual([]);
	});

	it("ignores a command whose result never arrived", () => {
		const jsonl = JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "t9",
						name: "Bash",
						input: { command: "npm test" },
					},
				],
			},
		});
		expect(extractVerificationCommands(jsonl)).toEqual([]);
	});

	it("does not match a verification word buried in another command", () => {
		const line = (command: string) =>
			`${JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{ type: "tool_use", id: "t1", name: "Bash", input: { command } },
					],
				},
			})}\n${JSON.stringify({
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "t1", is_error: false },
					],
				},
			})}`;
		expect(extractVerificationCommands(line("echo npm test"))).toEqual([]);
		expect(extractVerificationCommands(line("git status"))).toEqual([]);
	});
});

describe("deriveSuccessCheck", () => {
	it("takes the command that recurs across a majority of sessions", () => {
		expect(
			deriveSuccessCheck([["npm test"], ["npm test", "npx tsc"], ["npm test"]]),
		).toBe("npm test");
	});

	it("returns null when nothing reaches a majority", () => {
		expect(
			deriveSuccessCheck([["npm test"], ["npx tsc"], ["cargo test"]]),
		).toBeNull();
	});

	it("returns null when no session ran a verification at all", () => {
		expect(deriveSuccessCheck([[], [], []])).toBeNull();
		expect(deriveSuccessCheck([])).toBeNull();
	});

	it("counts a command once per session, however often it was run", () => {
		// One session that ran `npm test` five times is still ONE session's worth
		// of evidence, and must not out-vote a command two sessions agreed on.
		expect(
			deriveSuccessCheck([
				["npm test", "npm test", "npm test", "npm test", "npm test"],
				["npx tsc"],
				["npx tsc"],
			]),
		).toBe("npx tsc");
	});

	it("breaks ties deterministically", () => {
		const sessions = [
			["npm test", "npx tsc"],
			["npm test", "npx tsc"],
		];
		expect(deriveSuccessCheck(sessions)).toBe(deriveSuccessCheck(sessions));
	});
});

describe("clusterSessions", () => {
	it("groups near-identical prompts and separates different ones", () => {
		const clusters = clusterSessions([
			transcript("paginate-1"),
			transcript("schema-1"),
			transcript("paginate-2"),
			transcript("paginate-3"),
		]);
		expect(clusters).toHaveLength(2);
		const paginate = clusters.find((c) => c.prompt.includes("pagination"));
		expect(paginate?.sessionIds).toEqual([
			"paginate-1",
			"paginate-2",
			"paginate-3",
		]);
	});

	it("drops sessions with no usable prompt rather than clustering them", () => {
		expect(clusterSessions([{ sessionId: "x", jsonl: "" }])).toEqual([]);
	});

	it("keeps the earliest phrasing as the representative", () => {
		const clusters = clusterSessions([
			transcript("paginate-2"),
			transcript("paginate-1"),
		]);
		expect(clusters[0]?.prompt).toContain("keep existing tests green");
	});
});

describe("assessRepeatability", () => {
	it("computes spread as (max - min) / mean, bench.ts's quantity", () => {
		const rep = assessRepeatability([
			session("a", 90),
			session("b", 100),
			session("c", 110),
		]);
		expect(rep.n).toBe(3);
		expect(rep.meanTokens).toBe(100);
		expect(rep.spread).toBeCloseTo(0.2, 10);
	});

	it("reports a coefficient of variation alongside it", () => {
		const rep = assessRepeatability([
			session("a", 90),
			session("b", 100),
			session("c", 110),
		]);
		// sd = 10 on a mean of 100.
		expect(rep.cv).toBeCloseTo(0.1, 10);
	});

	it("counts incomplete sessions without excluding them from the spread", () => {
		const rep = assessRepeatability([
			session("a", 100),
			session("b", 100, { completed: 0 }),
		]);
		expect(rep.incomplete).toBe(1);
		expect(rep.n).toBe(2);
	});

	it("reports tool-call spread and median duration", () => {
		const rep = assessRepeatability([
			session("a", 100, { toolCalls: 8, durationMs: 10_000 }),
			session("b", 100, { toolCalls: 12, durationMs: 30_000 }),
			session("c", 100, { toolCalls: 10, durationMs: 20_000 }),
		]);
		expect(rep.toolCallSpread).toBeCloseTo(0.4, 10);
		expect(rep.medianSeconds).toBe(20);
	});

	it("returns null rather than NaN when a duration was never recorded", () => {
		const rep = assessRepeatability([session("a", 100, { durationMs: null })]);
		expect(rep.medianSeconds).toBeNull();
		// One sample: no variance is estimable.
		expect(rep.cv).toBeNull();
	});

	it("refuses to divide by a zero mean", () => {
		const rep = assessRepeatability([session("a", 0), session("b", 0)]);
		expect(rep.spread).toBe(Number.POSITIVE_INFINITY);
		expect(rep.cv).toBeNull();
	});
});

describe("the repeatability gate", () => {
	it("passes a steady, complete, well-sampled task", () => {
		const rep = assessRepeatability([
			session("a", 95),
			session("b", 100),
			session("c", 105),
		]);
		expect(repeatabilityRefusal(rep, GATE)).toBeNull();
	});

	it("refuses a task with too few recorded sessions", () => {
		const rep = assessRepeatability([session("a", 100), session("b", 100)]);
		expect(repeatabilityRefusal(rep, GATE)).toContain("2 recorded session");
	});

	it("refuses a task the agent did not always finish", () => {
		const rep = assessRepeatability([
			session("a", 100),
			session("b", 100),
			session("c", 100, { completed: 0 }),
		]);
		expect(repeatabilityRefusal(rep, GATE)).toContain("did not complete");
	});

	it("refuses a task whose cost swung past the 25% bar", () => {
		// FINDINGS.md records that the worst bundled golden tasks varied >25% run
		// to run and had to be split; drafting one of those on purpose is the
		// failure this gate exists to prevent.
		const rep = assessRepeatability([
			session("a", 50_000),
			session("b", 100_000),
			session("c", 150_000),
		]);
		expect(repeatabilityRefusal(rep, GATE)).toContain("100%");
	});

	it("is a plain threshold, not a tie-break: 25% exactly still passes", () => {
		const rep = assessRepeatability([
			session("a", 87.5),
			session("b", 100),
			session("c", 112.5),
		]);
		expect(rep.spread).toBeCloseTo(0.25, 10);
		expect(repeatabilityRefusal(rep, GATE)).toBeNull();
	});
});

describe("redaction", () => {
	it("removes credential shapes, home paths and addresses", () => {
		const raw =
			"deploy from /Users/ada/work using ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop0123 and mail ada@example.com";
		const out = redactSensitive(raw);
		expect(out).not.toContain("sk-ant-abcdefghijklmnop0123");
		expect(out).not.toContain("/Users/ada");
		expect(out).not.toContain("ada@example.com");
		expect(out).toContain("[REDACTED]");
		expect(out).toContain("[EMAIL]");
		expect(out).toContain("~/work");
	});

	it("redacts before clamping, so a secret cannot survive by being cut", () => {
		const secret = "ghp_0123456789abcdefghij0123456789abcdef";
		const prompt = `${"padding ".repeat(90)}${secret}`;
		expect(sanitizeDraftPrompt(prompt)).not.toContain("ghp_");
	});

	it("makes the value safe inside a double-quoted frontmatter scalar", () => {
		const out = sanitizeDraftPrompt('rename "foo" to bar C:\\Users\\ada\\x');
		expect(out).not.toContain('"');
		expect(out).not.toContain("\\");
	});

	it("strips a leading dash that bench.ts would reject as a flag", () => {
		expect(sanitizeDraftPrompt("--dangerously do the thing")).toBe(
			"dangerously do the thing",
		);
	});
});

describe("renderDraft", () => {
	const rep = assessRepeatability([
		session("a", 95),
		session("b", 100),
		session("c", 105),
	]);

	const draft = renderDraft("payments", 1, {
		prompt: "Add cursor pagination to the orders list endpoint.",
		successCheck: "npm test",
		repeatability: rep,
		failsPristine: true,
		sessionIds: ["a", "b", "c"],
	});

	it("emits a file bench.ts's own parser accepts", () => {
		const parsed = parseGoldenTask(draft.content, "payments/golden-01.md");
		expect(parsed.id).toBe("payments-01");
		expect(parsed.agent).toBe("payments");
		expect(parsed.successCheck).toBe("npm test");
		expect(parsed.weight).toBe(1);
	});

	it("names the file exactly as the loader expects", () => {
		expect(draft.fileName).toBe("golden-01.md");
		expect(draftFileName(12)).toBe("golden-12.md");
	});

	it("never emits a TODO success check", () => {
		// The predecessor command's whole output was `success_check: "TODO"`,
		// which no runner could execute. A draft with no derivable check is
		// refused upstream instead.
		expect(draft.content).not.toContain("TODO");
		expect(draft.successCheck.length).toBeGreaterThan(0);
	});

	it("says on the face of the file that it is unvalidated", () => {
		expect(draft.content).toContain("UNVALIDATED");
		expect(draft.content).toContain("Nothing here has been benchmarked");
		expect(draft.content).toContain("costs tokens");
	});

	it("records the repeatability the draft was admitted on", () => {
		expect(draft.content).toContain("3 recorded sessions");
		expect(draft.content).toContain("spread 10%");
	});

	it("warns in the file when vacuity was never probed", () => {
		const unprobed = renderDraft("payments", 2, {
			prompt: "Add cursor pagination to the orders list endpoint.",
			successCheck: "npm test",
			repeatability: rep,
			failsPristine: null,
			sessionIds: ["a"],
		});
		expect(unprobed.content).toContain("NOT PROBED");
	});

	it("carries no emoji", () => {
		expect(/\p{Extended_Pictographic}/u.test(draft.content)).toBe(false);
	});
});

describe("checkFailsPristine", () => {
	let pristine: string;

	beforeEach(() => {
		pristine = mkdtempSync(join(tmpdir(), "warden-draft-fixture-"));
		writeFileSync(
			join(pristine, "schema.sql"),
			"CREATE TABLE orders (id INT);\n",
		);
	});

	afterEach(() => {
		rmSync(pristine, { recursive: true, force: true });
	});

	it("is true when the check fails on an untouched tree", () => {
		expect(
			checkFailsPristine("grep -q 'create index' schema.sql", pristine),
		).toBe(true);
	});

	it("is false for a dead sensor that already passes", () => {
		expect(
			checkFailsPristine("grep -qi 'create table' schema.sql", pristine),
		).toBe(false);
	});

	it("is null when the probe could not run at all", () => {
		const spawn = vi.fn().mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("ENOBUFS"),
		});
		expect(checkFailsPristine("npm test", pristine, spawn)).toBeNull();
	});

	it("leaves the fixture untouched", () => {
		checkFailsPristine("rm -f schema.sql", pristine);
		expect(existsSync(join(pristine, "schema.sql"))).toBe(true);
	});
});

describe("planDrafts", () => {
	const transcripts = [
		transcript("paginate-1"),
		transcript("paginate-2"),
		transcript("paginate-3"),
		transcript("schema-1"),
		transcript("schema-2"),
		transcript("schema-3"),
		transcript("migrate-1"),
		transcript("migrate-2"),
		transcript("migrate-3"),
	];
	const ledger: RealWorkSession[] = [
		session("paginate-1", 95_000),
		session("paginate-2", 100_000),
		session("paginate-3", 105_000),
		session("schema-1", 40_000),
		session("schema-2", 41_000),
		session("schema-3", 42_000),
		// A task the user does repeatedly, and whose cost triples between runs.
		session("migrate-1", 50_000),
		session("migrate-2", 100_000),
		session("migrate-3", 150_000),
	];
	const plan = planDrafts("payments", ledger, transcripts, {
		...GATE,
		fixtureDir: null,
	});

	it("drafts the steady task with a derived check", () => {
		expect(plan.drafted).toHaveLength(1);
		expect(plan.drafted[0]?.prompt).toContain("pagination");
		expect(plan.drafted[0]?.successCheck).toBe("npm test");
	});

	/** A refusal is part of the answer, not an omission from it: "nothing was
	 * drafted" is useless where "four clusters, three too noisy" is actionable. */
	function refusalFor(fragment: string): RejectedCandidate | undefined {
		return plan.rejected.find((r) => r.prompt.includes(fragment));
	}

	it("refuses the noisy task and says why", () => {
		const noisy = refusalFor("legacy reporting");
		expect(noisy?.reason).toContain("100%");
		expect(noisy?.reason).toContain("noise");
	});

	it("refuses a task with no derivable check rather than emitting a hole", () => {
		expect(refusalFor("reporting schema evolved")?.reason).toContain(
			"no verification command",
		);
	});

	it("counts sessions whose transcript is not on disk", () => {
		const partial = planDrafts(
			"payments",
			[...ledger, session("vanished", 100_000)],
			transcripts,
			{ ...GATE, fixtureDir: null },
		);
		expect(partial.transcriptsMissing).toBe(1);
		expect(partial.sessionsSeen).toBe(10);
	});

	it("numbers surviving tasks steadiest-first", () => {
		const steady = [
			transcript("paginate-1"),
			transcript("paginate-2"),
			transcript("paginate-3"),
			transcript("migrate-1"),
			transcript("migrate-2"),
			transcript("migrate-3"),
		];
		const ranked = planDrafts(
			"payments",
			[
				// The migrate cluster is the tighter one here, so it must be golden-01
				// even though the paginate sessions were recorded first.
				session("paginate-1", 80_000),
				session("paginate-2", 100_000),
				session("paginate-3", 100_000),
				session("migrate-1", 99_000),
				session("migrate-2", 100_000),
				session("migrate-3", 101_000),
			],
			steady,
			{ ...GATE, fixtureDir: null },
		);
		expect(ranked.drafted.map((d) => d.fileName)).toEqual([
			"golden-01.md",
			"golden-02.md",
		]);
		expect(ranked.drafted[0]?.prompt).toContain("legacy reporting");
	});

	it("refuses a derived check that already passes on the fixture", () => {
		const pristine = mkdtempSync(join(tmpdir(), "warden-draft-vacuous-"));
		try {
			const vacuous = planDrafts(
				"payments",
				ledger.slice(0, 3),
				transcripts.slice(0, 3),
				{
					...GATE,
					fixtureDir: pristine,
					// Stand in for a fixture whose `npm test` passes untouched.
					spawn: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
				},
			);
			expect(vacuous.drafted).toHaveLength(0);
			expect(vacuous.rejected[0]?.reason).toContain("dead sensor");
		} finally {
			rmSync(pristine, { recursive: true, force: true });
		}
	});

	it("produces nothing, and says so, from an empty ledger", () => {
		const empty = planDrafts("payments", [], [], { ...GATE, fixtureDir: null });
		expect(empty.drafted).toEqual([]);
		expect(renderPlan(empty, "/out", false)).toContain(
			"NO: nothing could be drafted",
		);
	});
});

describe("parseDraftArgs", () => {
	let agentsDir: string;
	let benchmarksDir: string;
	let fixturesDir: string;

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "warden-draft-agents-"));
		benchmarksDir = mkdtempSync(join(tmpdir(), "warden-draft-bench-"));
		fixturesDir = mkdtempSync(join(tmpdir(), "warden-draft-fixtures-"));
		writeFileSync(join(agentsDir, "payments.md"), "memory: user\n");
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR = benchmarksDir;
		process.env.TOKEN_WARDEN_FIXTURES_DIR = fixturesDir;
	});

	afterEach(() => {
		for (const dir of [agentsDir, benchmarksDir, fixturesDir]) {
			rmSync(dir, { recursive: true, force: true });
		}
		delete process.env.TOKEN_WARDEN_AGENTS_DIR;
		delete process.env.TOKEN_WARDEN_BENCHMARKS_DIR;
		delete process.env.TOKEN_WARDEN_FIXTURES_DIR;
	});

	it("defaults out/ to the drafts subdirectory of the agent's suite", () => {
		const args = parseDraftArgs(["--agent", "payments"]);
		expect(args.out).toBe(join(benchmarksDir, "payments", "drafts"));
		expect(args.write).toBe(false);
		expect(args.minSessions).toBe(3);
		expect(args.maxSpread).toBe(0.25);
	});

	it("picks up the agent's fixture directory when one exists", () => {
		expect(parseDraftArgs(["--agent", "payments"]).fixtureDir).toBeNull();
		mkdirSync(join(fixturesDir, "payments"), { recursive: true });
		expect(parseDraftArgs(["--agent", "payments"]).fixtureDir).toBe(
			join(fixturesDir, "payments"),
		);
	});

	it("honours --no-fixture over a fixture that exists", () => {
		mkdirSync(join(fixturesDir, "payments"), { recursive: true });
		expect(
			parseDraftArgs(["--agent", "payments", "--no-fixture"]).fixtureDir,
		).toBeNull();
	});

	it("rejects an unknown agent, an unknown flag, and bad thresholds", () => {
		expect(() => parseDraftArgs(["--agent", "nope"])).toThrow(/must be one of/);
		expect(() => parseDraftArgs(["--agent", "payments", "--wat"])).toThrow(
			/unknown flag/,
		);
		expect(() =>
			parseDraftArgs(["--agent", "payments", "--min-sessions", "1"]),
		).toThrow(/>= 2/);
		expect(() =>
			parseDraftArgs(["--agent", "payments", "--max-spread", "0"]),
		).toThrow(/positive number/);
		expect(() =>
			parseDraftArgs([
				"--agent",
				"payments",
				"--fixture",
				join(fixturesDir, "gone"),
			]),
		).toThrow(/not found/);
	});

	it("treats a blank numeric flag as missing rather than as zero", () => {
		// `--min-sessions "$UNSET"` used to parse as 0 elsewhere in this repo.
		expect(() =>
			parseDraftArgs(["--agent", "payments", "--min-sessions", ""]),
		).toThrow(/>= 2/);
	});
});

describe("main (end to end)", () => {
	let root: string;
	let db: WardenDb;
	let agentsDir: string;
	let benchmarksDir: string;
	let projectsDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "warden-draft-e2e-"));
		agentsDir = join(root, "agents");
		benchmarksDir = join(root, "benchmarks");
		projectsDir = join(root, "projects", "-repo");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(benchmarksDir, { recursive: true });
		mkdirSync(projectsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "payments.md"),
			"memory: user\nmodel: sonnet\n",
		);
		for (const name of ["paginate-1", "paginate-2", "paginate-3"]) {
			writeFileSync(join(projectsDir, `${name}.jsonl`), fixture(name));
		}
		process.env.TOKEN_WARDEN_DB = join(root, "warden.db");
		process.env.TOKEN_WARDEN_AGENTS_DIR = agentsDir;
		process.env.TOKEN_WARDEN_BENCHMARKS_DIR = benchmarksDir;
		process.env.TOKEN_WARDEN_FIXTURES_DIR = join(root, "fixtures");
		db = openDb(process.env.TOKEN_WARDEN_DB);
		let i = 0;
		for (const [name, total] of [
			["paginate-1", 95_000],
			["paginate-2", 100_000],
			["paginate-3", 105_000],
		] as const) {
			upsertRun(db, {
				agent: "payments",
				sessionId: name,
				taskHash: null,
				inputTokens: total,
				outputTokens: 0,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 10,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 1,
				ts: `2026-08-0${++i}T00:00:00.000Z`,
				config: "real",
				project: "/repo",
			});
		}
		db.close();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		delete process.env.TOKEN_WARDEN_AGENTS_DIR;
		delete process.env.TOKEN_WARDEN_BENCHMARKS_DIR;
		delete process.env.TOKEN_WARDEN_FIXTURES_DIR;
		delete process.env.TOKEN_WARDEN_DB;
		vi.restoreAllMocks();
	});

	function run(argv: string[]): string {
		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "log")
			.mockImplementation((...args: unknown[]) => {
				lines.push(args.map(String).join(" "));
			});
		try {
			expect(main(argv)).toBe(0);
		} finally {
			spy.mockRestore();
		}
		return lines.join("\n");
	}

	/**
	 * `--auto` is the hands-off path the SessionStart hook runs: probe every
	 * derived check against a real worktree, promote what survives into the
	 * suite, and hold back the rest as drafts. It is the step that lets an
	 * installation measure real work without anyone typing anything, so what it
	 * REFUSES to promote matters more than what it promotes.
	 */
	describe("--auto", () => {
		/** Turn the recorded project into a real repository whose test command
		 * fails on a clean tree, so the derived check is not a dead sensor. */
		function makeProjectRepo(failing: boolean): string {
			const repo = mkdtempSync(join(tmpdir(), "warden-auto-repo-"));
			const git = (args: string[]): void => {
				execFileSync("git", args, { cwd: repo, stdio: "pipe" });
			};
			git(["init", "--quiet"]);
			git(["config", "user.email", "t@example.com"]);
			git(["config", "user.name", "t"]);
			writeFileSync(
				join(repo, "package.json"),
				JSON.stringify({
					name: "p",
					scripts: { test: failing ? "exit 1" : "exit 0" },
				}),
			);
			git(["add", "."]);
			git(["commit", "--quiet", "-m", "init"]);
			return repo;
		}

		/** Point the recorded sessions at a real repository. */
		function repointLedger(project: string): void {
			const db2 = openDb(process.env.TOKEN_WARDEN_DB as string);
			db2.prepare("UPDATE runs SET project = ?").run(project);
			db2.close();
		}

		it("promotes a probed, project-bound task into the suite", () => {
			const repo = makeProjectRepo(true);
			try {
				repointLedger(repo);
				run([
					"--agent",
					"payments",
					"--projects",
					join(root, "projects"),
					"--auto",
				]);
				const promoted = join(benchmarksDir, "payments", "golden-01.md");
				expect(existsSync(promoted)).toBe(true);
				const content = readFileSync(promoted, "utf8");
				// The project binding is what makes the task runnable later.
				expect(content).toContain(`project: "${repo}"`);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		});

		it("holds back a task whose check passes on the clean tree", () => {
			// A check that already passes is a dead sensor: it would pass with and
			// without a rule, turning every verdict it touches into noise.
			const repo = makeProjectRepo(false);
			try {
				repointLedger(repo);
				run([
					"--agent",
					"payments",
					"--projects",
					join(root, "projects"),
					"--auto",
				]);
				expect(
					existsSync(join(benchmarksDir, "payments", "golden-01.md")),
				).toBe(false);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		});

		it("promotes nothing when the project is not a git repository", () => {
			// Nothing can be probed, so nothing can be vouched for -- but the
			// drafts are still written for a human to read.
			const plain = mkdtempSync(join(tmpdir(), "warden-auto-plain-"));
			try {
				repointLedger(plain);
				run([
					"--agent",
					"payments",
					"--projects",
					join(root, "projects"),
					"--auto",
				]);
				expect(
					existsSync(join(benchmarksDir, "payments", "golden-01.md")),
				).toBe(false);
				expect(
					existsSync(join(benchmarksDir, "payments", "drafts", "golden-01.md")),
				).toBe(true);
			} finally {
				rmSync(plain, { recursive: true, force: true });
			}
		});

		it("leaves no worktree behind in the probed repository", () => {
			const repo = makeProjectRepo(true);
			try {
				repointLedger(repo);
				run([
					"--agent",
					"payments",
					"--projects",
					join(root, "projects"),
					"--auto",
				]);
				const listed = execFileSync("git", ["worktree", "list"], {
					cwd: repo,
					encoding: "utf8",
				});
				// One line: the repository itself. A leaked probe worktree would
				// litter the user's own repository on every drafting attempt.
				expect(listed.trim().split("\n")).toHaveLength(1);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		});
	});

	it("writes nothing without --write", () => {
		const out = run([
			"--agent",
			"payments",
			"--projects",
			join(root, "projects"),
		]);
		expect(out).toContain("DRY RUN");
		expect(existsSync(join(benchmarksDir, "payments", "drafts"))).toBe(false);
	});

	it("emits a suite that loadGoldenTasks can load once promoted", () => {
		run([
			"--agent",
			"payments",
			"--projects",
			join(root, "projects"),
			"--write",
		]);
		const draftsDir = join(benchmarksDir, "payments", "drafts");
		const files = readdirSync(draftsDir);
		expect(files).toEqual(["golden-01.md"]);

		// A draft is invisible to the runner where it lands: bench.ts reads
		// golden-NN.md from the suite directory and never recurses.
		expect(() => loadGoldenTasks("payments")).toThrow(/no golden tasks/);

		// Promotion is a move, and nothing else.
		renameSync(
			join(draftsDir, "golden-01.md"),
			join(benchmarksDir, "payments", "golden-01.md"),
		);
		const tasks = loadGoldenTasks("payments");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.id).toBe("payments-01");
		expect(tasks[0]?.successCheck).toBe("npm test");
		expect(tasks[0]?.prompt).toContain("pagination");
	});

	it("reports as JSON when asked", () => {
		const out = run([
			"--agent",
			"payments",
			"--projects",
			join(root, "projects"),
			"--json",
		]);
		const parsed = JSON.parse(out) as {
			drafted: { id: string; repeatability: { n: number } }[];
			written: boolean;
		};
		expect(parsed.written).toBe(false);
		expect(parsed.drafted[0]?.id).toBe("payments-01");
		expect(parsed.drafted[0]?.repeatability.n).toBe(3);
	});

	it("says so, and writes nothing, when the pool is too thin", () => {
		const out = run([
			"--agent",
			"payments",
			"--projects",
			join(root, "projects"),
			"--min-sessions",
			"5",
			"--write",
		]);
		expect(out).toContain("NO: nothing could be drafted");
		expect(out).toContain("3 recorded session");
		expect(existsSync(join(benchmarksDir, "payments", "drafts"))).toBe(false);
	});
});

/**
 * The malformed-transcript branches. A transcript is a file another program
 * writes, so every one of these shapes is reachable in production and none of
 * them may throw: a draft run that dies on one bad line has refused a whole
 * agent's history over a single record.
 */
describe("parsing hostile transcript lines", () => {
	it("skips lines that are not JSON at all", () => {
		expect(extractOpeningPrompt("not json\n{oops\n")).toBeNull();
		expect(extractVerificationCommands("not json\n{oops\n")).toEqual([]);
	});

	it("skips JSON that is not an object", () => {
		const lines = ["null", "42", '"a string"', "[1, 2]"].join("\n");
		expect(extractOpeningPrompt(lines)).toBeNull();
		expect(extractVerificationCommands(lines)).toEqual([]);
	});

	it("skips user entries whose message is missing or not an object", () => {
		const lines = [
			JSON.stringify({ type: "user" }),
			JSON.stringify({ type: "user", message: null }),
			JSON.stringify({ type: "user", message: "a string" }),
		].join("\n");
		expect(extractOpeningPrompt(lines)).toBeNull();
	});

	it("skips user entries written by something other than the user", () => {
		const line = JSON.stringify({
			type: "user",
			message: {
				role: "assistant",
				content: "a prompt long enough to clear the minimum length gate",
			},
		});
		expect(extractOpeningPrompt(line)).toBeNull();
	});

	it("reads a bare-string content as well as a block array", () => {
		const bare = JSON.stringify({
			type: "user",
			message: {
				role: "user",
				content: "add pagination to the reporting endpoint, please",
			},
		});
		expect(extractOpeningPrompt(bare)).toContain("pagination");
	});

	it("ignores content blocks that are not text blocks", () => {
		const line = JSON.stringify({
			type: "user",
			message: {
				role: "user",
				content: [
					null,
					"a bare string inside the array",
					{ type: "image", source: "..." },
					{ type: "text", text: 42 },
					{ type: "text", text: "add pagination to the reporting endpoint" },
				],
			},
		});
		expect(extractOpeningPrompt(line)).toBe(
			"add pagination to the reporting endpoint",
		);
	});

	it("ignores tool blocks with no usable id, input or command", () => {
		const lines = [
			JSON.stringify({
				type: "assistant",
				message: { content: "a string, not an array" },
			}),
			JSON.stringify({ type: "assistant", message: { content: [null, 7] } }),
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{ type: "tool_use", name: "Bash", id: 99, input: { command: "x" } },
						{ type: "tool_use", name: "Bash", id: "a", input: null },
						{ type: "tool_use", name: "Bash", id: "b", input: { command: 7 } },
						{ type: "tool_use", name: "Read", id: "c", input: {} },
					],
				},
			}),
			JSON.stringify({
				type: "user",
				message: { content: [{ type: "tool_result", tool_use_id: 5 }] },
			}),
		].join("\n");
		expect(extractVerificationCommands(lines)).toEqual([]);
	});

	it("drops a command whose tool call failed, and one that never returned", () => {
		const lines = [
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							name: "Bash",
							id: "failed",
							input: { command: "npm test" },
						},
						{
							type: "tool_use",
							name: "Bash",
							id: "silent",
							input: { command: "npm run lint" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "failed", is_error: true },
					],
				},
			}),
		].join("\n");
		expect(extractVerificationCommands(lines)).toEqual([]);
	});
});

describe("redactSensitive", () => {
	it("rewrites both this machine's home and the conventional layouts", () => {
		const text = `${homedir()}/work/app and /Users/someone/other and /home/ci/build`;
		const out = redactSensitive(text);
		expect(out).not.toContain(homedir());
		expect(out).not.toContain("/Users/someone");
		expect(out).not.toContain("/home/ci");
	});

	it("leaves text with nothing sensitive in it alone", () => {
		expect(redactSensitive("add pagination to /api/reports")).toBe(
			"add pagination to /api/reports",
		);
	});
});
