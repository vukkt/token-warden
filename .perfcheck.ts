import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, RUN_TOTAL_TOKENS_SQL } from "./src/db.js";

const dir = mkdtempSync(join(tmpdir(), "warden-perf-"));
const db = openDb(join(dir, "warden.db"));

const ROWS = 100_000;
const insert = db.prepare(
	`INSERT INTO runs (agent, session_id, task_hash, input_tokens, output_tokens,
	 cache_creation, cache_read, tool_calls, file_rereads, completed,
	 ruleset_version, ts, config)
	 VALUES (?, ?, NULL, ?, 0, 0, 0, 1, 0, ?, 0, ?, 'real')`,
);
const tx = db.transaction(() => {
	for (let i = 0; i < ROWS; i++) {
		insert.run(
			"sql",
			`s-${i}`,
			1000 + (i % 500),
			i % 10 === 0 ? 0 : 1, // 10% incomplete, like real interrupted sessions
			new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, 0)).toISOString(),
		);
	}
});
tx();
db.exec("ANALYZE");

const CURRENT = `SELECT ${RUN_TOTAL_TOKENS_SQL} AS total
	 FROM runs WHERE agent = ? AND id != ? AND task_hash IS NULL
	 ORDER BY ts DESC LIMIT ?`;
const FIXED = `SELECT COALESCE(${RUN_TOTAL_TOKENS_SQL}, 0) AS total
	 FROM runs WHERE agent = ? AND id != ? AND task_hash IS NULL AND completed = 1
	 ORDER BY ts DESC LIMIT ?`;

function plan(sql: string): string {
	return (
		db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("sql", 1, 50) as {
			detail: string;
		}[]
	)
		.map((r) => r.detail)
		.join("\n    ");
}

function time(sql: string): number {
	const stmt = db.prepare(sql);
	stmt.all("sql", 1, 50); // warm
	const t0 = performance.now();
	for (let i = 0; i < 20; i++) stmt.all("sql", 1, 50);
	return (performance.now() - t0) / 20;
}

console.log(`rows: ${ROWS}\n`);
console.log("CURRENT (no completed predicate):");
console.log(`    ${plan(CURRENT)}`);
console.log(`  -> ${time(CURRENT).toFixed(2)} ms\n`);
console.log("FIXED (with completed = 1):");
console.log(`    ${plan(FIXED)}`);
console.log(`  -> ${time(FIXED).toFixed(2)} ms\n`);

// Semantic check: how much does the p75 actually move?
const rows = (sql: string) =>
	(db.prepare(sql).all("sql", 1, 50) as { total: number }[]).map(
		(r) => r.total,
	);
const p75 = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return s[Math.max(0, Math.ceil(0.75 * s.length) - 1)];
};
console.log(
	`p75 current: ${p75(rows(CURRENT))}, p75 fixed: ${p75(rows(FIXED))}`,
);

db.close();
rmSync(dir, { recursive: true, force: true });
