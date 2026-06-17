# Validation findings — real-token burn (2026-06)

token-warden's thesis is one falsifiable claim: *a rule that passes the
benchmark makes the agent measurably cheaper, and the system can learn such
rules from real work.* We tested it by burning real `claude` tokens through the
harness in [`validation/`](validation/) — controlled golden-suite validation
plus real-work distillation on a scratch project — across several quota windows
(~124 runs, ~9.3M tokens).

## What we ran

- **Controlled validation** (`validation/run.sh` / `burn-all.sh` Track 1): freeze
  `run1` baselines → introduce a candidate → `select` measures it *with vs.
  without* → re-measure. For `sql` and (partially) `testing`.
- **Real-work distillation** (Track 2): drive real `sql`-agent sessions on a
  scratch project, let the system **distill its own rules** from them, then
  `select`. Isolated DBs throughout; real agent memory snapshotted and restored.

## Results

| Test | Candidate(s) | Verdict |
|---|---|---|
| `sql` controlled | curated "Grep before reading" rule | **EVICTED** (−5,225 tok) |
| `sql` real-work | **3 rules the system distilled itself** | **all 3 EVICTED** |
| — | across every run | **0 rules ever compiled** |

### The headline: the safety gate works (rule 3)

The distiller, from real work, proposed:

> *"When a tool fails, pivot strategy once rather than retrying variations."*

Measured, this rule **saved ~38k tokens/run but made the agent give up and fail
every golden task** (a regression). token-warden **evicted it despite the
savings.** That is exactly the "false economy" a measured system must catch —
and most agent-memory schemes would have kept a 38k-token-saving rule and
quietly broken the agent. This one didn't.

## Conclusion

Three of the four halves of the thesis are **validated on real tokens**:

- ✅ **Measurement works** — every rule measured; non-earners evicted.
- ✅ **Safety works** — false-economy and regression rules evicted regardless of
  apparent savings (rule 3).
- ✅ **Learning pipeline works** — the distiller produces plausible rules from
  real sessions.
- ❌ **Payoff not yet demonstrated** — *no rule survived*, so no proven
  session-cost reduction.

**The bottleneck is not the measurement system.** It is:

1. **Benchmark variance.** Golden-suite runs repeatedly varied **>25%**
   (`sql-02`, `testing-02` worst). The variance-conservative selector then
   evicts rules whose savings sit inside that noise — so a genuinely modest
   (+5–10%) rule cannot be confidently kept.
2. **Candidate quality.** The haiku distiller's proposals were either
   within-noise or unsafe (rule 3).

## Fixes implemented in response (v0.18.0)

- **Default run count 2 → 3** (`bench`, `select`) — tighter standard error so a
  real small saving is distinguishable from noise.
- **Distiller false-economy guard** — `buildPrompt` now explicitly forbids rules
  that skip steps, give up/retry less, cut verification, or trade thoroughness
  for tokens (the rule-3 class).

## Still open

- Reduce variance further: split/quiet the noisiest golden tasks (add task
  files, never edit — baselines are frozen), and/or raise runs further where the
  token budget allows.
- Reproduce the burn after these changes and look for the first **surviving**
  rule — the missing demonstration that a kept rule lowers real-work cost.
- A stronger distill model or tighter rule constraints if candidate quality
  remains the limiter.

Re-run any time: `./validation/run.sh sql` (controlled) or
`./validation/burn-all.sh` (full); `npx tsx validation/dress-rehearsal.ts` shows
the pipeline end-to-end with zero tokens.
