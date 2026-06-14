---
description: Benchmark a candidate model against an agent's current model on its golden suite, and report which uses fewer tokens for that workload.
argument-hint: <frontend|backend|sql|testing> --model <id> [--baseline <id>] [--runs N]
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the model-migration benchmark. The agent and flags are: $ARGUMENTS

This runs the agent's golden suite under two models (the candidate `--model`
and the baseline, which defaults to the agent's current model), holding the
agent's active rules constant so only the model varies. It spends real
benchmark tokens on both passes — run it in the background and report
progress:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/modelbench.ts --agent <agent> --model <candidate> <extra flags as given>
```

When it finishes, relay:

1. The per-task table (processing tokens baseline → candidate, the percent
   change, and each side's completion count).
2. The verdict line verbatim — and if it reports a **regression** (the
   candidate failed a task the baseline passed), surface that prominently:
   it means the candidate is not a safe switch regardless of token count.
3. Both caveats: the verdict uses processing tokens (cache-read is shown
   separately because it skews raw cross-model totals), and token count is
   not dollar cost — models are priced differently per token, so the user
   must apply their own per-token rates.
4. The meta-cost line.

Never present this as a dollar-cost verdict; it is a token-count comparison
on a fixed workload.
