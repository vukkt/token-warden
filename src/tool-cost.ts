/**
 * Tool / skill / MCP call classification and rollup.
 *
 * This is the surviving half of the old `attribute.ts`. That module was a
 * command (`/warden-attribute`) that answered "where did the tokens go?" with
 * a rendered decomposition; the command was removed in v1.0.0 because it never
 * promoted, evicted, or measured a rule, so nothing downstream ever acted on
 * its output.
 *
 * What stays is the part that is not advisory at all: the Stop hook classifies
 * every tool call it parses and writes the rollup to `tool_costs`, and
 * `status.ts` reads it back. Deleting this with the command would have removed
 * a column the dashboard still renders.
 *
 * Footprint is measured in characters — exact and deterministic — split into
 * the input the model generated to call the tool and the result the tool
 * injected back into context.
 */
import type { RawToolEvent } from "./types.js";

type ToolKind = "builtin" | "mcp" | "skill";

export interface ToolClass {
	kind: ToolKind;
	/** The bucket a call rolls up into: an MCP server, the skills bucket, or
	 * the builtin bucket. */
	group: string;
	/** The specific tool or skill within the group. */
	label: string;
}

const BUILTIN_GROUP = "(builtin)";
const SKILL_GROUP = "(skills)";

/**
 * Classify a raw tool name into its kind, group, and label. MCP tools are
 * named `mcp__<server>__<tool>`; the `Skill` tool carries the skill name in
 * its input; everything else is a builtin.
 */
export function classifyTool(name: string, skill: string | null): ToolClass {
	if (name === "Skill") {
		return {
			kind: "skill",
			group: SKILL_GROUP,
			label: skill && skill.length > 0 ? skill : "(unknown)",
		};
	}
	if (name.startsWith("mcp__")) {
		const parts = name.split("__");
		// mcp__server__tool — server is parts[1], tool is the remainder so
		// tool names containing "__" survive intact.
		const server = parts[1] && parts[1].length > 0 ? parts[1] : "(unknown)";
		const tool = parts.slice(2).join("__");
		return {
			kind: "mcp",
			group: server,
			label: tool.length > 0 ? tool : "(unknown)",
		};
	}
	return { kind: "builtin", group: BUILTIN_GROUP, label: name };
}

export interface ToolCost extends ToolClass {
	calls: number;
	inputChars: number;
	resultChars: number;
}

/** Total footprint of a cost row — what the rollup sorts by. */
export function footprint(c: {
	inputChars: number;
	resultChars: number;
}): number {
	return c.inputChars + c.resultChars;
}

/**
 * Roll raw per-call events up by (kind, group, label), summing calls and
 * footprint, sorted by total footprint descending then label for stability.
 */
export function aggregateToolCosts(events: RawToolEvent[]): ToolCost[] {
	const byKey = new Map<string, ToolCost>();
	for (const event of events) {
		const cls = classifyTool(event.name, event.skill);
		const key = JSON.stringify([cls.kind, cls.group, cls.label]);
		const existing = byKey.get(key);
		if (existing) {
			existing.calls += 1;
			existing.inputChars += event.inputChars;
			existing.resultChars += event.resultChars;
		} else {
			byKey.set(key, {
				...cls,
				calls: 1,
				inputChars: event.inputChars,
				resultChars: event.resultChars,
			});
		}
	}
	return [...byKey.values()].sort(
		(a, b) => footprint(b) - footprint(a) || a.label.localeCompare(b.label),
	);
}
