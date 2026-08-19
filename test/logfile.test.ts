/**
 * The shared log appender: rotation and sanitizing, both of which used to be
 * per-module decisions that four of five modules got wrong in one direction or
 * the other.
 */
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLogLine, LOG_MAX_BYTES } from "../src/logfile.js";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-log-"));
	previous = process.env.TOKEN_WARDEN_DB;
	process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
});

afterEach(() => {
	if (previous === undefined) delete process.env.TOKEN_WARDEN_DB;
	else process.env.TOKEN_WARDEN_DB = previous;
	rmSync(dir, { recursive: true, force: true });
});

const logPath = (): string => join(dir, "t.log");

describe("appendLogLine", () => {
	it("writes one timestamped line", () => {
		appendLogLine("t.log", "hello");
		const lines = readFileSync(logPath(), "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z hello$/);
	});

	it("cannot be made to forge a second entry", () => {
		// The exploit proven against distill.log before this was centralized: a
		// newline in untrusted text buys the attacker a whole fake log line,
		// timestamp and all. gate.log and notify.log were unsanitized until this
		// module existed.
		appendLogLine("t.log", "real\n2026-01-01T00:00:00.000Z forged entry");
		const lines = readFileSync(logPath(), "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("forged entry");
	});

	it("strips escape sequences that would repaint the terminal", () => {
		appendLogLine("t.log", "before \x1b[31mred\x1b[0m after");
		const written = readFileSync(logPath(), "utf8");
		expect(written).not.toContain("\x1b");
		expect(written).toContain("red");
	});

	it("rotates past the cap, keeping exactly one generation", () => {
		writeFileSync(logPath(), "x".repeat(LOG_MAX_BYTES + 1));
		appendLogLine("t.log", "after rotation");

		expect(existsSync(`${logPath()}.1`)).toBe(true);
		const current = readFileSync(logPath(), "utf8");
		expect(current).toContain("after rotation");
		// The new file is the line alone, not the old bulk plus the line.
		expect(current.length).toBeLessThan(200);
		// The previous generation is intact and still holds the old content.
		expect(readFileSync(`${logPath()}.1`, "utf8").length).toBeGreaterThan(
			LOG_MAX_BYTES,
		);
	});

	it("does not rotate a file under the cap", () => {
		writeFileSync(logPath(), "small\n");
		appendLogLine("t.log", "second");
		expect(existsSync(`${logPath()}.1`)).toBe(false);
		expect(readFileSync(logPath(), "utf8")).toContain("small");
	});

	it("keeps only one generation across repeated rotations", () => {
		// Breadcrumbs, not an audit trail: `.1` is overwritten rather than
		// promoted to `.2`, so the footprint is bounded at two files.
		for (const marker of ["first", "second"]) {
			writeFileSync(logPath(), "x".repeat(LOG_MAX_BYTES + 1));
			appendLogLine("t.log", marker);
		}
		expect(existsSync(`${logPath()}.1`)).toBe(true);
		expect(existsSync(`${logPath()}.2`)).toBe(false);
	});

	it("fails open when the log path cannot be created", () => {
		// Four of the five callers run inside hooks. A log write must never be
		// the reason a user's session breaks.
		writeFileSync(join(dir, "blocker"), "not a directory");
		process.env.TOKEN_WARDEN_DB = join(dir, "blocker", "warden.db");
		expect(() => appendLogLine("t.log", "still fine")).not.toThrow();
	});

	it("clamps a flooding line to the caller's limit", () => {
		appendLogLine("t.log", "y".repeat(5000), 100);
		const line = readFileSync(logPath(), "utf8").trimEnd();
		expect(line.length).toBeLessThan(200);
	});
});
