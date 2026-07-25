import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	insertRule,
	lastMeasurementTs,
	openDb,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import {
	autoSelectMarkerPath,
	claimAutoSelect,
	installFailOpenHandlers,
	planAutoSelect,
	sessionStart,
	spawnAutoSelect,
} from "../src/notify.js";

/** Keep the real child_process (the fail-open smoke tests spawn tsx) but make
 * `spawn` observable, so the auto-select guard can be tested without ever
 * forking a real benchmark. The fake child carries the same 'error'/unref
 * surface the real one does. */
const spawnMock = vi.hoisted(() => {
	const handlers = new Map<string, (err: Error) => void>();
	const fn = vi.fn(() => ({
		on: (event: string, handler: (err: Error) => void) => {
			handlers.set(event, handler);
		},
		unref: vi.fn(),
	}));
	return Object.assign(fn, { handlers });
});
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: spawnMock,
}));

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

describe("spawnAutoSelect", () => {
	beforeEach(() => {
		spawnMock.mockClear();
	});

	it("spawns the selector detached for a valid agent", () => {
		spawnAutoSelect("sql");
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const [cmd, argv] = spawnMock.mock.calls[0] as unknown as [
			string,
			string[],
		];
		expect(cmd).toBe("npx");
		expect(argv.slice(-2)).toEqual(["--agent", "sql"]);
	});

	it("refuses a name that could be read as a flag or a path", () => {
		for (const agent of ["../../evil", "-rf", "sql; rm -rf /", "", "a b"]) {
			spawnAutoSelect(agent);
		}
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("swallows a spawn failure instead of taking the hook down", () => {
		// A spawn failure arrives as an async 'error' event, and on an
		// EventEmitter with no listener Node THROWS it — which would make
		// SessionStart exit non-zero. The auto-selector is best-effort.
		spawnAutoSelect("sql");
		const errorHandler = spawnMock.handlers.get("error");
		expect(errorHandler).toBeTypeOf("function");
		expect(() => errorHandler?.(new Error("ENOENT"))).not.toThrow();
	});
});

describe("notify.ts fails open (subprocess)", () => {
	it("exits 0 and prints nothing when the DB file is corrupt", () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-notify-open-"));
		try {
			const dbPath = join(dir, "warden.db");
			writeFileSync(dbPath, "this is not a sqlite database");
			const root = join(dirname(fileURLToPath(import.meta.url)), "..");
			const result = spawnSync(
				join(root, "node_modules", ".bin", "tsx"),
				[join(root, "src", "notify.ts")],
				{
					encoding: "utf8",
					env: { ...process.env, TOKEN_WARDEN_DB: dbPath },
					timeout: 60_000,
				},
			);
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

describe("claimAutoSelect (double-spawn guard)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-claim-"));
		process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
	});

	afterEach(() => {
		delete process.env.TOKEN_WARDEN_DB;
		rmSync(dir, { recursive: true, force: true });
	});

	it("lets exactly one caller win — the second stands down", () => {
		// The whole point: two sessions opening at once both pass the cooldown
		// (which reads the RESIDUE of a burn, written minutes later), so without
		// this they would both spend a full benchmark burn on the same agent.
		expect(claimAutoSelect()).toBe(true);
		expect(claimAutoSelect()).toBe(false);
		expect(claimAutoSelect()).toBe(false);
		expect(existsSync(autoSelectMarkerPath())).toBe(true);
	});

	it("re-claims once the marker is older than the cooldown", () => {
		const now = Date.now();
		expect(claimAutoSelect(now)).toBe(true);
		// Age is read from the marker's mtime, not from the caller's clock, so
		// backdate the file rather than advancing `nowMs` — passing a future
		// timestamp alone leaves the marker young and the claim correctly refused.
		const marker = autoSelectMarkerPath();
		const inWindow = new Date(now - 23 * 3600_000);
		utimesSync(marker, inWindow, inWindow);
		expect(claimAutoSelect(now)).toBe(false);

		const expired = new Date(now - 25 * 3600_000);
		utimesSync(marker, expired, expired);
		expect(claimAutoSelect(now)).toBe(true);
	});

	it("expires by TIME, not by liveness — a crashed selector still waits out the window", () => {
		// Deliberately not a PID lock: if a burn died, re-burning immediately is
		// the wrong response, so time-based expiry IS the intended semantics.
		const now = Date.UTC(2026, 6, 25, 12, 0, 0);
		expect(claimAutoSelect(now)).toBe(true);
		utimesSync(autoSelectMarkerPath(), new Date(now), new Date(now));
		expect(claimAutoSelect(now + 60_000)).toBe(false);
	});

	it("writes the marker next to the ledger", () => {
		expect(dirname(autoSelectMarkerPath())).toBe(dir);
	});
});

describe("installFailOpenHandlers", () => {
	it("exits 0 on an uncaught exception and on an unhandled rejection", () => {
		// Node 22 terminates non-zero on an unhandled rejection by default, so
		// without these SessionStart could fail the user's session.
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

			const uncaught = process.listeners("uncaughtException").at(-1) as (
				e: unknown,
			) => void;
			uncaught(new Error("boom"));
			const rejected = process.listeners("unhandledRejection").at(-1) as (
				e: unknown,
			) => void;
			rejected(new Error("nope"));

			expect(exit).toHaveBeenCalledTimes(2);
			expect(exit).toHaveBeenNthCalledWith(1, 0);
			expect(exit).toHaveBeenNthCalledWith(2, 0);
			expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
				"failing open",
			);
		} finally {
			// Leave the process as we found it — these are global listeners.
			const u = process.listeners("uncaughtException").at(-1) as (
				e: unknown,
			) => void;
			process.off("uncaughtException", u);
			const r = process.listeners("unhandledRejection").at(-1) as (
				e: unknown,
			) => void;
			process.off("unhandledRejection", r);
		}
	});
});
