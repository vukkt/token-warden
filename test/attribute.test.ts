import { describe, expect, it } from "vitest";
import {
	aggregateToolCosts,
	attributeTranscript,
	classifyTool,
	estTokens,
	footprint,
	parseAttributeArgs,
	renderRollup,
	renderTranscriptAttribution,
} from "../src/attribute.js";
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

	it("estTokens divides chars by four and rounds", () => {
		expect(estTokens(10)).toBe(3);
		expect(estTokens(0)).toBe(0);
	});
});

describe("attributeTranscript", () => {
	const assistant = (id: string, name: string, input: unknown) =>
		JSON.stringify({
			type: "assistant",
			message: {
				id: `m-${id}`,
				usage: { input_tokens: 1, output_tokens: 1 },
				content: [{ type: "tool_use", id, name, input }],
			},
		});
	const result = (id: string, text: string) =>
		JSON.stringify({
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: id, content: text }],
			},
		});

	it("joins tool calls to their results and rolls up by kind", () => {
		const jsonl = [
			assistant("t1", "Read", { file_path: "/a.ts" }),
			result("t1", "x".repeat(400)),
			assistant("t2", "mcp__github__create_issue", { title: "bug" }),
			result("t2", "y".repeat(40)),
			assistant("t3", "Skill", { skill: "code-review", args: "" }),
			result("t3", "z".repeat(80)),
		].join("\n");

		const report = attributeTranscript(jsonl);
		expect(report.totalCalls).toBe(3);
		expect(report.byKind.builtin.calls).toBe(1);
		expect(report.byKind.mcp.calls).toBe(1);
		expect(report.byKind.skill.calls).toBe(1);

		const read = report.costs.find((c) => c.label === "Read");
		expect(read?.resultChars).toBe(400);
		expect(read?.inputChars).toBeGreaterThan(0);

		const skill = report.costs.find((c) => c.kind === "skill");
		expect(skill?.label).toBe("code-review");
		expect(skill?.resultChars).toBe(80);
	});

	it("reports zero result chars when a call has no result", () => {
		const report = attributeTranscript(
			assistant("t1", "Bash", { command: "ls" }),
		);
		expect(report.costs[0]?.resultChars).toBe(0);
		expect(report.costs[0]?.calls).toBe(1);
	});

	it("is empty for a transcript with no tool calls", () => {
		const jsonl = JSON.stringify({
			type: "assistant",
			message: { id: "m", usage: {}, content: [{ type: "text", text: "hi" }] },
		});
		const report = attributeTranscript(jsonl);
		expect(report.costs).toEqual([]);
		expect(report.totalCalls).toBe(0);
	});

	it("sums an array-form tool_result's text blocks", () => {
		const jsonl = [
			assistant("t1", "Grep", { pattern: "x" }),
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [
								{ type: "text", text: "abc" },
								{ type: "text", text: "de" },
							],
						},
					],
				},
			}),
		].join("\n");
		expect(attributeTranscript(jsonl).costs[0]?.resultChars).toBe(5);
	});

	it("counts good text blocks even when a result array has odd siblings", () => {
		// A bare string / number / image block beside real text must not zero
		// out the whole result's footprint (regression: schema poisoning).
		const jsonl = [
			assistant("t1", "Grep", { pattern: "x" }),
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [
								{ type: "image", source: { data: "..." } },
								{ type: "text", text: "realtext" },
								12345,
								null,
								"bare string sibling",
							],
						},
					],
				},
			}),
		].join("\n");
		expect(attributeTranscript(jsonl).costs[0]?.resultChars).toBe(8);
	});
});

describe("renderers", () => {
	it("render a transcript breakdown without throwing and note token estimate", () => {
		const report = attributeTranscript(
			JSON.stringify({
				type: "assistant",
				message: {
					id: "m",
					usage: {},
					content: [
						{ type: "tool_use", id: "t1", name: "Read", input: { f: 1 } },
					],
				},
			}),
		);
		const text = renderTranscriptAttribution(report);
		expect(text).toContain("tool cost attribution");
		expect(text).toContain("Read");
	});

	it("renders an empty rollup with a friendly message", () => {
		expect(renderRollup([], "all agents")).toContain("No tool costs recorded");
	});

	it("renders rollup rows", () => {
		const text = renderRollup(
			[
				{
					kind: "mcp",
					grp: "github",
					label: "create_issue",
					sessions: 3,
					calls: 9,
					inputChars: 400,
					resultChars: 1600,
				},
			],
			"all agents",
		);
		expect(text).toContain("github");
		expect(text).toContain("create_issue");
	});
});

describe("parseAttributeArgs", () => {
	it("defaults to a cross-session rollup", () => {
		expect(parseAttributeArgs([])).toEqual({
			transcript: null,
			agent: null,
			kind: null,
			json: false,
			limit: 30,
		});
	});

	it("parses all flags", () => {
		expect(
			parseAttributeArgs([
				"--transcript",
				"/x.jsonl",
				"--agent",
				"backend",
				"--kind",
				"mcp",
				"--limit",
				"5",
				"--json",
			]),
		).toEqual({
			transcript: "/x.jsonl",
			agent: "backend",
			kind: "mcp",
			json: true,
			limit: 5,
		});
	});

	it("rejects an invalid kind", () => {
		expect(() => parseAttributeArgs(["--kind", "bogus"])).toThrow(/--kind/);
	});

	it("rejects a non-positive limit", () => {
		expect(() => parseAttributeArgs(["--limit", "0"])).toThrow(/--limit/);
		expect(() => parseAttributeArgs(["--limit", "x"])).toThrow(/--limit/);
	});

	it("rejects an unknown flag", () => {
		expect(() => parseAttributeArgs(["--nope"])).toThrow(/unknown flag/);
	});
});
