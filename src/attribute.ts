/**
 * Tool / skill / MCP cost attribution — roadmap direction #5.
 *
 * CLI:
 *   npx tsx src/attribute.ts                    cross-session rollup (DB)
 *   npx tsx src/attribute.ts --agent backend    filter by agent
 *   npx tsx src/attribute.ts --kind mcp          only MCP servers
 *   npx tsx src/attribute.ts --transcript PATH   break down one transcript
 *   npx tsx src/attribute.ts --json              machine-readable
 *
 * This is decomposition, not a verdict: it answers "where did the tokens go?"
 * by attributing each session's footprint to the tool, skill, or MCP server
 * that produced it. It never promotes, evicts, or measures a rule, so it is
 * fully orthogonal to the selector/benchmark path. Single-transcript analysis
 * is pure and offline; the cross-session view is a read-only DB query.
 *
 * Footprint is measured in characters — exact and deterministic — split into
 * the input the model generated to call the tool and the result the tool
 * injected back into context. A rough ≈tokens figure (chars / 4) is shown for
 * intuition; it is an estimate, not the billed token count.
 *
 * The human renderers route every model/environment-controlled string through
 * `displayText` (ANSI/control-char stripping). `--json` is the raw,
 * machine-readable path and is intentionally NOT sanitized — pretty-print it
 * only in a context that neutralizes control characters.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	openDb,
	type ToolCostRollup,
	toolCostRollup,
	type WardenDb,
} from "./db.js";
import { displayText } from "./sanitize.js";
import { parseTranscript } from "./transcript.js";
import type { RawToolEvent } from "./types.js";

export type ToolKind = "builtin" | "mcp" | "skill";

export interface ToolClass {
	kind: ToolKind;
	/** The bucket a call rolls up into: an MCP server, the skills bucket, or
	 * the builtin bucket. */
	group: string;
	/** The specific tool or skill within the group. */
	label: string;
}

export const BUILTIN_GROUP = "(builtin)";
export const SKILL_GROUP = "(skills)";
/** Rough chars-per-token used only for the human-friendly ≈tokens estimate. */
export const CHARS_PER_TOKEN = 4;

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

/** ≈tokens from a char count (estimate; see file header). */
export function estTokens(chars: number): number {
	return Math.round(chars / CHARS_PER_TOKEN);
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

export interface AttributionReport {
	totalCalls: number;
	totalChars: number;
	costs: ToolCost[];
	byKind: Record<ToolKind, { calls: number; chars: number }>;
}

/** Attribute a single transcript's tool footprint. Pure and offline. */
export function attributeTranscript(jsonlText: string): AttributionReport {
	const costs = aggregateToolCosts(parseTranscript(jsonlText).toolEvents);
	const byKind: Record<ToolKind, { calls: number; chars: number }> = {
		builtin: { calls: 0, chars: 0 },
		mcp: { calls: 0, chars: 0 },
		skill: { calls: 0, chars: 0 },
	};
	let totalCalls = 0;
	let totalChars = 0;
	for (const cost of costs) {
		const chars = footprint(cost);
		byKind[cost.kind].calls += cost.calls;
		byKind[cost.kind].chars += chars;
		totalCalls += cost.calls;
		totalChars += chars;
	}
	return { totalCalls, totalChars, costs, byKind };
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function pct(part: number, whole: number): string {
	return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(0)}%`;
}

/** Render a single-transcript breakdown as a human-readable table. */
export function renderTranscriptAttribution(report: AttributionReport): string {
	const lines: string[] = [];
	lines.push("token-warden — tool cost attribution (this transcript)");
	lines.push("");
	if (report.costs.length === 0) {
		lines.push("No tool calls found in this transcript.");
		return lines.join("\n");
	}
	lines.push(
		`${report.totalCalls} call(s), ≈${fmt(estTokens(report.totalChars))} tokens of tool footprint (${fmt(report.totalChars)} chars)`,
	);
	for (const kind of ["builtin", "mcp", "skill"] as const) {
		const k = report.byKind[kind];
		if (k.calls === 0) continue;
		lines.push(
			`  ${kind.padEnd(8)} ${String(k.calls).padStart(4)} call(s)  ≈${fmt(estTokens(k.chars)).padStart(8)} tok  (${pct(k.chars, report.totalChars)})`,
		);
	}
	lines.push("");
	lines.push("by tool / skill / MCP (heaviest first):");
	lines.push(
		"  group              | tool/skill           | calls | ≈tokens | in/result chars",
	);
	for (const cost of report.costs) {
		lines.push(
			`  ${displayText(cost.group, 18).padEnd(18)} | ${displayText(cost.label, 20).padEnd(20)} | ${String(cost.calls).padStart(5)} | ${String(estTokens(footprint(cost))).padStart(7)} | ${fmt(cost.inputChars)}/${fmt(cost.resultChars)}`,
		);
	}
	return lines.join("\n");
}

/** Render the cross-session rollup from persisted `tool_costs`. */
export function renderRollup(rows: ToolCostRollup[], scope: string): string {
	const lines: string[] = [];
	lines.push(`token-warden — tool cost attribution (real-work, ${scope})`);
	lines.push("");
	if (rows.length === 0) {
		lines.push("No tool costs recorded yet.");
		return lines.join("\n");
	}
	lines.push(
		"  kind    | group              | tool/skill           | sessions | calls | ≈tokens",
	);
	for (const row of rows) {
		lines.push(
			`  ${row.kind.padEnd(7)} | ${displayText(row.grp, 18).padEnd(18)} | ${displayText(row.label, 20).padEnd(20)} | ${String(row.sessions).padStart(8)} | ${String(row.calls).padStart(5)} | ${String(estTokens(row.inputChars + row.resultChars)).padStart(7)}`,
		);
	}
	return lines.join("\n");
}

export interface AttributeArgs {
	transcript: string | null;
	agent: string | null;
	kind: ToolKind | null;
	json: boolean;
	limit: number;
}

const KINDS: readonly ToolKind[] = ["builtin", "mcp", "skill"];

/** Parse argv into options. Unknown flags throw, like the other CLIs. */
export function parseAttributeArgs(argv: string[]): AttributeArgs {
	const args: AttributeArgs = {
		transcript: null,
		agent: null,
		kind: null,
		json: false,
		limit: 30,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		switch (flag) {
			case "--transcript":
				args.transcript = argv[++i] ?? null;
				break;
			case "--agent":
				args.agent = argv[++i] ?? null;
				break;
			case "--kind": {
				const value = argv[++i];
				if (!value || !(KINDS as readonly string[]).includes(value)) {
					throw new Error(`--kind must be one of ${KINDS.join(", ")}`);
				}
				args.kind = value as ToolKind;
				break;
			}
			case "--limit": {
				const value = Number(argv[++i]);
				if (!Number.isInteger(value) || value <= 0) {
					throw new Error("--limit must be a positive integer");
				}
				args.limit = value;
				break;
			}
			case "--json":
				args.json = true;
				break;
			default:
				throw new Error(`unknown flag: ${flag}`);
		}
	}
	return args;
}

function runTranscript(args: AttributeArgs, path: string): number {
	const report = attributeTranscript(readFileSync(path, "utf8"));
	console.log(
		args.json
			? JSON.stringify(report, null, 2)
			: renderTranscriptAttribution(report),
	);
	return 0;
}

function runRollup(db: WardenDb, args: AttributeArgs): number {
	const rows = toolCostRollup(db, {
		agent: args.agent,
		kind: args.kind,
		limit: args.limit,
	});
	if (args.json) {
		console.log(JSON.stringify(rows, null, 2));
		return 0;
	}
	const scope = [
		args.agent ? `agent=${args.agent}` : "all agents",
		args.kind ?? "all kinds",
	].join(", ");
	console.log(renderRollup(rows, scope));
	return 0;
}

function main(argv: string[]): number {
	const args = parseAttributeArgs(argv);
	if (args.transcript !== null) return runTranscript(args, args.transcript);
	const db = openDb();
	try {
		return runRollup(db, args);
	} finally {
		db.close();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
