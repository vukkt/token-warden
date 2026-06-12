---
description: Measure pending token-warden candidate rules for an agent on the golden suite, evict or activate them, and recompile the agent's memory.
argument-hint: <frontend|backend|sql|testing> [--runs N] [--top-up N]
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden selector. The agent and any extra flags are: $ARGUMENTS

This spends real benchmark tokens (a shared baseline suite, one suite per
candidate — max 3 per invocation — one re-audit, plus possible variance
top-ups), and takes several minutes per configuration. Run it in the
background and report progress:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/select.ts --agent <agent> <extra flags as given>
```

When it finishes, report:

1. Each decision: rule id, ACTIVE/EVICTED, measured delta vs. context rent,
   and any REGRESSION / topped-up / LOW-CONFIDENCE annotations.
2. The compiled memory path and new ruleset version.
3. If a previously active rule was evicted on re-audit, say so explicitly —
   that is mandatory eviction working, not a malfunction.

Never edit rules or MEMORY.md by hand; the ledger is the source of truth.
