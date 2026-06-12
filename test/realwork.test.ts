import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	openDb,
	realWorkCurveByAgent,
	realWorkCurveByProject,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import { formatRealWorkCurve, renderStatus } from "../src/status.js";

let dir: string;
let db: WardenDb;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-realwork-"));
	db = openDb(join(dir, "warden.db"));
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

let sessionCounter = 0;
function seedReal(
	agent: string,
	tokens: number,
	rulesetVersion: number,
	options: {
		project?: string | null;
		completed?: boolean;
		taskHash?: string | null;
	} = {},
): void {
	sessionCounter++;
	upsertRun(db, {
		agent,
		sessionId: `rw-${sessionCounter}`,
		taskHash: options.taskHash ?? null,
		inputTokens: tokens,
		outputTokens: 0,
		cacheCreation: 0,
		cacheRead: 0,
		toolCalls: 1,
		fileRereads: 0,
		completed: options.completed ?? true,
		rulesetVersion,
		ts: new Date().toISOString(),
		config: "real",
		project: options.project ?? "/proj/alpha",
	});
}

describe("realWorkCurveByAgent", () => {
	it("averages completed real-work sessions per ruleset version", () => {
		seedReal("sql", 50_000, 0);
		seedReal("sql", 40_000, 0);
		seedReal("sql", 30_000, 2);
		expect(realWorkCurveByAgent(db, "sql")).toEqual([
			{ rulesetVersion: 0, runs: 2, avgTokens: 45_000 },
			{ rulesetVersion: 2, runs: 1, avgTokens: 30_000 },
		]);
	});

	it("excludes incomplete sessions and golden runs", () => {
		seedReal("sql", 50_000, 0);
		seedReal("sql", 999_999, 0, { completed: false });
		seedReal("sql", 999_999, 0, { taskHash: "sql-01" });
		expect(realWorkCurveByAgent(db, "sql")).toEqual([
			{ rulesetVersion: 0, runs: 1, avgTokens: 50_000 },
		]);
	});
});

describe("realWorkCurveByProject", () => {
	it("pools domain agents per project and excludes main", () => {
		seedReal("sql", 50_000, 0, { project: "/proj/alpha" });
		seedReal("backend", 30_000, 0, { project: "/proj/alpha" });
		seedReal("sql", 20_000, 1, { project: "/proj/alpha" });
		seedReal("frontend", 10_000, 0, { project: "/proj/beta" });
		seedReal("main", 999_999, 0, { project: "/proj/alpha" });

		expect(realWorkCurveByProject(db, 5)).toEqual([
			{ project: "/proj/alpha", rulesetVersion: 0, runs: 2, avgTokens: 40_000 },
			{ project: "/proj/alpha", rulesetVersion: 1, runs: 1, avgTokens: 20_000 },
			{ project: "/proj/beta", rulesetVersion: 0, runs: 1, avgTokens: 10_000 },
		]);
	});

	it("caps to the heaviest projects", () => {
		for (let p = 0; p < 4; p++) {
			seedReal("sql", (p + 1) * 10_000, 0, { project: `/proj/p${p}` });
		}
		const projects = new Set(
			realWorkCurveByProject(db, 2).map((r) => r.project),
		);
		expect(projects).toEqual(new Set(["/proj/p3", "/proj/p2"]));
	});
});

describe("formatRealWorkCurve", () => {
	it("renders the version sequence with the change vs the first version", () => {
		expect(
			formatRealWorkCurve([
				{ rulesetVersion: 0, runs: 3, avgTokens: 48_770 },
				{ rulesetVersion: 2, runs: 5, avgTokens: 31_002 },
			]),
		).toBe("v0 48,770 (n=3) → v2 31,002 (n=5)  [-36.4% vs v0]");
	});

	it("omits the change for a single point", () => {
		expect(
			formatRealWorkCurve([{ rulesetVersion: 0, runs: 1, avgTokens: 1000 }]),
		).toBe("v0 1,000 (n=1)");
	});
});

describe("status integration", () => {
	it("renders both real-work learning sections", () => {
		seedReal("sql", 50_000, 0);
		seedReal("sql", 30_000, 2);
		const report = renderStatus(db);
		expect(report).toContain("Real-work learning");
		expect(report).toContain(
			"sql: v0 50,000 (n=1) → v2 30,000 (n=1)  [-40.0% vs v0]",
		);
		expect(report).toContain("/proj/alpha: v0 50,000 (n=1) → v2 30,000 (n=1)");
	});

	it("says so when no domain-agent real work exists yet", () => {
		seedReal("main", 10_000, 0);
		const report = renderStatus(db);
		expect(report).toContain(
			"no completed real-work sessions from domain agents yet",
		);
	});
});
