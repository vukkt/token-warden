import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
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
			// Ratchet floor — CI fails if coverage regresses below this. Raised as
			// tests are added; measured at v0.40.0 (1001 tests) as
			// lines 97.91 / statements 97.14 / functions 97.56 / branches 90.09,
			// floored ~1pt beneath each so a refactor has headroom but a
			// regression fails. Keep this comment's metric order matching the
			// keys below, and re-stamp both whenever the floor moves.
			thresholds: {
				lines: 97,
				statements: 96,
				functions: 97,
				branches: 89,
			},
		},
	},
});
