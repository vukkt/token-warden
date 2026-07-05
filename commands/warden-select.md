---
description: Measure pending token-warden candidate rules for an agent on the golden suite, evict or activate them, and recompile the agent's memory.
argument-hint: <frontend|backend|sql|testing> [--runs N] [--top-up N] [--uniform-top-up]
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

`--uniform-top-up` replaces the Neyman variance-proportional top-up with one
full uniform suite pass (same budget) — the control arm when benchmarking the
allocation strategy itself.

When it finishes, report:

1. Each decision: rule id, ACTIVE/EVICTED, measured delta vs. context rent,
   the advisory dollar translation when shown, and any REGRESSION / topped-up /
   LOW-CONFIDENCE annotations.
2. The compiled memory path and new ruleset version.
3. If a previously active rule was evicted on re-audit, say so explicitly —
   that is mandatory eviction working, not a malfunction.

The "≈$/run" and "$/week" figures are advisory only — the keep/evict verdict
is decided on raw tokens, never dollars. Never edit rules or MEMORY.md by
hand; the ledger is the source of truth.
