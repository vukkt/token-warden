import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateToolCosts } from "../src/attribute.js";
import {
	type NewRun,
	openDb,
	recordToolCosts,
	toolCostRollup,
	upsertRun,
	type WardenDb,
} from "../src/db.js";
import { parseTranscript } from "../src/transcript.js";
import type { RawToolEvent } from "../src/types.js";

/**
 * Internal performance benchmarks. These print throughput numbers (the "what
 * did we gain" record) and assert generous budgets so a real regression fails
 * CI while normal runner jitter does not. The hot paths are: the Stop-hook
 * transcript parser (2s budget), per-call cost attribution, and the DB rollups
 * behind the read commands.
 */
function ms(fn: () => void): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

describe("performance benchmarks", () => {
	it("parses a ~2MB transcript well within the 2s Stop-hook budget", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				id: "m",
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_read_input_tokens: 100,
				},
				content: [{ type: "tool_use", id: "t", name: "Read", input: { f: 1 } }],
			},
		});
		const jsonl = Array.from(
			{ length: Math.ceil(2_000_000 / line.length) },
			() => line,
		).join("\n");
		const bytes = jsonl.length;
		let entries = 0;
		const took = ms(() => {
			entries = parseTranscript(jsonl).entryCount;
		});
		console.log(
			`  parse: ${(bytes / 1e6).toFixed(1)}MB, ${entries} entries in ${took.toFixed(0)}ms ` +
				`(${(bytes / 1e6 / (took / 1000)).toFixed(1)} MB/s)`,
		);
		expect(entries).toBeGreaterThan(0);
		expect(took).toBeLessThan(2000);
	});

	it("attributes 50k tool events in well under a second", () => {
		const events: RawToolEvent[] = Array.from({ length: 50_000 }, (_, i) => ({
			name: i % 3 === 0 ? "Read" : `mcp__srv${i % 7}__tool`,
			skill: null,
			inputChars: 20,
			resultChars: 200,
		}));
		let rows = 0;
		const took = ms(() => {
			rows = aggregateToolCosts(events).length;
		});
		console.log(
			`  attribute: 50,000 events → ${rows} rows in ${took.toFixed(0)}ms`,
		);
		expect(rows).toBeGreaterThan(0);
		expect(took).toBeLessThan(1000);
	});

	it("rolls up tool costs over 2k sessions quickly", () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-perf-"));
		const db: WardenDb = openDb(join(dir, "warden.db"));
		try {
			const run = (sessionId: string): NewRun => ({
				agent: "backend",
				sessionId,
				taskHash: null,
				inputTokens: 1,
				outputTokens: 1,
				cacheCreation: 0,
				cacheRead: 0,
				toolCalls: 1,
				fileRereads: 0,
				completed: true,
				rulesetVersion: 0,
				ts: "2026-06-16T00:00:00Z",
				config: "real",
			});
			db.transaction(() => {
				for (let i = 0; i < 2000; i++) {
					const id = upsertRun(db, run(`s-${i}`));
					recordToolCosts(db, id, [
						{
							kind: "mcp",
							group: `srv${i % 10}`,
							label: "tool",
							calls: 1,
							inputChars: 20,
							resultChars: 200,
						},
					]);
				}
			})();
			let rows = 0;
			const took = ms(() => {
				rows = toolCostRollup(db, { limit: 50 }).length;
			});
			console.log(
				`  rollup: 2,000 sessions → ${rows} groups in ${took.toFixed(1)}ms`,
			);
			expect(rows).toBe(10);
			expect(took).toBeLessThan(500);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
