/**
 * PINS THE PUBLISHED COVARIATE-ADJUSTMENT NUMBERS.
 *
 * FINDINGS.md's "Covariate adjustment" section rejects CUPED on one number: on
 * the naive-headroom positive control — the only rule this project has ever
 * measured surviving the gate on a real effect — a CUPED adjustment on
 * `tool_calls` subtracts 105.4% of the recorded saving away. That is the whole
 * argument, so it is asserted here against a frozen extract of the runs it was
 * computed from (test/fixtures/sql-naive-headroom.json: all 20 golden rows the
 * naive-headroom experiment recorded, agent `sql`, ruleset versions 0 and 1).
 *
 * The precedent and the reason are test/variance-published.test.ts's: a
 * published headline was wrong for weeks here while an accurate caveat
 * travelled beside it, because nothing pinned the number. A caveat is not a
 * check.
 *
 * Static artifact, never a live read — tests must not touch `~/.token-warden`
 * (test/setup.ts enforces it), and pinning against a moving ledger pins
 * nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mean } from "../src/stats.js";
import {
	buildPools,
	passThrough,
	pooledSlope,
} from "../validation/covariate-adjustment.js";
import type { AnalysisRun } from "../validation/variance-decomposition.js";

const RUNS: AnalysisRun[] = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("./fixtures/sql-naive-headroom.json", import.meta.url),
		),
		"utf8",
	),
);

/** The pools the tool builds at `--min-pool 2`, which is what the published
 * run used: this experiment recorded two runs per task per arm. */
const POOLS = buildPools(RUNS, 2);
const SLOPE = pooledSlope(POOLS.map((p) => p.runs));

describe("the naive-headroom positive control", () => {
	it("is the 20-run, two-arm extract the figures were computed from", () => {
		expect(RUNS).toHaveLength(20);
		expect(RUNS.every((r) => r.completed)).toBe(true);
		expect([...new Set(RUNS.map((r) => r.rulesetVersion))].sort()).toEqual([
			0, 1,
		]);
		expect([...new Set(RUNS.map((r) => r.taskId))]).toHaveLength(5);
	});

	it("reproduces the recorded +10,699 tokens/run saving", () => {
		// FINDINGS.md, "Positive control (2026-06)". The document's headline is
		// this number; if the extract ever stops producing it, the extract is
		// wrong and every figure below it is worthless.
		const rows = passThrough(RUNS, 0, 1, SLOPE.theta);
		expect(rows).toHaveLength(5);
		expect(Math.round(mean(rows.map((r) => r.deltaTokens)))).toBe(10_699);
	});

	it("prices one tool call at ~10,256 tokens on this pool", () => {
		expect(Math.round(SLOPE.theta)).toBe(10_256);
		// The covariate explains the great majority of the within-pass spread,
		// which is what makes it look like an irresistible CUPED covariate.
		expect(SLOPE.r2).toBeGreaterThan(0.8);
	});

	it("shows CUPED subtracting 105.4% of a REAL rule's saving away", () => {
		// THE REJECTION, pinned. The rule that validated this project's engine
		// measures NEGATIVE under the adjustment.
		const rows = passThrough(RUNS, 0, 1, SLOPE.theta);
		const delta = mean(rows.map((r) => r.deltaTokens));
		const absorbed = mean(rows.map((r) => r.absorbed));
		expect(absorbed / delta).toBeCloseTo(1.054, 3);
		expect(delta - absorbed).toBeLessThan(0);
	});
});
