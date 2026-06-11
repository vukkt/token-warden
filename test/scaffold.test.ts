import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("plugin scaffold", () => {
	it("plugin.json has the required manifest fields", async () => {
		const raw = await readFile(
			join(root, ".claude-plugin", "plugin.json"),
			"utf8",
		);
		const manifest: unknown = JSON.parse(raw);
		expect(manifest).toMatchObject({
			name: "token-warden",
			version: "0.1.0",
		});
	});

	it("hooks.json is valid JSON with an empty hooks map", async () => {
		const raw = await readFile(join(root, "hooks", "hooks.json"), "utf8");
		const config: unknown = JSON.parse(raw);
		expect(config).toEqual({ hooks: {} });
	});
});
