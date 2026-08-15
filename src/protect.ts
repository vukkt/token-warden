/**
 * Rule typing: human-authored / protected rules.
 *
 * CLI: npx tsx src/protect.ts --agent <name> --add "<rule body>"
 *      npx tsx src/protect.ts --agent <name> --protect <id> | --unprotect <id>
 *      npx tsx src/protect.ts --agent <name> --list
 *
 * token-warden's 2× token gate is the right test for an *efficiency* rule. It is
 * the wrong test for a *behavioral* rule — one written to fix an edge case,
 * enforce a constraint, or stop a failure mode — whose value is not measured in
 * tokens. Protected rules are compiled into memory and counted for rent like any
 * other, but are exempt from token-based eviction: only a human removes them.
 * This is the boundary that keeps the selector from ever deleting a constraint a
 * developer authored on purpose.
 *
 * SAFETY INVARIANT — the exemption is enforced in SQL, not in report code: the
 * selector picks its re-audit target with `oldestDecidedActiveRule`, whose
 * WHERE clause carries `protected = 0`. A protected rule is therefore never
 * even measured, so no verdict can ever evict it. This module only sets the
 * flag; it never decides a rule's fate.
 *
 * SECURITY — listed rule bodies are model-generated, so they are rendered
 * through `displayText` and cannot forge a listing row or an ANSI sequence.
 */
import { numericFlag, runCli } from "./cli.js";
import {
	getRuleById,
	insertAuthoredRule,
	listRulesByAgent,
	setRuleProtected,
	type WardenDb,
	withDb,
} from "./db.js";
import { compileActiveMemory } from "./memory.js";
import { assertKnownAgent } from "./registry.js";
import { contextCost, ruleBodySchema } from "./rules.js";
import { displayText } from "./sanitize.js";

interface ProtectArgs {
	agent: string;
	add: string | null;
	protect: number | null;
	unprotect: number | null;
	list: boolean;
}

export function parseProtectArgs(argv: string[]): ProtectArgs {
	const args: ProtectArgs = {
		agent: "",
		add: null,
		protect: null,
		unprotect: null,
		list: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") args.agent = argv[++i] ?? "";
		else if (flag === "--add") args.add = argv[++i] ?? null;
		else if (flag === "--protect") args.protect = numericFlag(argv[++i]);
		else if (flag === "--unprotect") args.unprotect = numericFlag(argv[++i]);
		else if (flag === "--list") args.list = true;
		else throw new Error(`unknown flag: ${flag}`);
	}
	assertKnownAgent(args.agent);
	const actions = [
		args.add !== null,
		args.protect !== null,
		args.unprotect !== null,
		args.list,
	].filter(Boolean).length;
	if (actions !== 1) {
		throw new Error("exactly one of --add, --protect, --unprotect, --list");
	}
	if (
		(args.protect !== null && !Number.isInteger(args.protect)) ||
		(args.unprotect !== null && !Number.isInteger(args.unprotect))
	) {
		throw new Error("--protect/--unprotect take an integer rule id");
	}
	if (args.add !== null) {
		if (args.add.trim().length === 0) {
			throw new Error("--add needs a non-empty rule body");
		}
		// --add is the one path that writes rules.body without a benchmark
		// behind it: insertAuthoredRule stores it already-active and protected,
		// so it is never re-audited and never evicted, and compileMemoryMd
		// renders it as "- ${body}" with no escaping of its own. An unvalidated
		// body could therefore emit extra bullets into the agent's MEMORY.md
		// permanently. Hold it to exactly the contract every other writer
		// (distill, compress, adopt) enforces: one printable, length-bounded
		// line. Shared, not copied, so the definition can never drift.
		const parsed = ruleBodySchema.safeParse(args.add);
		if (!parsed.success) {
			throw new Error(
				`--add rule body is invalid: ${parsed.error.issues[0]?.message ?? "does not meet the rule body contract"}`,
			);
		}
		args.add = parsed.data;
	}
	return args;
}

export function runProtect(db: WardenDb, args: ProtectArgs): string {
	if (args.list) {
		const rules = listRulesByAgent(db, args.agent);
		if (rules.length === 0) return `No rules for agent ${args.agent}.`;
		const lines = rules.map((r) => {
			const tag = r.protected ? "[PROTECTED]" : `[${r.status}]`;
			return `  ${r.id} ${tag} (rent ${r.context_cost}): "${displayText(r.body)}"`;
		});
		return [`Rules for ${args.agent}:`, ...lines].join("\n");
	}

	if (args.add !== null) {
		const body = args.add.trim();
		const id = insertAuthoredRule(db, {
			agent: args.agent,
			body,
			contextCost: contextCost(body),
			sourceRun: null,
			createdAt: new Date().toISOString(),
		});
		const version = compileActiveMemory(db, args.agent);
		return `Added protected rule ${id} for ${args.agent} (ruleset v${version}). It is compiled into memory and exempt from token eviction.`;
	}

	const id = (args.protect ?? args.unprotect) as number;
	const isProtect = args.protect !== null;
	const rule = getRuleById(db, id);
	if (!rule || rule.agent !== args.agent) {
		throw new Error(`no rule ${id} for agent ${args.agent}`);
	}
	setRuleProtected(db, id, isProtect);
	const version = compileActiveMemory(db, args.agent);
	return isProtect
		? `Rule ${id} is now PROTECTED and active (ruleset v${version}) — exempt from token eviction.`
		: `Rule ${id} is no longer protected (ruleset v${version}) — back in the token-gated pool.`;
}

export function main(argv: string[]): number {
	const args = parseProtectArgs(argv);
	return withDb((db) => {
		console.log(runProtect(db, args));
		return 0;
	});
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
runCli(import.meta.url, () => {
	return main(process.argv.slice(2));
});
/* v8 ignore stop */
