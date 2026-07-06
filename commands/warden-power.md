---
description: Zero-token power planner — from the agent's own recorded run-to-run variance, report the minimum detectable saving (MDS) at each run count and how many runs per side a target saving needs, so a benchmark burn is provably adequately powered before it starts.
argument-hint: "[--agent <frontend|backend|sql|testing>] [--target-saving N] [--rent N] [--runs N] [--json]"
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden power command:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/power.ts $ARGUMENTS
```

Per agent it reports, from the recorded golden-replicate variance:

- A table of runs-per-side (2, 3, 5, 8, 12) against the standard error and
  the minimum detectable saving at 80% and 90% power — the smallest true
  saving the 2x-rent + z-SE gate would actually promote at that budget.
- With `--target-saving N`: the required runs per side to detect that saving
  at 80% and 90% power. A target at or below the 2x-rent bar is flagged as
  undetectable at any run count — the gate itself rejects it.
- With `--runs N`: the MDS at exactly that n, plus (with a target) the
  achieved power percentage.
- `--rent N` overrides the default rent (median context cost of the agent's
  active rules, 25 when none are deployed).

The estimate is conservative: it assumes uniform run allocation, and the
selector's Neyman variance-proportional top-up only tightens the SE. Zero
tokens, read-only. Relay the command output to the user.
