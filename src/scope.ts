/**
 * Per-rule scope — an "allowed where" predicate.
 *
 * CLI: npx tsx src/scope.ts --agent <name> --rule <id> --scope "<predicate>"
 *      npx tsx src/scope.ts --agent <name> --rule <id> --clear
 *      npx tsx src/scope.ts --agent <name> --list
 *
 * A rule is global by default. Giving it a scope ("Python files", "the api/
 * service", "migration tasks") compiles it into memory as
 * "(when <scope>) <rule>", so the agent applies it only in that context instead
 * of globally. Scope is advisory — the agent self-applies it from the annotated
 * memory; it does not change the keep/evict measurement.
 */
import { pathToFileURL } from "node:url";
import {
	getRuleById,
	listRulesByAgent,
	openDb,
	setRuleScope,
	type WardenDb,
} from "./db.js";
import { assertKnownAgent } from "./registry.js";
import { compileActiveMemory } from "./select.js";

interface ScopeArgs {
	agent: string;
	rule: number | null;
	scope: string | null;
	clear: boolean;
	list: boolean;
}

export function parseScopeArgs(argv: string[]): ScopeArgs {
	const args: ScopeArgs = {
		agent: "",
		rule: null,
		scope: null,
		clear: false,
		list: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") args.agent = argv[++i] ?? "";
		else if (flag === "--rule") args.rule = Number(argv[++i]);
		else if (flag === "--scope") args.scope = argv[++i] ?? null;
		else if (flag === "--clear") args.clear = true;
		else if (flag === "--list") args.list = true;
		else throw new Error(`unknown flag: ${flag}`);
	}
	assertKnownAgent(args.agent);
	if (args.list) return args;
	if (args.rule === null || !Number.isInteger(args.rule)) {
		throw new Error("--rule <id> is required (or use --list)");
	}
	if (!args.clear && (args.scope === null || args.scope.trim().length === 0)) {
		throw new Error('--scope "<predicate>" or --clear is required');
	}
	return args;
}

export function runScope(db: WardenDb, args: ScopeArgs): string {
	if (args.list) {
		const rules = listRulesByAgent(db, args.agent);
		if (rules.length === 0) return `No rules for agent ${args.agent}.`;
		const lines = rules.map((r) => {
			const where = r.scope ? `(when ${r.scope})` : "(global)";
			return `  ${r.id} [${r.status}] ${where}: "${r.body}"`;
		});
		return [`Rules for ${args.agent}:`, ...lines].join("\n");
	}

	const id = args.rule as number;
	const rule = getRuleById(db, id);
	if (!rule || rule.agent !== args.agent) {
		throw new Error(`no rule ${id} for agent ${args.agent}`);
	}
	const next = args.clear ? null : (args.scope as string).trim();
	setRuleScope(db, id, next);
	const version = compileActiveMemory(db, args.agent);
	return next === null
		? `Rule ${id} is now global (ruleset v${version}).`
		: `Rule ${id} now applies only when: ${next} (ruleset v${version}).`;
}

export function main(argv: string[]): number {
	const args = parseScopeArgs(argv);
	const db = openDb();
	try {
		console.log(runScope(db, args));
		return 0;
	} finally {
		db.close();
	}
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
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
/* v8 ignore stop */
