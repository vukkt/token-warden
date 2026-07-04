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
			// Ratchet floor — CI fails if coverage regresses below this. Raised
			// as tests are added; measured 95.0/93.9/97.2/84.3 at v0.33.0, floored
			// just beneath so a refactor has headroom but a regression fails.
			thresholds: {
				lines: 94,
				statements: 93,
				functions: 96,
				branches: 83,
			},
		},
	},
});
