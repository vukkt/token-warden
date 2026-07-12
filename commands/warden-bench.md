---
description: Run the golden benchmark suite for one token-warden agent (or all) and compare results against the frozen run1 and best baselines.
argument-hint: <frontend|backend|sql|testing|all> [--runs N] [--task id]
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the golden-suite benchmark. The agent (or `all`) and any extra flags are:
$ARGUMENTS

If no agent was given, use `all`. Build and run this command (it spawns
headless Claude sessions per golden task, so it can take several minutes per
agent — run it in the background and report progress):

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/bench.ts --agent <agent-or-all> <extra flags as given>
```

When it finishes, report:

1. Per task: the mean completed tokens, the comparison against the frozen
   `run1` baseline (the printed percentage) and the `best` figure.
2. The meta-cost line at the end — and if the overhead warning is present,
   surface it prominently: it means benchmarking spent more than 10% of the
   week's collected real-work tokens, and the user should bench less often.
3. Any per-task `runs differ by >25%` variance warnings.
4. If the run prints `ENVIRONMENT FAILURE` and aborts, report that the
   benchmark died environmentally (4 consecutive zero-token failed runs —
   quota exhaustion / API outage) and should be re-run on a fresh quota
   window; results recorded before the abort are valid.

Never edit `run1` values or the database by hand; baselines are frozen by
design.
