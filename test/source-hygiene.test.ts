import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards against invisible non-text bytes in source. A stray NUL or ANSI/
 * control byte compiles fine and passes other tests, but makes tools treat
 * the file as binary and is not production-clean. (We once shipped two NUL
 * bytes as a map-key delimiter in attribute.ts.) Adversarial inputs in tests
 * must be written as JS escapes (\x00, \x1b, …), not literal bytes.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function disallowedBytes(buf: Buffer): number[] {
	const offsets: number[] = [];
	for (let i = 0; i < buf.length; i++) {
		const b = buf[i] as number;
		if ((b < 0x20 && !ALLOWED_CONTROL.has(b)) || b === 0x7f) offsets.push(i);
	}
	return offsets;
}

describe("source hygiene", () => {
	const files = [
		...tsFiles(join(repoRoot, "src")),
		...tsFiles(join(repoRoot, "test")),
	];

	it("finds source files to scan", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it.each(files)("%s contains no NUL or disallowed control bytes", (file) => {
		const offsets = disallowedBytes(readFileSync(file));
		expect(
			offsets,
			`disallowed bytes at offsets ${offsets.join(", ")}`,
		).toEqual([]);
	});
});
