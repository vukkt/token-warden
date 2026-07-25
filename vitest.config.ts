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
			// v0.40.0 (1017 tests): lines 96.37 / statements 95.56 /
			// functions 96.15 / branches 88.78, floored just beneath each so a
			// refactor has headroom but a regression fails. Up from 94/93/96/83
			// at v0.39.0. Keep this comment's metric order matching the keys below,
			// and re-stamp both whenever the floor moves.
			//
			// It peaked at 97.91/97.14/97.56/90.09 mid-pass and then fell back as
			// the last round of hardening added ~125 lines (the SQLITE_BUSY retry,
			// the notify/gate fail-open handlers, the bench subprocess guards)
			// whose tests are only partly written. The uncovered remainder is
			// concentrated in bench.ts, gate.ts and the collect/notify entry
			// shims; finishing it is the cheapest available coverage work.
			thresholds: {
				lines: 96,
				statements: 95,
				functions: 96,
				branches: 88,
			},
		},
	},
});
