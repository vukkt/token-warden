import { describe, expect, it } from "vitest";
import {
	aggregateToolCosts,
	classifyTool,
	footprint,
} from "../src/tool-cost.js";
import type { RawToolEvent } from "../src/types.js";

function event(over: Partial<RawToolEvent>): RawToolEvent {
	return {
		name: "Read",
		skill: null,
		inputChars: 10,
		resultChars: 100,
		...over,
	};
}

describe("classifyTool", () => {
	it("classifies a builtin tool", () => {
		expect(classifyTool("Read", null)).toEqual({
			kind: "builtin",
			group: "(builtin)",
			label: "Read",
		});
	});

	it("splits an MCP tool into server and tool", () => {
		expect(classifyTool("mcp__github__create_issue", null)).toEqual({
			kind: "mcp",
			group: "github",
			label: "create_issue",
		});
	});

	it("keeps a server name that contains single underscores intact", () => {
		expect(classifyTool("mcp__claude_ai_Gmail__send_email", null)).toEqual({
			kind: "mcp",
			group: "claude_ai_Gmail",
			label: "send_email",
		});
	});

	it("preserves a tool name that itself contains a double underscore", () => {
		expect(classifyTool("mcp__srv__a__b", null).label).toBe("a__b");
	});

	it("falls back to (unknown) for a malformed mcp name", () => {
		expect(classifyTool("mcp__", null)).toEqual({
			kind: "mcp",
			group: "(unknown)",
			label: "(unknown)",
		});
	});

	it("uses the skill name for the Skill tool", () => {
		expect(classifyTool("Skill", "code-review")).toEqual({
			kind: "skill",
			group: "(skills)",
			label: "code-review",
		});
	});

	it("labels a Skill with no name as (unknown)", () => {
		expect(classifyTool("Skill", null).label).toBe("(unknown)");
	});
});

describe("aggregateToolCosts", () => {
	it("groups by class and sums calls and footprint", () => {
		const costs = aggregateToolCosts([
			event({ name: "Read", inputChars: 5, resultChars: 50 }),
			event({ name: "Read", inputChars: 5, resultChars: 70 }),
			event({ name: "mcp__github__list", inputChars: 8, resultChars: 200 }),
		]);
		const read = costs.find((c) => c.label === "Read");
		expect(read).toMatchObject({ calls: 2, inputChars: 10, resultChars: 120 });
		expect(costs.find((c) => c.kind === "mcp")?.calls).toBe(1);
	});

	it("sorts by total footprint descending, then label", () => {
		const costs = aggregateToolCosts([
			event({ name: "Read", inputChars: 1, resultChars: 1 }),
			event({ name: "Bash", inputChars: 1, resultChars: 999 }),
		]);
		expect(costs.map((c) => c.label)).toEqual(["Bash", "Read"]);
	});

	it("returns nothing for no events", () => {
		expect(aggregateToolCosts([])).toEqual([]);
	});

	it("footprint sums input and result chars", () => {
		expect(footprint({ inputChars: 3, resultChars: 4 })).toBe(7);
	});
});
