---
description: Benchmark a proposed edit to an agent's system prompt against the current one on its golden suite, and report which uses fewer tokens.
argument-hint: <frontend|backend|sql|testing> --variant <path-to-agent.md> [--runs N]
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the prompt A/B benchmark. The agent and flags are: $ARGUMENTS

This runs the agent's golden suite under two prompts — the shipped agent
definition (baseline) and the `--variant` file (candidate) — holding the
agent's active rules and model constant so only the prompt varies. The
variant is a full agent markdown file in the same format as
`agents/<name>.md`. It spends real benchmark tokens on both passes — run it
in the background and report progress:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/promptbench.ts --agent <agent> --variant <path> <extra flags as given>
```

When it finishes, relay:

1. The per-task table (processing tokens current → variant, the percent
   change, completion counts).
2. The verdict line verbatim — and if it reports a **regression** (the
   variant failed a task the current prompt passed), surface that
   prominently: the variant is not a safe change regardless of token count.
3. The note that the verdict uses processing tokens.
4. The meta-cost line.

A winning variant is not auto-applied; the user edits `agents/<name>.md`
themselves if they accept it. Never present this as a dollar-cost verdict.
