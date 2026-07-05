import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	insertRule,
	lastMeasurementTs,
	openDb,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import { planAutoSelect, sessionStart } from "../src/notify.js";

const NOW = Date.parse("2026-06-29T12:00:00.000Z");
const counts = (pending: Record<string, number>) =>
	Object.entries(pending).map(([agent, n]) => ({ agent, pending: n }));

describe("planAutoSelect", () => {
	it("stays off unless explicitly enabled", () => {
		const plan = planAutoSelect(false, counts({ sql: 3 }), null, NOW);
		expect(plan.agent).toBeNull();
		expect(plan.reason).toContain("TOKEN_WARDEN_AUTO_SELECT");
	});

	it("picks the domain agent with the most pending candidates", () => {
		const plan = planAutoSelect(
			true,
			counts({ sql: 1, backend: 4, main: 99 }), // 'main' is not measurable
			null,
			NOW,
		);
		expect(plan.agent).toBe("backend");
	});

	it("does nothing without pending candidates", () => {
		expect(planAutoSelect(true, [], null, NOW).agent).toBeNull();
		expect(
			planAutoSelect(true, counts({ main: 5 }), null, NOW).agent,
		).toBeNull();
	});

	it("respects the 24h cooldown, ignoring unparseable timestamps", () => {
		const twoHoursAgo = new Date(NOW - 2 * 3600_000).toISOString();
		const twoDaysAgo = new Date(NOW - 48 * 3600_000).toISOString();
		expect(
			planAutoSelect(true, counts({ sql: 2 }), twoHoursAgo, NOW).agent,
		).toBeNull();
		expect(
			planAutoSelect(true, counts({ sql: 2 }), twoDaysAgo, NOW).agent,
		).toBe("sql");
		expect(
			planAutoSelect(true, counts({ sql: 2 }), "not-a-date", NOW).agent,
		).toBe("sql");
	});
});

describe("sessionStart (temp db)", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-notify-"));
		db = openDb(join(dir, "warden.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function seedCandidate(agent = "sql"): void {
		insertRule(db, {
			agent,
			body: "A candidate waiting to be measured.",
			contextCost: 10,
			sourceRun: null,
			createdAt: "t",
		});
	}

	function seedMeasurement(ts: string): void {
		upsertRun(db, {
			agent: "sql",
			sessionId: `measure-${ts}`,
			taskHash: "sql-01",
			inputTokens: 100,
			outputTokens: 0,
			cacheCreation: 0,
			cacheRead: 0,
			toolCalls: 1,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 0,
			ts,
			config: "candidate",
		});
	}

	it("stays silent on an empty db and never spawns", () => {
		const spawner = vi.fn();
		expect(sessionStart(db, {}, NOW, spawner)).toBeNull();
		expect(spawner).not.toHaveBeenCalled();
	});

	it("nudges without spawning when auto-select is off", () => {
		seedCandidate();
		const spawner = vi.fn();
		const out = sessionStart(db, {}, NOW, spawner);
		expect(out).toContain("pending measurement");
		expect(out).not.toContain("auto-select");
		expect(spawner).not.toHaveBeenCalled();
	});

	it("spawns the selector for the busiest agent when opted in and cold", () => {
		seedCandidate("sql");
		seedCandidate("sql");
		seedCandidate("backend");
		const spawner = vi.fn();
		const out = sessionStart(
			db,
			{ TOKEN_WARDEN_AUTO_SELECT: "1" },
			NOW,
			spawner,
		);
		expect(spawner).toHaveBeenCalledExactlyOnceWith("sql");
		expect(out).toContain("auto-select started in the background for sql");
		// The hook payload is well-formed SessionStart JSON.
		const parsed = JSON.parse(out ?? "") as {
			hookSpecificOutput: { hookEventName: string; additionalContext: string };
		};
		expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
	});

	it("suppresses the spawn inside the 24h cooldown", () => {
		seedCandidate();
		seedMeasurement(new Date(NOW - 3600_000).toISOString());
		const spawner = vi.fn();
		const out = sessionStart(
			db,
			{ TOKEN_WARDEN_AUTO_SELECT: "1" },
			NOW,
			spawner,
		);
		expect(spawner).not.toHaveBeenCalled();
		expect(out).toContain("pending measurement"); // the nudge still fires
		expect(out).not.toContain("auto-select started");
	});

	it("lastMeasurementTs reads benchmark runs (active/candidate/audit), not real work", () => {
		expect(lastMeasurementTs(db)).toBeNull();
		upsertRun(db, {
			agent: "sql",
			sessionId: "real-1",
			taskHash: null,
			inputTokens: 1,
			outputTokens: 0,
			cacheCreation: 0,
			cacheRead: 0,
			toolCalls: 1,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 0,
			ts: "2026-06-29T00:00:00.000Z",
			config: "real",
		});
		expect(lastMeasurementTs(db)).toBeNull();
		seedMeasurement("2026-06-28T00:00:00.000Z");
		expect(lastMeasurementTs(db)).toBe("2026-06-28T00:00:00.000Z");
	});

	it("counts the baseline (config=active) toward the cooldown so a crashed selector cannot re-spawn in a loop", () => {
		// The selector spends the expensive shared baseline FIRST. If it dies
		// after that pass, the cooldown must still have started — otherwise every
		// session start would re-spawn the selector and re-burn the baseline.
		upsertRun(db, {
			agent: "sql",
			sessionId: "baseline-1",
			taskHash: "sql-01",
			inputTokens: 50_000,
			outputTokens: 0,
			cacheCreation: 0,
			cacheRead: 0,
			toolCalls: 1,
			fileRereads: 0,
			completed: true,
			rulesetVersion: 0,
			ts: new Date(NOW - 3600_000).toISOString(),
			config: "active",
		});
		expect(lastMeasurementTs(db)).toBe(new Date(NOW - 3600_000).toISOString());

		seedCandidate();
		const spawner = vi.fn();
		sessionStart(db, { TOKEN_WARDEN_AUTO_SELECT: "1" }, NOW, spawner);
		expect(spawner).not.toHaveBeenCalled();
	});
});
