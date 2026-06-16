#!/usr/bin/env node
/**
 * Print the CHANGELOG.md body for one version, used by the release job to
 * publish notes straight from the changelog (single source of truth). Exits
 * non-zero if the version has no section, so a tag can never ship empty notes.
 *
 * Usage: node scripts/changelog-section.mjs 0.15.0
 */
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
	console.error("usage: changelog-section.mjs <version>");
	process.exit(1);
}

const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
const start = lines.findIndex((line) => line.startsWith(`## v${version}`));
if (start === -1) {
	console.error(`no CHANGELOG section found for v${version}`);
	process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
if (end === -1) end = lines.length;

const body = lines
	.slice(start + 1, end)
	.join("\n")
	.trim();
if (body === "") {
	console.error(`CHANGELOG section for v${version} is empty`);
	process.exit(1);
}
console.log(body);
