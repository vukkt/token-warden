---
description: Propose a token-cheaper rewrite of an agent's system prompt, measure it on the golden suite, and recommend it only if it provably wins (never auto-applied).
argument-hint: <frontend|backend|sql|testing> [--runs N]
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run automated prompt evolution. The agent and flags are: $ARGUMENTS

This asks a small model to propose a tighter variant of the agent's system
prompt (frontmatter preserved), then benchmarks the variant against the
shipped prompt on the agent's golden suite. It spends a model call plus real
benchmark tokens — run it in the background and report progress:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/evolve.ts --agent <agent> <extra flags as given>
```

When it finishes, relay:

1. Whether a valid variant was proposed at all (it is rejected before
   measurement if it changes protected frontmatter or fails to parse).
2. The per-task comparison table and the verdict.
3. The outcome: either "✓ measurably cheaper — written to <path>, review and
   apply by hand" or "✗ not a measurable improvement — discarded." A winning
   variant is **never auto-applied**; the user reviews the proposals file and
   edits `agents/<name>.md` themselves if they accept it.
4. The meta-cost line.

Make clear this is a recommendation gated by a token benchmark, not a proven
behavioral improvement — three golden tasks cannot fully capture an agent.
