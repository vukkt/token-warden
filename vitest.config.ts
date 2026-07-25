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
			// Ratchet floor — CI fails if coverage regresses below this. Measured at
			// v0.40.0 (1023 tests): lines 96.89 / statements 96.06 /
			// functions 96.98 / branches 89.24, floored just beneath each so a
			// refactor has headroom but a regression fails. Up from 94/93/96/83 at
			// v0.39.0. Keep this comment's metric order matching the keys below,
			// and re-stamp both whenever the floor moves.
			//
			// What remains uncovered is deliberate rather than pending: the
			// `invokedDirectly` CLI dispatch blocks (already v8-ignored, exercised
			// as real subprocesses), the un-seamed IO in copyFixture /
			// ensureFixtureDeps, and the collect/notify entry shims. bench.ts is
			// the lowest at ~87% lines and is the honest integration boundary.
			thresholds: {
				lines: 96,
				statements: 96,
				functions: 96,
				branches: 89,
			},
		},
	},
});
