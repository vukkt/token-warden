---
description: Measure pending token-warden candidate rules for an agent on the golden suite, evict or activate them, and recompile the agent's memory.
argument-hint: <frontend|backend|sql|testing> [--runs N] [--top-up N] [--uniform-top-up] [--retention-rounds N]
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

`--top-up N` (default 1) is how many ORDINARY measurement rounds a decision
whose verdict lands within noise of the bar may buy. Each round is one more
suite pass of the measured configuration, placed by variance. `0` disables the
top-up entirely.

`--uniform-top-up` replaces the Neyman variance-proportional top-up with one
full uniform suite pass (same budget) — the control arm when benchmarking the
allocation strategy itself.

`--retention-rounds N` (0-2, default 2) caps the EXTRA measurement rounds a
RE-AUDIT may buy before de-activating a rule with a banked margin. A re-audit
whose noise band is wide relative to what the rule has already been shown to
earn buys more evidence rather than deciding on the noisy draw; a decisive
measurement, a regression, and every candidate promotion are unaffected. `0`
restores the pre-v0.43.0 single-top-up behaviour and is the control arm.

When it finishes, report:

1. Each decision: rule id, ACTIVE/EVICTED, measured delta vs. context rent,
   the advisory dollar translation when shown, and any REGRESSION / topped-up /
   LOW-CONFIDENCE annotations.
2. The compiled memory path and new ruleset version.
3. If a previously active rule was evicted on re-audit, say so explicitly —
   that is mandatory eviction working, not a malfunction.
4. If the run prints `ABORTED: environment failure` (and exits non-zero),
   report that NO verdict was recorded — the measurement died environmentally
   (quota exhaustion / API outage), the rule is still queued as a candidate,
   and the fix is to re-run `/warden-select` on a fresh quota window. Never
   describe an abort as an eviction.

The "≈$/run" and "$/week" figures are advisory only — the keep/evict verdict
is decided on raw tokens, never dollars. Never edit rules or MEMORY.md by
hand; the ledger is the source of truth.
