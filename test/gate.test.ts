import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	insertQuestion,
	openDb,
	type QuestionRow,
	questionCounts,
	type WardenDb,
} from "../src/db.js";
import { buildAskResponse, extractMessage, truncateBody } from "../src/gate.js";
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

	it("a denied question stays unapproved", () => {
		runGate(sendMessagePayload());
		// No PostToolUse fires when the user denies the send.
		expect(allQuestions()[0]?.approved).toBeNull();
	});

	it("ignores non-SendMessage tools without output or rows", () => {
		const result = runGate(sendMessagePayload({ tool_name: "Bash" }));
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("fails open on garbage stdin", () => {
		const result = runGate("definitely not json");
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("");
		expect(readFileSync(join(dir, "gate.log"), "utf8")).toContain(
			"failing open",
		);
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
