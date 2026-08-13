import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, upsertRun, type WardenDb } from "../src/db.js";
import {
	assessLiveness,
	type DogfoodData,
	formatDogfood,
	gatherDogfood,
	main,
	nextAction,
	parseDogfoodArgs,
	renderDogfood,
} from "../src/dogfood.js";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const DAY = 86_400_000;

let dir: string;
let db: WardenDb;
let markerPath: string;

function iso(msAgo: number): string {
	return new Date(NOW - msAgo).toISOString();
}

/** One real-work session (task_hash NULL) for an agent. */
function session(
	agent: string,
	opts: {
		id: string;
		tokens?: number;
		msAgo?: number;
		completed?: boolean;
	},
): void {
	const tokens = opts.tokens ?? 1000;
	upsertRun(db, {
		agent,
		sessionId: opts.id,
		taskHash: null,
		inputTokens: tokens,
		outputTokens: 0,
		cacheCreation: 0,
		cacheRead: 0,
		toolCalls: 1,
		fileRereads: 0,
		completed: opts.completed ?? true,
		rulesetVersion: 0,
		ts: iso(opts.msAgo ?? DAY),
		config: "real",
		project: "/proj",
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-dogfood-"));
	process.env.TOKEN_WARDEN_DB = join(dir, "warden.db");
	// Point the registry at an empty dir so the bundled four are the whole
	// known set, whatever the developer has in ~/.token-warden/agents.
	process.env.TOKEN_WARDEN_AGENTS_DIR = join(dir, "agents");
	delete process.env.TOKEN_WARDEN_NO_COLLECT;
	delete process.env.TOKEN_WARDEN_NO_DISTILL;
	markerPath = join(dir, ".warden-deps-ok");
	writeFileSync(markerPath, "");
	db = openDb();
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
	delete process.env.TOKEN_WARDEN_AGENTS_DIR;
	vi.restoreAllMocks();
});

const opts = () => ({ nowMs: NOW, depsMarkerPath: markerPath });

describe("assessLiveness", () => {
	it("is never without a timestamp, and on an unparseable one", () => {
		expect(assessLiveness(null, NOW)).toBe("never");
		expect(assessLiveness("not-a-date", NOW)).toBe("never");
	});

	it("is live inside 24h, idle inside the staleness window, stopped past it", () => {
		expect(assessLiveness(new Date(NOW - 3600_000).toISOString(), NOW)).toBe(
			"live",
		);
		expect(assessLiveness(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe(
			"idle",
		);
		expect(assessLiveness(new Date(NOW - 30 * DAY).toISOString(), NOW)).toBe(
			"stopped",
		);
	});

	it("honours a widened staleness window", () => {
		const ts = new Date(NOW - 30 * DAY).toISOString();
		expect(assessLiveness(ts, NOW, 60)).toBe("idle");
	});
});

describe("gatherDogfood", () => {
	it("reports zero rows for every known agent when nothing was collected", () => {
		const data = gatherDogfood(db, opts());
		expect(data.liveness).toBe("never");
		expect(data.lastRealWorkTs).toBeNull();
		expect(data.ageDays).toBeNull();
		expect(data.agents.map((a) => a.agent).sort()).toEqual([
			"backend",
			"frontend",
			"sql",
			"testing",
		]);
		expect(data.agents.every((a) => a.known)).toBe(true);
		expect(data.agents.every((a) => a.runsNeeded === 5)).toBe(true);
		expect(data.distillableSessions).toBe(0);
		expect(data.inertSessions).toBe(0);
	});

	it("marks agents outside knownAgents() as INERT and counts their sessions separately", () => {
		session("main", { id: "m1", msAgo: 2 * DAY });
		session("main", { id: "m2", msAgo: DAY });
		session("Explore", { id: "e1", msAgo: DAY });
		session("sql", { id: "s1", msAgo: DAY });

		const data = gatherDogfood(db, opts());
		const main_ = data.agents.find((a) => a.agent === "main");
		expect(main_?.known).toBe(false);
		expect(main_?.sessions).toBe(2);
		expect(data.agents.find((a) => a.agent === "Explore")?.known).toBe(false);
		expect(data.agents.find((a) => a.agent === "sql")?.known).toBe(true);
		expect(data.inertSessions).toBe(3);
		expect(data.distillableSessions).toBe(1);
	});

	it("quotes no threshold for an inert agent however many sessions it has", () => {
		for (let i = 0; i < 8; i++) {
			session("main", { id: `m${i}`, tokens: 1000 + i, msAgo: DAY });
		}
		const main_ = gatherDogfood(db, opts()).agents.find(
			(a) => a.agent === "main",
		);
		expect(main_?.completed).toBe(8);
		expect(main_?.threshold).toBeNull();
		expect(main_?.runsNeeded).toBe(0);
		expect(main_?.verifiedTrigger).toBe(false);
	});

	it("counts only completed sessions toward readiness", () => {
		for (let i = 0; i < 4; i++) {
			session("sql", { id: `s${i}`, msAgo: DAY });
		}
		session("sql", { id: "aborted", msAgo: DAY, completed: false });
		const sql = gatherDogfood(db, opts()).agents.find((a) => a.agent === "sql");
		expect(sql?.sessions).toBe(5);
		expect(sql?.completed).toBe(4);
		expect(sql?.runsNeeded).toBe(1);
		expect(sql?.threshold).toBeNull();
	});

	it("arms a known agent at the distiller's own p75, verified against the live trigger", () => {
		const totals = [100, 200, 300, 400, 500];
		totals.forEach((tokens, i) => {
			session("sql", { id: `s${i}`, tokens, msAgo: DAY });
		});
		const sql = gatherDogfood(db, opts()).agents.find((a) => a.agent === "sql");
		expect(sql?.runsNeeded).toBe(0);
		// Nearest-rank p75 of five values is the fourth.
		expect(sql?.threshold).toBe(400);
		expect(sql?.verifiedTrigger).toBe(true);
	});

	it("reads the disable switches and the deps marker from the environment", () => {
		const off = gatherDogfood(db, {
			...opts(),
			env: { TOKEN_WARDEN_NO_COLLECT: "1", TOKEN_WARDEN_NO_DISTILL: "1" },
			depsMarkerPath: join(dir, "absent"),
		});
		expect(off.collectDisabled).toBe(true);
		expect(off.distillDisabled).toBe(true);
		expect(off.depsInstalled).toBe(false);
	});

	it("uses the newest real-work row across agents for liveness", () => {
		session("main", { id: "old", msAgo: 40 * DAY });
		session("sql", { id: "new", msAgo: 2 * 3600_000 });
		const data = gatherDogfood(db, opts());
		expect(data.liveness).toBe("live");
		expect((data.ageDays ?? 0) < 1).toBe(true);
	});
});

describe("nextAction", () => {
	function dataWith(overrides: Partial<DogfoodData>): DogfoodData {
		return { ...gatherDogfood(db, opts()), ...overrides };
	}

	it("puts the disable switches first", () => {
		expect(nextAction(dataWith({ collectDisabled: true })).id).toBe(
			"collection-disabled",
		);
		expect(nextAction(dataWith({ distillDisabled: true })).id).toBe(
			"distillation-disabled",
		);
	});

	it("reports never-collected on an empty ledger", () => {
		expect(nextAction(gatherDogfood(db, opts())).id).toBe("never-collected");
	});

	it("reports collection-stopped, and names the missing deps marker", () => {
		session("sql", { id: "s1", msAgo: 40 * DAY });
		const action = nextAction(
			gatherDogfood(db, { ...opts(), depsMarkerPath: join(dir, "absent") }),
		);
		expect(action.id).toBe("collection-stopped");
		expect(action.text).toContain("40 day(s)");
		expect(action.text).toContain("warden-deps-ok");
	});

	it("reports inert-only when every recorded session is on an inert agent", () => {
		session("main", { id: "m1", msAgo: 2 * 3600_000 });
		session("Explore", { id: "e1", msAgo: 2 * 3600_000 });
		const action = nextAction(gatherDogfood(db, opts()));
		expect(action.id).toBe("inert-only");
		expect(action.text).toContain("2");
		expect(action.text).toContain("sql");
	});

	it("asks for more runs once a known agent has started but is under-armed", () => {
		session("main", { id: "m1", msAgo: 2 * 3600_000 });
		session("sql", { id: "s1", msAgo: 2 * 3600_000 });
		const action = nextAction(gatherDogfood(db, opts()));
		expect(action.id).toBe("need-more-runs");
		expect(action.text).toContain("4 more");
		expect(action.text).toContain("sql");
	});

	it("asks for a verdict when candidates are queued", () => {
		for (let i = 0; i < 5; i++) {
			session("sql", { id: `s${i}`, tokens: 100 * (i + 1), msAgo: 3600_000 });
		}
		db.prepare(
			"INSERT INTO rules (agent, body, status, context_cost, created_at) VALUES ('sql', 'x', 'candidate', 10, '2026-08-01')",
		).run();
		const action = nextAction(gatherDogfood(db, opts()));
		expect(action.id).toBe("measure-candidates");
		expect(action.text).toContain("/warden-select --agent sql");
	});

	it("says armed when a known agent is ready and nothing is queued", () => {
		for (let i = 0; i < 5; i++) {
			session("sql", { id: `s${i}`, tokens: 100 * (i + 1), msAgo: 3600_000 });
		}
		const action = nextAction(gatherDogfood(db, opts()));
		expect(action.id).toBe("armed");
		expect(action.text).toContain("400");
	});

	it("falls back to inert-only when no known agent has any session", () => {
		const data = dataWith({
			liveness: "live",
			agents: [],
			distillableSessions: 0,
			inertSessions: 0,
		});
		expect(nextAction(data).id).toBe("inert-only");
	});
});

describe("formatDogfood", () => {
	it("prints a whole date, not an ellipsis-truncated one", () => {
		session("sql", { id: "s1", msAgo: DAY });
		expect(renderDogfood(db, opts())).toContain("2026-08-12 -> 2026-08-12");
	});

	it("names inert agents, the readiness gap and one next action", () => {
		session("main", { id: "m1", msAgo: 2 * 3600_000 });
		session("sql", { id: "s1", msAgo: 2 * 3600_000 });
		const text = renderDogfood(db, opts());
		expect(text).toContain("Collection: LIVE");
		expect(text).toContain("INERT");
		expect(text).toContain("4 more completed session(s) needed");
		expect(text).toContain("NEXT (need-more-runs)");
		expect(text).toContain("OK: node_modules/.warden-deps-ok present");
	});

	it("warns when the deps marker is missing", () => {
		const text = renderDogfood(db, {
			...opts(),
			depsMarkerPath: join(dir, "absent"),
		});
		expect(text).toContain("WARNING: node_modules/.warden-deps-ok missing");
	});

	it("flags the switches when collection or distillation is off", () => {
		const text = formatDogfood(
			gatherDogfood(db, {
				...opts(),
				env: { TOKEN_WARDEN_NO_COLLECT: "1", TOKEN_WARDEN_NO_DISTILL: "1" },
			}),
		);
		expect(text).toContain("collection is OFF");
		expect(text).toContain("distillation is OFF");
	});

	it("warns when the reported threshold disagrees with the live trigger", () => {
		const armed = gatherDogfood(db, opts()).agents[0];
		const text = formatDogfood({
			...gatherDogfood(db, opts()),
			liveness: "live",
			agents: [
				{
					...(armed as NonNullable<typeof armed>),
					threshold: 1234,
					verifiedTrigger: false,
				},
			],
		});
		expect(text).toContain("WARNING: the live trigger disagrees");
	});

	it("renders a placeholder when no known agents are configured", () => {
		const text = formatDogfood({
			...gatherDogfood(db, opts()),
			agents: [],
		});
		expect(text).toContain("no known agents configured");
	});

	it("neutralises control characters in a transcript-supplied agent name", () => {
		// Adversarial input written as a JS escape, never as a literal byte
		// (test/source-hygiene.test.ts enforces that).
		session("evil\x1b[31m", { id: "x1", msAgo: DAY });
		const text = renderDogfood(db, opts());
		expect(text).not.toContain("\x1b");
		expect(text).toContain("evil");
	});
});

describe("parseDogfoodArgs", () => {
	it("defaults to a 7-day staleness window and text output", () => {
		expect(parseDogfoodArgs([])).toEqual({ staleAfterDays: 7, json: false });
	});

	it("accepts --stale-after and --json", () => {
		expect(parseDogfoodArgs(["--stale-after", "14", "--json"])).toEqual({
			staleAfterDays: 14,
			json: true,
		});
	});

	it("rejects a non-positive --stale-after and an unknown flag", () => {
		expect(() => parseDogfoodArgs(["--stale-after", "0"])).toThrow(
			/positive number of days/,
		);
		expect(() => parseDogfoodArgs(["--nope"])).toThrow(/unknown flag/);
	});
});

describe("main", () => {
	it("prints the report and exits 0", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(main([], NOW)).toBe(0);
		expect(log.mock.calls[0]?.[0]).toContain("token-warden dogfood window");
	});

	it("--json emits parseable data including the next action", () => {
		session("sql", { id: "s1", msAgo: DAY });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(main(["--json"], NOW)).toBe(0);
		const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as DogfoodData & {
			nextAction: { id: string };
		};
		expect(parsed.agents.length).toBeGreaterThan(0);
		expect(parsed.nextAction.id).toBe("need-more-runs");
	});
});

describe("read-only invariant", () => {
	it("imports only SELECT-side helpers from db.js", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../src/dogfood.ts", import.meta.url)),
			"utf8",
		);
		const block = source.match(/import \{([^}]+)\} from "\.\/db\.js";/)?.[1];
		expect(block).toBeDefined();
		const imported = (block ?? "")
			.split(",")
			.map((name) => name.replace(/^\s*type\s+/, "").trim())
			.filter((name) => name.length > 0)
			.sort();
		expect(imported).toEqual([
			"WardenDb",
			"candidateCounts",
			"realWorkByAgent",
			"recentRealWorkTotals",
			"withDb",
		]);
	});
});
