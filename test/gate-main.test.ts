import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { openDb, type QuestionRow } from "../src/db.js";
import { main } from "../src/gate.js";

/**
 * Drive gate.main() end to end by feeding a hook payload through process.stdin.
 *
 * main() reads the payload from a `for await … of process.stdin` loop and
 * checks `process.argv.includes("--post")`, so the only boundaries to fake are
 * stdin (replaced with a Readable.from of the JSON bytes) and argv (to exercise
 * the PostToolUse branch). The DB is a real on-disk better-sqlite3 file under a
 * temp dir, pointed at via TOKEN_WARDEN_DB, so we assert the actual rows the
 * gate writes. stdin, argv, env and the console.log spy are all restored after
 * each test.
 */

const origStdin = process.stdin;
const origArgv = process.argv;

let dir: string;
let logSpy: MockInstance;

function setStdin(payload: unknown): void {
	const fake = Readable.from([Buffer.from(JSON.stringify(payload))]);
	Object.defineProperty(process, "stdin", {
		value: fake,
		configurable: true,
	});
}

function setRawStdin(raw: string): void {
	const fake = Readable.from([Buffer.from(raw)]);
	Object.defineProperty(process, "stdin", {
		value: fake,
		configurable: true,
	});
}

function allQuestions(): QuestionRow[] {
	const db = openDb();
	try {
		return db
			.prepare<unknown[], QuestionRow>("SELECT * FROM questions ORDER BY id")
			.all();
	} finally {
		db.close();
	}
}

function preToolUsePayload(
	input: Record<string, unknown>,
	agentType = "frontend",
) {
	return {
		hook_event_name: "PreToolUse",
		tool_name: "SendMessage",
		tool_input: input,
		agent_type: agentType,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-gate-main-"));
	process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	// Start from the default (non --post) argv every test.
	process.argv = [...origArgv].filter((a) => a !== "--post");
});

afterEach(() => {
	logSpy.mockRestore();
	Object.defineProperty(process, "stdin", {
		value: origStdin,
		configurable: true,
	});
	process.argv = origArgv;
	process.env.TOKEN_WARDEN_DB = undefined;
	delete process.env.TOKEN_WARDEN_DB;
	rmSync(dir, { recursive: true, force: true });
});

describe("gate main()", () => {
	it("PreToolUse SendMessage inserts a pending question and prints an ask response", async () => {
		setStdin(
			preToolUsePayload({
				recipient: "backend",
				message: "how do I migrate the schema?",
			}),
		);

		await main();

		const rows = allQuestions();
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row).toBeDefined();
		expect(row?.from_agent).toBe("frontend");
		expect(row?.to_agent).toBe("backend");
		expect(row?.body).toContain("migrate the schema");
		// Pending: not yet approved.
		expect(row?.approved).toBeNull();

		// Exactly one ask response printed.
		expect(logSpy).toHaveBeenCalledTimes(1);
		const printed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
		expect(printed.hookSpecificOutput.permissionDecision).toBe("ask");
		expect(printed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(printed.hookSpecificOutput.permissionDecisionReason).toContain(
			"[frontend → backend]",
		);
	});

	it("--post path marks the matching pending question approved", async () => {
		// First: ask (inserts the pending row).
		setStdin(preToolUsePayload({ recipient: "backend", message: "ping" }));
		await main();
		expect(allQuestions()[0]?.approved).toBeNull();
		// Drop the ask-phase log so we can assert --post prints nothing.
		logSpy.mockClear();

		// Then: post (same route + body) marks it approved.
		process.argv = [...origArgv, "--post"];
		setStdin(preToolUsePayload({ recipient: "backend", message: "ping" }));
		await main();

		const rows = allQuestions();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.approved).toBe(1);
		// --post prints nothing.
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("non-SendMessage payload is a fail-open no-op (no row, no output)", async () => {
		setStdin({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			agent_type: "frontend",
		});

		await expect(main()).resolves.toBeUndefined();

		expect(allQuestions()).toHaveLength(0);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("malformed JSON payload fails open (returns; the entry shim swallows the throw)", async () => {
		setRawStdin("{ this is not json");

		// main() itself throws on JSON.parse; the CLI shim catches it and exits 0.
		// We assert it throws *before* touching the DB so nothing is written.
		await expect(main()).rejects.toBeInstanceOf(Error);
		expect(allQuestions()).toHaveLength(0);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("SendMessage missing a body is a no-op (not gateable)", async () => {
		setStdin(preToolUsePayload({ recipient: "backend" }));

		await expect(main()).resolves.toBeUndefined();
		expect(allQuestions()).toHaveLength(0);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("strips ANSI/control bytes from the printed approval prompt", async () => {
		setStdin(
			preToolUsePayload(
				{
					// ANSI CSI red + a BEL control byte in both recipient and body.
					recipient: "back\x1b[31mend\x07",
					message: "drop \x1b[2J the\x07 tables",
				},
				"front\x1bend",
			),
		);

		await main();

		expect(logSpy).toHaveBeenCalledTimes(1);
		const printed = logSpy.mock.calls[0]?.[0] as string;
		const reason = JSON.parse(printed).hookSpecificOutput
			.permissionDecisionReason as string;
		// No raw ESC or BEL (or any C0 control besides plain whitespace) survives.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting controls are absent.
		expect(reason).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
		expect(reason).not.toContain("\x1b");
		expect(reason).not.toContain("\x07");
		// The visible text still reads coherently.
		expect(reason).toContain("approve?");
	});
});
