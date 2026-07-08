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
metric decided in advance. **The tooling for all three shipped in v0.34.0** —
what remains is running the experiments and recording their results:

- **Best-of-K distillation** (paper RQ1 analogue). Shipped: `--k 1-3` /
  `TOKEN_WARDEN_DISTILL_K` samples the distiller K times and pools the
  distinct proposals (cross-sample trigram dedupe, batch cap 3). Open: the
  measured comparison itself — success metric: surviving-rule tokens/run per
  bench token spent, K=3 vs K=1 (batches share a `source_run`, so survival
  by batch is queryable from receipts).
- **Rule-body compression A/B.** Shipped: `/warden-compress` rewrites a
  measured rule at half the characters and queues it as a candidate. Open:
  run it on the surviving rules and record whether deltas hold at the lower
  rent.
- **Out-of-fixture confirmation.** Shipped: `/warden-confirm` joins fixture
  receipts with the production cohort verdict per agent (corroborated /
  contradicted / unconfirmed), `--gate` for CI. Open: the dogfood window that
  gives it data (section 1).

## 3. Engine improvements

- **Cut golden-suite variance further.** Real runs varied >25%, burying modest
  savings under noise. Shipped in v0.34.0: `/warden-health` now ranks golden
  tasks by run-to-run variance so the noisiest are named with evidence. Open:
  actually splitting them (`testing-02` at ~150k tokens/run, `sql-02`) — by
  *adding* task files, never editing frozen ones (invariant #4).
- **Distribution-weighted / production-sampled suites.** Shipped in v0.37.0:
  a golden task carries `weight: N` and the verdict estimators weight the mean,
  SE, and top-up accordingly, with an effective-DoF confidence correction so
  the weighted false-positive rate stays at parity with the unweighted gate
  (calibration-proven). `/warden-sample-tasks` drafts candidate tasks from real
  transcripts. Open: automatically deriving the weights from the observed
  production task distribution (they are set by hand today).
- **Per-category regression reporting.** Shipped in v0.34.0:
  `/warden-modelbench --agent all` sweeps every domain suite and closes with
  a per-category (backend vs frontend vs sql vs testing) regression roll-up.
  (Prompt variants are inherently per-agent, so promptbench keeps its
  single-agent shape.)
- **Full-suite uniform top-up.** Shipped in v0.34.0 as
  `/warden-select --uniform-top-up` — the control arm for benchmarking the
  Neyman allocation. Open: the real benchmark run comparing the two arms
  (deferred from v0.24.0 because it changes token-spend behavior).
- **Dollar-weighted savings.** Shipped in v0.34.0 as advisory reporting:
  selector decisions and receipts carry `≈$/run` (the agent's real token mix
  priced at the measured model) plus a weekly projection. Deliberately NOT a
  gate input — a dollar-weighted keep/evict inequality needs its own
  calibration-harness proof first.
- **Fully scheduled selection.** Shipped in v0.34.0 as an explicit opt-in:
  `TOKEN_WARDEN_AUTO_SELECT=1` lets the SessionStart hook spawn the selector
  detached (busiest agent first, 24h cooldown). Stays off by default until
  variance handling earns enough trust to flip it.
- **Better candidate quality.** Beyond the false-economy guard, the
  verdict-grounded eviction feedback (v0.32.0), and best-of-K sampling
  (v0.34.0), further distiller prompt and model tuning so proposals clear
  2× rent more often.

## 4. Collaboration

- **Ledger import auto-apply.** Shipped in v0.34.0: `/warden-adopt` queues a
  shared ledger as candidates (it always re-measures locally), and
  `TOKEN_WARDEN_AUTO_SELECT=1` closes the loop by queueing the measurement at
  the next session start.
- **Rule marketplaces.** Measured rules are portable artifacts with provenance
  and deltas; a community repository of rules-with-receipts that others
  re-measure locally before adopting. The dedupe and verdict machinery already
  handle imports. An ecosystem effort, not a CLI feature — deliberately out of
  scope here.

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
