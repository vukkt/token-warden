# Roadmap

The forward plan for token-warden, consolidated from the July 2026 audit
([docs/audit-2026-07.md](docs/audit-2026-07.md)), the validation findings
([FINDINGS.md](FINDINGS.md)), and the decision log ([DECISIONS.md](DECISIONS.md)).
Shipped history lives in [CHANGELOG.md](CHANGELOG.md); this file tracks only
what is ahead. Items are grouped by theme, and each carries the condition that
justifies doing it — nothing here ships without a measured proof, per the
project's core discipline (LLM proposes, deterministic verifier measures, only
measured survivors persist).

## 1. The central open question

The engine is validated end-to-end on real tokens (~9.3M spent; see
FINDINGS.md): collection, benchmarking, selection, eviction, and the safety
gate all behave as designed. What real-token validation has *not* yet shown is
that real-world workloads contain catchable, generalizable headroom — the
shipped agents are already optimized by design, so surviving rules have so far
come from deliberately naive positive controls.

- **Production dogfood window.** Run the full loop against day-to-day work for
  a sustained window, then compare the fixture verdict with the production
  cohort verdict for the same rule set (`/warden-cohort` already measures the
  production side observationally). Success metric: fixture survival predicts
  a real-work cost drop at the same ruleset version.

## 2. Measured experiments (token-spending, run when a budget exists)

From the falsification list in the audit; each is bounded and has a success
metric decided in advance.

- **Best-of-K distillation** (paper RQ1 analogue). Sample the distiller K=3
  times at temperature, dedupe near-identical proposals, bench the survivors.
  The distill call is cheap but every distinct candidate costs a full bench
  (~50–100k tokens), so K stays small. Success metric: surviving-rule
  tokens/run per bench token spent, K=3 vs K=1.
- **Rule-body compression A/B.** Rewrite a surviving rule to half its
  character count (rent is length/4) and re-bench. If the delta holds, rent
  drops and marginal rules clear the bar. Cheap and bounded.
- **Out-of-fixture confirmation.** The production half of the central open
  question above: after the next dogfood window, run `/warden-cohort` and
  compare its verdict to the fixture verdict for the same rules.

## 3. Engine improvements

- **Cut golden-suite variance further.** Real runs varied >25%, burying modest
  savings under noise. The noisiest tasks (`testing-02` at ~150k tokens/run,
  `sql-02`) deserve splitting or quieting — by *adding* task files, never
  editing frozen ones (invariant #4).
- **Distribution-weighted / production-sampled suites.**
  `/warden-sample-tasks` drafts candidate tasks from real transcripts; the
  open half is weighting the suite to the production task distribution so a
  rule protecting a rare, expensive case gets measured proportionally.
- **Per-category regression reporting.** The latency axis shipped in v0.31.0
  as advisory-only; regression reporting per task category (backend vs sql vs
  testing) is still open.
- **Full-suite uniform top-up.** A variance refinement deferred from the
  Neyman top-up work (DECISIONS.md): when no per-task variance signal exists,
  a uniform whole-suite top-up pass is the fallback — currently only the
  degenerate runs=1 case takes it.
- **Dollar-weighted rent on both sides.** Cache-aware rent shipped for the
  carry cost; the full weighting (cache read ≈ 0.1×, cache write ≈ 1.25×,
  output ≈ 5× input price) applied to *savings* as well would turn
  "tokens saved" into "dollars saved" end to end.
- **Fully scheduled selection.** Auto-running the selector on a routine once
  variance handling has earned trust; today it deliberately stays a user
  decision.
- **Better candidate quality.** Beyond the false-economy guard and the
  verdict-grounded eviction feedback (v0.32.0), further distiller prompt and
  model tuning so proposals clear 2× rent more often.

## 4. Collaboration

- **Ledger import auto-apply.** `/warden-share` exports and `/warden-adopt`
  re-measures, but a shared ledger is currently an export for review — a
  one-command "adopt and queue for measurement" flow is the missing half.
- **Rule marketplaces.** Measured rules are portable artifacts with provenance
  and deltas; a community repository of rules-with-receipts that others
  re-measure locally before adopting. The dedupe and verdict machinery already
  handle imports.

## 5. Statistical guardrails (trigger-gated — do not build early)

Each of these is deliberately *not* built until its trigger fires, because the
calibration harness showed the current defaults are sound.

| Guardrail | Trigger |
| --- | --- |
| Per-invocation Bonferroni z-adjustment | `MAX_CANDIDATES_PER_INVOCATION` grows past 3 |
| Bootstrap confidence intervals | run distributions turn multi-modal (the within-task normal approximation stops holding) |
| Robust-SE as a gate input (currently the report-only TAIL-RISK flag) | a tail-robust estimator that does not raise the false-positive rate from ~3% to ~7% — the calibration harness vetoed the last one |

## Non-goals

Recorded so they are not re-litigated: acting directly on the artifact instead
of measuring (the audited literature puts silent correctness failures at ~18%
for that arm), gating on advisory axes (latency, tail risk, completion drop),
and auto-evicting from any signal other than the frozen fixture.
