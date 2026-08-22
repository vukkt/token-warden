import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Hard guard against a test reading or writing the user's real ledger or
		// agent memory. Every suite already points these at a temp dir by
		// convention; this makes the harness enforce it. See test/setup.ts.
		setupFiles: ["test/setup.ts"],
		// The fixture has its own suite; it runs inside bench temp copies only.
		exclude: ["benchmarks/**", "node_modules/**"],
		coverage: {
			provider: "v8",
			reporter: ["text-summary", "text"],
			include: ["src/**/*.ts"],
			// CLI entrypoints (the `invokedDirectly` main/dispatch blocks) run as
			// real subprocesses in e2e checks, not under vitest, so the harness
			// can't count them; the pure logic they wrap is unit-tested directly.
			exclude: ["src/**/*.d.ts"],
			// Ratchet floor — CI fails if coverage regresses below this.
			//
			// RE-BASELINED at v1.0.0, and the reason matters. The v0.40.0 floor
			// (lines 96.89 / statements 96.06 / functions 96.98 / branches 89.24)
			// was measured across 45 modules. v1.0.0 deleted 21 of them — the RAG
			// subtree, the A/B benchmarking suite, the team ledger and ten advisory
			// commands — and those were pure, easily-tested logic sitting at high
			// 90s. Removing them did not make anything less tested; it removed the
			// ballast that was diluting `bench.ts`, which spawns real `claude`
			// subprocesses and has always been this repo's integration boundary.
			// Global statements fell to 94.94 on that composition change alone.
			//
			// A per-file threshold for bench.ts would be the better tool -- it would
			// keep the global bar high and pin the boundary separately -- but the
			// glob form of `thresholds` does not take effect on this vitest version
			// (tried "src/bench.ts" and "**/bench.ts"; neither is excluded from the
			// global figure). So the STATEMENTS floor drops to 94 and the other
			// three stay where they were. Worth revisiting when vitest is next
			// upgraded.
			//
			// What remains uncovered is deliberate rather than pending: the
			// `invokedDirectly` CLI dispatch blocks (already v8-ignored, exercised
			// as real subprocesses), the un-seamed IO in copyFixture /
			// ensureFixtureDeps, `defaultRunOnceDeps` (the real-spawn injection
			// object that every test replaces with a fake), and the collect/notify
			// entry shims.
			//
			// Keep this comment's metric order matching the keys below, and
			// re-stamp both whenever the floor moves.
			// Measured at v1.0.0 (1030 tests): lines 96.07 / statements 94.94 /
			// functions 96.65 / branches 89.22, floored just beneath each.
			thresholds: {
				lines: 96,
				statements: 94,
				functions: 96,
				branches: 89,
			},
		},
	},
});
