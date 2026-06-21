import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assessAgentCohorts,
	assessCohorts,
	type CohortStat,
	cohortStats,
	parseCohortArgs,
	renderCohort,
} from "../src/cohort.js";
import { openDb, upsertRun, type WardenDb } from "../src/db.js";

describe("cohortStats", () => {
	it("groups by version (ordered) with mean and standard error", () => {
		const stats = cohortStats([
			{ rulesetVersion: 1, total: 100 },
			{ rulesetVersion: 0, total: 200 },
			{ rulesetVersion: 0, total: 400 },
			{ rulesetVersion: 1, total: 300 },
		]);
		expect(stats.map((s) => s.rulesetVersion)).toEqual([0, 1]);
		expect(stats[0]?.n).toBe(2);
		expect(stats[0]?.mean).toBe(300);
		expect(stats[0]?.stdErr).not.toBeNull();
	});

	it("returns null stdErr for a single-sample cohort", () => {
		const [only] = cohortStats([{ rulesetVersion: 0, total: 500 }]);
		expect(only?.n).toBe(1);
		expect(only?.stdDev).toBe(0);
		expect(only?.stdErr).toBeNull();
	});

	it("is empty for no input", () => {
		expect(cohortStats([])).toEqual([]);
	});
});

function stat(
	rulesetVersion: number,
	n: number,
	mean: number,
	stdErr: number | null,
): CohortStat {
	return {
		rulesetVersion,
		n,
		mean,
		stdDev: stdErr === null ? 0 : stdErr * Math.sqrt(n),
		stdErr,
	};
}

describe("assessCohorts", () => {
	it("is insufficient-data with fewer than two cohorts", () => {
		expect(assessCohorts([]).verdict).toBe("insufficient-data");
		expect(assessCohorts([stat(0, 9, 100, 5)]).verdict).toBe(
			"insufficient-data",
		);
	});

	it("is insufficient-data when a cohort is below min-n", () => {
		const a = assessCohorts([stat(0, 3, 100, 5), stat(1, 9, 90, 5)], 5);
		expect(a.verdict).toBe("insufficient-data");
	});

	it("reports improved on a confident drop", () => {
		const a = assessCohorts(
			[stat(0, 8, 50_000, 800), stat(1, 8, 40_000, 800)],
			5,
		);
		expect(a.verdict).toBe("improved");
		expect(a.delta).toBe(10_000);
		expect(a.confident).toBe(true);
		expect(a.pctDelta).toBeGreaterThan(0);
	});

	it("reports regressed on a confident rise", () => {
		const a = assessCohorts(
			[stat(0, 8, 40_000, 800), stat(1, 8, 50_000, 800)],
			5,
		);
		expect(a.verdict).toBe("regressed");
		expect(a.delta).toBeLessThan(0);
		expect(a.confident).toBe(true);
	});

	it("reports no-change when the difference is inside the noise", () => {
		const a = assessCohorts(
			[stat(0, 8, 50_000, 6_000), stat(1, 8, 48_000, 6_000)],
			5,
		);
		expect(a.verdict).toBe("no-change");
		expect(a.confident).toBe(false);
	});
});

describe("assessAgentCohorts (db-backed)", () => {
	let dir: string;
	let db: WardenDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-cohort-"));
		db = openDb(join(dir, "warden.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function seed(
		agent: string,
		version: number,
		total: number,
		sessionId: string,
		taskHash: string | null = null,
	): void {
		upsertRun(db, {
			agent,
			sessionId,
			taskHash,
			inputTokens: total,
			outputTokens: 0,
			cacheCreation: 0,
			cacheRead: 0,
			toolCalls: 1,
			fileRereads: 0,
			completed: true,
			rulesetVersion: version,
			ts: new Date().toISOString(),
		});
	}

	it("reports improved when real-work cost dropped after a rule", () => {
		const v0 = [48_000, 50_000, 52_000, 49_000, 51_000, 50_000];
		const v1 = [38_000, 40_000, 42_000, 39_000, 41_000, 40_000];
		v0.forEach((t, i) => {
			seed("sql", 0, t, `v0-${i}`);
		});
		v1.forEach((t, i) => {
			seed("sql", 1, t, `v1-${i}`);
		});
		const { assessment } = assessAgentCohorts(db, "sql", 5);
		expect(assessment.verdict).toBe("improved");
		expect(assessment.delta).toBe(10_000);
	});

	it("ignores golden runs and other agents", () => {
		// Real sql work, one ruleset version — not enough to compare.
		for (let i = 0; i < 6; i++) seed("sql", 0, 50_000, `real-${i}`);
		// Golden runs (task_hash set) and another agent must not leak in.
		for (let i = 0; i < 6; i++) seed("sql", 1, 1_000, `gold-${i}`, "sql-01");
		for (let i = 0; i < 6; i++) seed("backend", 1, 1_000, `be-${i}`);
		const { assessment } = assessAgentCohorts(db, "sql", 5);
		// Only the v0 real-work cohort exists for sql -> nothing to compare.
		expect(assessment.verdict).toBe("insufficient-data");
	});
});

describe("parseCohortArgs", () => {
	it("parses all flags", () => {
		expect(
			parseCohortArgs([
				"--agent",
				"sql",
				"--project",
				"/p",
				"--min-n",
				"8",
				"--json",
			]),
		).toEqual({ agent: "sql", project: "/p", minN: 8, json: true });
	});

	it("defaults agent/project to null and min-n to 5", () => {
		expect(parseCohortArgs([])).toEqual({
			agent: null,
			project: null,
			minN: 5,
			json: false,
		});
	});

	it("rejects an unknown flag and a bad min-n", () => {
		expect(() => parseCohortArgs(["--nope"])).toThrow(/unknown flag/);
		expect(() => parseCohortArgs(["--min-n", "1"])).toThrow(/min-n/);
	});
});

describe("renderCohort", () => {
	it("shows the verdict and the observational caveat", () => {
		const a = assessCohorts(
			[stat(0, 8, 50_000, 800), stat(1, 8, 40_000, 800)],
			5,
		);
		const text = renderCohort("sql", null, a);
		expect(text).toContain("cohort validation — sql");
		expect(text).toContain("verdict: IMPROVED");
		expect(text).toContain("observational");
	});
});
