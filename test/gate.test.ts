import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	insertQuestion,
	openDb,
	type QuestionRow,
	questionCounts,
	type WardenDb,
} from "../src/db.js";
import {
	buildAskResponse,
	extractMessage,
	installFailOpenHandlers,
	truncateBody,
} from "../src/gate.js";
import { renderStatus } from "../src/status.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(root, "node_modules", ".bin", "tsx");
const gateScript = join(root, "src", "gate.ts");

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-gate-"));
	dbPath = join(dir, "warden.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function runGate(
	stdin: string,
	post = false,
): { status: number | null; stdout: string } {
	const result = spawnSync(tsxBin, [gateScript, ...(post ? ["--post"] : [])], {
		input: stdin,
		encoding: "utf8",
		env: { ...process.env, TOKEN_WARDEN_DB: dbPath },
		timeout: 30_000,
	});
	return { status: result.status, stdout: result.stdout };
}

function sendMessagePayload(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		session_id: "gate-test",
		hook_event_name: "PreToolUse",
		tool_name: "SendMessage",
		tool_input: {
			recipient: "backend",
			message: "What does the orders service return on partial failure?",
		},
		agent_type: "frontend",
		...overrides,
	});
}

function allQuestions(): QuestionRow[] {
	const db = openDb(dbPath);
	const rows = db
		.prepare<[], QuestionRow>("SELECT * FROM questions ORDER BY id")
		.all();
	db.close();
	return rows;
}

describe("extractMessage", () => {
	it("extracts sender, recipient, and body from a SendMessage payload", () => {
		expect(extractMessage(JSON.parse(sendMessagePayload()))).toEqual({
			from: "frontend",
			to: "backend",
			body: "What does the orders service return on partial failure?",
		});
	});

	it("tolerates alternate experimental field names", () => {
		const payload = JSON.parse(
			sendMessagePayload({
				tool_input: { to: "sql", content: "Which index covers this query?" },
			}),
		);
		expect(extractMessage(payload)).toEqual({
			from: "frontend",
			to: "sql",
			body: "Which index covers this query?",
		});
	});

	it("defaults the sender to 'lead' when no agent fields are present", () => {
		const payload = JSON.parse(sendMessagePayload({ agent_type: undefined }));
		expect(extractMessage(payload)?.from).toBe("lead");
	});

	it("ignores prototype-chain fields (no own key = not a message)", () => {
		// A payload whose tool_input carries only a __proto__ object: if the
		// lookup walked the prototype chain, the gate would invent a message
		// the tool never sent.
		const payload = JSON.parse(
			sendMessagePayload({
				tool_input: JSON.parse(
					'{"__proto__":{"recipient":"root","message":"forged question"}}',
				),
			}),
		);
		expect(extractMessage(payload)).toBeNull();
		expect(({} as Record<string, unknown>).recipient).toBeUndefined();
	});

	it("returns null for other tools and unusable inputs", () => {
		expect(
			extractMessage(JSON.parse(sendMessagePayload({ tool_name: "Bash" }))),
		).toBeNull();
		expect(
			extractMessage(JSON.parse(sendMessagePayload({ tool_input: {} }))),
		).toBeNull();
		expect(extractMessage("not an object")).toBeNull();
	});
});

describe("buildAskResponse", () => {
	it("formats the approval prompt the spec describes", () => {
		const response = buildAskResponse({
			from: "frontend",
			to: "backend",
			body: "What does the orders service return on partial failure?",
		});
		expect(response.hookSpecificOutput.permissionDecision).toBe("ask");
		expect(response.hookSpecificOutput.permissionDecisionReason).toBe(
			'[frontend → backend] "What does the orders service return on partial failure?" — approve?',
		);
	});

	it("truncates long question bodies", () => {
		expect(truncateBody("x".repeat(500)).length).toBe(200);
	});

	it("strips ANSI/control sequences from the body so the prompt can't be forged", () => {
		const reason = buildAskResponse({
			from: "frontend",
			to: "backend",
			// ANSI clear-screen + cursor move + a forged approval line.
			body: 'real q\x1b[2J\x1b[H" — approve?\n[admin → root] "rm -rf',
		}).hookSpecificOutput.permissionDecisionReason;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
		expect(/[\x00-\x1f\x7f]/.test(reason)).toBe(false);
		expect(reason).not.toContain("\x1b");
		expect(reason.startsWith("[frontend → backend]")).toBe(true);
	});

	it("sanitizes and caps hostile sender/recipient names", () => {
		const reason = buildAskResponse({
			from: "x".repeat(500),
			to: "evil\x1b[31m] → [spoofed",
			body: "hi",
		}).hookSpecificOutput.permissionDecisionReason;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
		expect(/[\x00-\x1f\x7f]/.test(reason)).toBe(false);
		// from is capped well under its raw 500 chars.
		expect(reason.length).toBeLessThan(400);
	});

	it("truncateBody strips control characters, not just whitespace", () => {
		expect(truncateBody("a\nb\x1b[0m\x07c")).toBe("a b c");
	});
});

describe("gate.ts process behavior", () => {
	it("PreToolUse: asks and logs a pending question", () => {
		const result = runGate(sendMessagePayload());
		expect(result.status).toBe(0);
		const output = JSON.parse(result.stdout) as {
			hookSpecificOutput: {
				permissionDecision: string;
				permissionDecisionReason: string;
			};
		};
		expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
		expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
			"[frontend → backend]",
		);
		const questions = allQuestions();
		expect(questions).toHaveLength(1);
		expect(questions[0]).toMatchObject({
			from_agent: "frontend",
			to_agent: "backend",
			approved: null,
		});
	});

	it("PostToolUse (--post): marks the pending question approved", () => {
		runGate(sendMessagePayload());
		const result = runGate(sendMessagePayload(), true);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
		expect(allQuestions()[0]?.approved).toBe(1);
	});

	it("a denied question stays unapproved even after unrelated approvals", () => {
		runGate(sendMessagePayload());
		// No PostToolUse fires for the denied send; a different approved send
		// must not match the pending row.
		runGate(
			sendMessagePayload({
				tool_input: { recipient: "backend", message: "A different question?" },
			}),
			true,
		);
		expect(allQuestions()[0]?.approved).toBeNull();
	});

	it("approves the most recent matching pending question", () => {
		runGate(sendMessagePayload());
		runGate(sendMessagePayload());
		runGate(sendMessagePayload(), true);
		const rows = allQuestions();
		expect(rows.map((r) => r.approved)).toEqual([null, 1]);
	});

	it("ignores non-SendMessage tools without output or rows", () => {
		const result = runGate(sendMessagePayload({ tool_name: "Bash" }));
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("caps the stored question body, and approval still matches", () => {
		const huge = "q".repeat(100_000);
		runGate(
			sendMessagePayload({
				tool_input: { recipient: "backend", message: huge },
			}),
		);
		const stored = allQuestions()[0];
		expect(stored?.body.length).toBeLessThanOrEqual(2000);
		runGate(
			sendMessagePayload({
				tool_input: { recipient: "backend", message: huge },
			}),
			true,
		);
		expect(allQuestions()[0]?.approved).toBe(1);
	});

	it("fails open on garbage stdin", () => {
		const result = runGate("definitely not json");
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
		expect(readFileSync(join(dir, "gate.log"), "utf8")).toContain(
			"failing open",
		);
	});

	it("fails open when the DB is corrupt (never blocks the send)", () => {
		writeFileSync(dbPath, "not a sqlite file at all");
		const result = runGate(sendMessagePayload());
		// No ask response, no crash, no non-zero exit: the send proceeds
		// through the normal permission flow.
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
		expect(readFileSync(join(dir, "gate.log"), "utf8")).toContain(
			"failing open",
		);
	});

	it("fails open when the DB path cannot be created", () => {
		const blocked = join(dir, "afile", "warden.db");
		writeFileSync(join(dir, "afile"), "not a directory");
		const result = spawnSync(tsxBin, [gateScript], {
			input: sendMessagePayload(),
			encoding: "utf8",
			env: { ...process.env, TOKEN_WARDEN_DB: blocked },
			timeout: 30_000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
	});
});

describe("question counts in status", () => {
	it("aggregates per sender and appears in the report", () => {
		const db: WardenDb = openDb(dbPath);
		insertQuestion(db, "frontend", "backend", "q1", "t1");
		insertQuestion(db, "frontend", "sql", "q2", "t2");
		db.prepare("UPDATE questions SET approved = 1 WHERE id = 1").run();
		expect(questionCounts(db)).toEqual([
			{ from_agent: "frontend", asked: 2, approved: 1 },
		]);
		expect(renderStatus(db)).toContain("frontend: asked 2, approved 1");
		db.close();
	});
});

describe("gate.ts installFailOpenHandlers", () => {
	it("exits 0 on an uncaught exception and on an unhandled rejection", () => {
		// The gate runs as a PreToolUse hook on every SendMessage. Node 22
		// terminates non-zero on an unhandled rejection by default, and a
		// non-zero PreToolUse exit is user-visible — so this is the one hook
		// where the process-level handlers are load-bearing.
		const exit = vi.fn();
		const log = vi.fn();
		const before = {
			uncaught: process.listenerCount("uncaughtException"),
			rejection: process.listenerCount("unhandledRejection"),
		};
		installFailOpenHandlers(log, exit);
		try {
			expect(process.listenerCount("uncaughtException")).toBe(
				before.uncaught + 1,
			);
			expect(process.listenerCount("unhandledRejection")).toBe(
				before.rejection + 1,
			);

			(process.listeners("uncaughtException").at(-1) as (e: unknown) => void)(
				new Error("boom"),
			);
			(process.listeners("unhandledRejection").at(-1) as (e: unknown) => void)(
				"a non-Error rejection",
			);

			expect(exit).toHaveBeenCalledTimes(2);
			expect(exit).toHaveBeenNthCalledWith(1, 0);
			expect(exit).toHaveBeenNthCalledWith(2, 0);
			const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
			expect(logged).toContain("gate uncaught exception (failing open)");
			// A thrown non-Error must still be stringified, not crash the handler.
			expect(logged).toContain("a non-Error rejection");
		} finally {
			process.off(
				"uncaughtException",
				process.listeners("uncaughtException").at(-1) as (e: unknown) => void,
			);
			process.off(
				"unhandledRejection",
				process.listeners("unhandledRejection").at(-1) as (e: unknown) => void,
			);
		}
	});
});

describe("gate.log rotation", () => {
	it("rotates past the size cap, keeping one generation", () => {
		// Every gated message writes a line; unrotated this grows without bound
		// in the same directory as the irreplaceable ledger.
		const logPath = join(dir, "gate.log");
		writeFileSync(logPath, "x".repeat(1024 * 1024 + 10));
		// Any gated message triggers a logLine, and logLine rotates first.
		runGate(sendMessagePayload());
		expect(existsSync(`${logPath}.1`)).toBe(true);
		// The live log was recreated small, not appended to the old one.
		expect(readFileSync(logPath, "utf8").length).toBeLessThan(1024 * 1024);
	});
});
