import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("plugin scaffold", () => {
	it("plugin.json has the required fields and matches the package version", async () => {
		const manifest = JSON.parse(
			await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"),
		) as { name: string; version: string };
		const pkg = JSON.parse(
			await readFile(join(root, "package.json"), "utf8"),
		) as { version: string };
		expect(manifest.name).toBe("token-warden");
		expect(manifest.version).toBe(pkg.version);
	});

	it("hooks.json registers the Stop collector via the plugin root", async () => {
		const raw = await readFile(join(root, "hooks", "hooks.json"), "utf8");
		const config = JSON.parse(raw) as {
			hooks: { Stop?: { hooks: { type: string; command: string }[] }[] };
		};
		const stop = config.hooks.Stop?.[0]?.hooks[0];
		expect(stop?.type).toBe("command");
		expect(stop?.command).toContain("CLAUDE_PLUGIN_ROOT");
		expect(stop?.command).toContain("src/collect.ts");
	});
});
