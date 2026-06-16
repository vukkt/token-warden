#!/usr/bin/env node
/**
 * Assert the package.json and plugin.json versions agree. A drift between the
 * two means the plugin would advertise a different version than the package —
 * the kind of release-day mistake CI should catch, not the user.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
const plugin = JSON.parse(
	readFileSync(".claude-plugin/plugin.json", "utf8"),
).version;

if (pkg !== plugin) {
	console.error(
		`version mismatch: package.json ${pkg} != .claude-plugin/plugin.json ${plugin}`,
	);
	process.exit(1);
}
console.log(`versions consistent: ${pkg}`);
