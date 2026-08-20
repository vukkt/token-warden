/**
 * The brand vocabulary in `src/types.ts` is a PLANNED migration, and this test
 * is what keeps that claim honest.
 *
 * Nine of its ten exported brands are currently adopted by nothing. That is
 * defensible for deliberate in-progress vocabulary and indefensible for code
 * nobody remembers writing, and from the outside the two look identical. So the
 * unadopted set is pinned here: it may SHRINK freely as brands get adopted, and
 * growing it requires editing this list, which is the conversation a reviewer
 * should have to have.
 *
 * `knip` does not catch this. It reports unused VALUES, not unused type
 * exports, so type-only dead code is invisible to the dead-code guard entirely
 * — the same shape as every other blind spot this repo has found (a check that
 * reports clean while looking at nothing). A previous pass attributed the
 * blindness to knip's `tags: ["-@public"]` suppression; that was wrong, and
 * removing the tag changes nothing here, which is why this test exists instead.
 *
 * Zero tokens: pure source inspection.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesFile = join(root, "src", "types.ts");

/**
 * Brands exported but not yet used anywhere. Every entry is a promise that
 * someone intends to adopt it; ROADMAP carries the plan. Delete from this list
 * when you adopt one — never add without a reason a reviewer would accept.
 */
const UNADOPTED = new Set([
	"Brand",
	"AgentName",
	"TaskId",
	"RulesetVersion",
	"TokenCount",
	"UsdAmount",
	"ArmRole",
	"AbDimension",
	"AbOutcome",
]);

function exportedTypeNames(source: string): string[] {
	return [...source.matchAll(/^export type (\w+)/gm)].map(
		(m) => m[1] as string,
	);
}

function usedOutsideTypes(name: string): boolean {
	const pattern = new RegExp(`\\b${name}\\b`);
	for (const dir of ["src", "validation", "test"]) {
		for (const file of readdirSync(join(root, dir))) {
			// Skip types.ts (the declaration site) and this file, whose UNADOPTED
			// list names every brand and would otherwise match itself.
			if (!file.endsWith(".ts")) continue;
			if (file === "types.ts" || file === "types-adoption.test.ts") continue;
			if (pattern.test(readFileSync(join(root, dir, file), "utf8")))
				return true;
		}
	}
	return false;
}

describe("brand vocabulary adoption", () => {
	const exported = exportedTypeNames(readFileSync(typesFile, "utf8"));

	it("finds the vocabulary at all", () => {
		expect(exported).toContain("RuleId");
		expect(exported.length).toBeGreaterThan(5);
	});

	it("every brand is adopted or listed as unadopted", () => {
		const unlisted = exported.filter(
			(name) => !UNADOPTED.has(name) && !usedOutsideTypes(name),
		);
		expect(unlisted).toEqual([]);
	});

	it("no listed brand has quietly become adopted", () => {
		// The list may only shrink deliberately. A brand that got adopted while
		// still listed here means the list stopped describing the code.
		const stale = [...UNADOPTED].filter((name) => usedOutsideTypes(name));
		expect(stale).toEqual([]);
	});

	it("RuleId proves the pattern is live rather than aspirational", () => {
		// The argument for keeping unadopted vocabulary rests on this: at least
		// one brand is really in use, so the migration is underway, not imagined.
		expect(UNADOPTED.has("RuleId")).toBe(false);
		expect(usedOutsideTypes("RuleId")).toBe(true);
	});
});
