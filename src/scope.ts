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
 *
 * SECURITY — two separate boundaries, because the scope has two consumers.
 * On the way IN, `parseScopeArgs` holds a predicate to the same one-printable-
 * line contract a rule body must meet: it is compiled into MEMORY.md as the
 * "(when <scope>)" prefix of its bullet, and `compileMemoryMd` does no escaping
 * of its own, so a newline here would emit extra bullets into the agent's
 * memory. Validated-then-stored-verbatim is deliberate: the compiler needs the
 * exact value. On the way OUT, everything rendered to the terminal — bodies
 * (model-generated) and predicates alike — goes through `displayText`, so a
 * pre-existing row can never forge a listing line either.
 */
import { numericFlag, runCli } from "./cli.js";
import {
	getRuleById,
	listRulesByAgent,
	setRuleScope,
	type WardenDb,
	withDb,
} from "./db.js";
import { compileActiveMemory } from "./memory.js";
import { assertKnownAgent } from "./registry.js";
import { hasForbiddenChar, MAX_RULE_BODY_CHARS } from "./rules.js";
import { displayText } from "./sanitize.js";

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
		else if (flag === "--rule") args.rule = numericFlag(argv[++i]);
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
	if (!args.clear && args.scope !== null) {
		// A scope is compiled into MEMORY.md as the "(when <scope>)" prefix of
		// its rule's bullet, and compileMemoryMd does no escaping of its own —
		// so a predicate carrying a newline would emit extra bullets exactly as
		// an unvalidated rule body would. Same contract, minus the 10-character
		// floor: a legitimate predicate can be as short as "Python".
		const scope = args.scope.trim();
		if (scope.length > MAX_RULE_BODY_CHARS) {
			throw new Error(
				`--scope must be at most ${MAX_RULE_BODY_CHARS} characters`,
			);
		}
		if (hasForbiddenChar(scope)) {
			throw new Error(
				"--scope must be a single printable line (no control, zero-width, bidi, or astral characters)",
			);
		}
		args.scope = scope;
	}
	return args;
}

export function runScope(db: WardenDb, args: ScopeArgs): string {
	if (args.list) {
		const rules = listRulesByAgent(db, args.agent);
		if (rules.length === 0) return `No rules for agent ${args.agent}.`;
		const lines = rules.map((r) => {
			const where = r.scope ? `(when ${displayText(r.scope, 60)})` : "(global)";
			return `  ${r.id} [${r.status}] ${where}: "${displayText(r.body)}"`;
		});
		return [`Rules for ${args.agent}:`, ...lines].join("\n");
	}

	const id = args.rule as number;
	const rule = getRuleById(db, id);
	if (!rule || rule.agent !== args.agent) {
		throw new Error(`no rule ${id} for agent ${args.agent}`);
	}
	const next = args.clear ? null : (args.scope as string).trim();
	// Stored verbatim (the memory compiler consumes the raw value); sanitized
	// only on the way back out to the terminal.
	setRuleScope(db, id, next);
	const version = compileActiveMemory(db, args.agent);
	return next === null
		? `Rule ${id} is now global (ruleset v${version}).`
		: `Rule ${id} now applies only when: ${displayText(next, 60)} (ruleset v${version}).`;
}

export function main(argv: string[]): number {
	const args = parseScopeArgs(argv);
	return withDb((db) => {
		console.log(runScope(db, args));
		return 0;
	});
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	return main(process.argv.slice(2));
});
/* v8 ignore stop */
