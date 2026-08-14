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

The engine is validated end-to-end on real tokens (~9.3M in the 2026-06 burn,
roughly 28M cumulative across every recorded burn since; see
FINDINGS.md): collection, benchmarking, selection, eviction, and the safety
gate all behave as designed. What real-token validation has *not* yet shown is
that real-world workloads contain catchable, generalizable headroom — the
shipped agents are already optimized by design, so the large surviving effects
have so far come from deliberately naive positive controls. Two rules did clear
the bar on the shipped `sql` agent (+622 and +5,731 tok/run), but both were
distilled from golden-suite runs; no rule distilled from day-to-day work has yet
survived the gate.

- **Production dogfood window.** Run the full loop against day-to-day work for
  a sustained window, then compare the fixture verdict with the production
  cohort verdict for the same rule set (`/warden-cohort` already measures the
  production side observationally). Success metric: fixture survival predicts
  a real-work cost drop at the same ruleset version.

  **The window has never started, and that is now visible.** The ledger's nine
  real-work sessions are all `main` (8) or `Explore` (1), from 2026-06-11/12.
  Distillation is gated on `knownAgents()` membership in `collect.ts`, so every
  one of them is INERT: recorded, billed, attributed — and unable to produce a
  candidate, whatever it costs. Verified by executing the real Stop hook over
  two transcripts differing only in `agentName`, with a fake `npx` capturing the
  spawn: `sql` spawned the distiller, `main` did not, while `shouldDistill`
  returns true for `main` on the same rows (the p75 trigger was never the
  blocker). Collection has additionally recorded nothing for 61 days.
  `/warden-dogfood` (new) reports collection liveness, per-agent real-work
  counts, which agents are inert, how many sessions remain before the p75
  trigger arms, and one next action. Admitting `main` to distillation was
  considered and REJECTED — no golden suite to measure a `main` rule and no
  agent-memory file to install it into, so the only place it could land is the
  user's `CLAUDE.md`, which this project never writes (see DECISIONS.md). The
  supported route for a real workload is BYOA: register it as an agent with a
  golden suite (`/warden-sample-tasks` drafts the tasks).

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
- **Rule-body compression A/B — CLOSED as unconfirmable (2026-07-10).** Shipped:
  `/warden-compress` rewrites a measured rule at half the characters and queues
  it as a swap candidate. The experiment itself is closed, not open: three real
  burns (~16M tokens plus ~1.6M characterization) were each killed by quota
  exhaustion, and the effect sits below the `sql` suite's derailment-noise floor
  at any run count the available quota windows can hold (see FINDINGS.md).
  Re-open only after per-run suite cost and tail variance come down, or on an
  environment with larger windows. **Do not re-run it as-is** — that is a fourth
  ~16M-token burn with the same expected outcome.
- **Out-of-fixture confirmation.** Shipped: `/warden-confirm` joins fixture
  receipts with the production cohort verdict per agent (corroborated /
  contradicted / unconfirmed), `--gate` for CI. Open: the dogfood window that
  gives it data (section 1).

## 3. Engine improvements

- **Extract the shared modules — SHIPPED.** `src/rules.ts` (rule vocabulary),
  `src/model-call.ts` (the `claude -p` envelope), `src/stats.ts` (estimators and
  gate parameters), `src/format.ts` (one name per formatting contract),
  `src/memory.ts` (the single writer of agent memory) and `src/cli.ts` (the
  entry boundary). Measured effect: `select.ts` in-degree 4 -> 1 and 1875 ->
  1684 lines, `distill.ts` in-degree 7 -> 1, CLI shims 25 -> 6. Both hubs were
  accidents — four modules wanted pure text helpers from the distiller, three
  wanted one formatter or three estimators from the selector.
  `withDb` (open + `finally db.close()`) SHIPPED in v0.43.0, after being written
  and withheld once because it rewrites the BODY of every call site rather than
  a uniform trailer. It lives in `db.ts` beside `openDb`, so no call site gained
  an import to adopt it; 21 hand-written lifetimes became one. `collect` keeps
  its own `openHookDb` (a shortened `busy_timeout` so a contended write is
  retriable inside the hook's budget), and the four fail-open hooks keep their
  own boundary: "exit 0 whatever happens" is different knowledge from "report
  and exit 1". Three read-only import allowlists (`contradict`, `cohort`,
  `confirm`) name the helper explicitly and were updated deliberately —
  `withDb` is the same capability as `openDb`, which is why those tests exist.
- **Cut golden-suite variance further.** Real runs varied >25%, burying modest
  savings under noise. Shipped in v0.34.0: `/warden-health` now ranks golden
  tasks by run-to-run variance so the noisiest are named with evidence. Also
  shipped in v0.36.0: the splits themselves — `sql-06`/`sql-07` and
  `testing-05`/`testing-06`, added as new files with the frozen originals
  untouched. Open: cutting per-run cost and tail variance further, which
  FINDINGS.md now names as the binding constraint on every future burn — nothing
  below the derailment-noise floor is measurable until it moves.
- **False evictions: a good rule binned by an unlucky sample.** The gate's
  false-POSITIVE rate is measured (8.8% empirically, FINDINGS.md); its
  false-NEGATIVE rate is not. A rule that genuinely earns can draw one bad
  sample and be evicted, and at the run counts this suite can afford that is not
  a hypothetical: rule 1 was admitted at +3,673 tok/run and evicted by a single
  -9,215 re-audit draw, and rule 5 measured +10,851 — 362x its bar — and was
  evicted as uncertain at SE 7,814.
  Partly mitigated already. Two-strike retention exists precisely for this (one
  sub-threshold draw is probation, only a second consecutive one evicts; a
  regression still evicts immediately), evicted rules keep their receipt as the
  negative dataset, and `/warden-power` reports the minimum detectable saving at
  a given run count *before* tokens are spent.
  **The gap is recovery.** Nothing retries an evicted rule, and the trigram
  dedupe that stops a falsified rule being re-proposed does not distinguish
  "measured negative" from "measured positive but too noisy to bank" — so a
  good-but-unlucky rule is effectively excluded for life.
  **The variance-proportional re-audit budget SHIPPED in v0.43.0** — spend more
  evidence re-auditing a rule with a banked margin instead of treating every
  audit as equal cost. Measured on the `sql` pool at 2 runs/side: a rule truly
  saving 10% of a run is evicted 5.4% of the time instead of 16.3%, 5% -> 32.5%
  from 53.8%, at ~1.5 extra suite passes per re-audit. Two design guesses were
  measured and discarded first, and the shape that worked is NOT the one this
  entry proposed: extra runs on the measured side alone are worth nothing (the
  delta's error sums both sides, so the frozen side sets a floor no one-sided
  budget can cross), and Neyman placement — the house style — is actively worse
  than spreading the same runs uniformly at 2 runs/task, where the variance
  estimate carries one degree of freedom. See FINDINGS.md; the lesson is that
  the admission side's tuning does not transfer to the retention side.
  Still open: the trigram dedupe still cannot tell a measured negative from a
  measured positive that was too noisy to bank, so nothing re-queues a
  good-but-unlucky rule. The expensive version — re-queuing evicted-as-uncertain
  rules when the suite's noise floor drops — still waits on the variance work
  above, since re-running them into the same noise would only reproduce the same
  verdict. **The false-negative rate is now measured** (v0.42.0). The prerequisite this
  entry set for itself is met: `validation/empirical-calibration.ts --mode
  eviction` replays a rule of known true saving through the REAL
  `assessDelta` -> `verdictWithReason` -> `twoStrikeRetention` path for N
  consecutive re-audits, resampling the agent's own recorded runs. On the `sql`
  pool at 2 runs/side over 12 re-audits, a rule truly saving 2% of a run is
  evicted **78.2%** of the time; 5% -> 53.8%; 10% -> 16.3%; 20% -> 0.2%.
  (Figures corrected in v0.43.0: the first cut of the harness decided each
  re-audit on its first look, which the selector has never done — it always
  spends a top-up pass on a verdict within noise. The published 79.8/60.8/25.0
  described a stricter pipeline than the one that ships.) The
  Type II tail is an order of magnitude worse than the 7.5-8.8% Type I tail, and
  two-strike retention only delays it (median eviction cycle 4-7, never cycle 1).
  That number, not intuition, is what the recovery work above should now be
  sized against — and it says recovery matters more than admission precision.
- **Close the loop on the agent PROMPT, not just its memory.** `/warden-evolve`
  already exists and is the feed-forward analog of the distiller aimed at base
  instructions: it proposes a rewrite of the prompt body (frontmatter preserved
  byte-for-byte), benchmarks it against the shipped prompt with rules and model
  held constant, rejects on regression or within-noise, and writes a winner to a
  proposals file. It is deliberately never auto-applied — `agents/*.md` is
  committed source, not a generated artifact, and three golden tasks cannot
  capture an agent's whole behavior, so a suite win does not license rewriting
  the agent's identity. That separation stays: the prompt is the reviewed
  contract, memory is the measured accretion.
  **The gap is that the two halves are not connected.** The distiller reads
  expensive real sessions and produces RULES; evolve reads only the prompt and
  produces a SHORTER PROMPT. Nothing carries production evidence into the
  contract. Concretely, rules only ever accumulate: nothing promotes a rule that
  has survived many re-audits into the base prompt (where it would stop paying
  per-rule rent and stop consuming a re-audit slot), and nothing mines the
  eviction history for prompt-level signal — "six rules about re-reading files
  all died, so the prompt is the wrong instrument for this" is a conclusion the
  data could support and no code looks for. Note also that evolve optimizes for
  CHEAPER, not BETTER: its instruction is to preserve every behavior at fewer
  tokens, so it can never add a guard for a failure that keeps recurring.
  Cheap first version: a promotion criterion for long-surviving rules, surfaced
  as a recommendation for a human to apply, matching how evolve already behaves.
  **Blocked on sample size, not on effort.** Two banked rules and four evictions
  is not a population — pattern-mining eviction history at n=4 would be reading
  tea leaves, and promotion criteria tuned on two survivors would be fitted to
  those two. This needs the dogfood window in section 1 to produce a real
  population of verdicts first.
- **Retire degenerate golden checks by addition.** Shipped in v0.40.0: `sql-08`
  replaces `sql-01`, whose `success_check` passes on the pristine fixture (it
  greps for `create index` and `user_id`, both already present), making it unable
  to detect a regression *and* invisible to the environment-failure discriminator
  (a quota-dead run on it records `completed = true`). `sql-01` is left
  byte-identical so its frozen `run1_tokens` and every published comparison stay
  valid — the same add-don't-edit remedy used for the noisy-task splits.
  **The remaining checks are now audited (v0.43.0) and they are clean.** All 21
  bundled checks were EXECUTED against a pristine fixture; the only two that pass
  untouched are the two already known, `sql-01` and `backend-03`. The suspicion
  this entry recorded about `sql-05` was WRONG: it demands an index on
  `created_at` and the pristine schema indexes only `products(name)`, so it fails
  pristine and discriminates properly. That suspicion had been formed by READING
  the grep, which is the exact mistake the original audit exists to warn about. A
  second, stricter pass confirmed no other check hides a vacuous *behavioural
  clause* behind a trailing `npx vitest run`.
  `test/golden-checks.test.ts` now enforces this on every CI run (~0.5s, no test
  runner spawned): every bundled task must have a non-test clause that FAILS on
  the pristine fixture, with `sql-01`/`backend-03` as a named allowlist so their
  precedent cannot shelter a new one. Verified to fail against an injected
  vacuous check before it was committed.
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
- **Hybrid retrieval, admitted by measurement.** The retrieval added in v0.42.0
  is lexical (BM25), which is deterministic, zero-token and exact on the periods
  and identifiers financial questions turn on — and blind to paraphrase. The
  shipped suite contains `fin-07` for that reason: the corpus
  says "undrawn capacity under its Revolving Credit Facility" and the question
  asks about "borrowing capacity". **It does not actually fail** — both lexical
  arms answer it at every budget at or above the knee, on the zero-token scorer
  and in the paired burn alike. The suite as it stands therefore contains no case
  a semantic retriever would win, so the first work item here is a question set
  that EXHIBITS the weakness rather than merely naming it; otherwise the bar a
  hybrid retriever must clear is a bar BM25 already clears.
  A semantic or hybrid retriever is the obvious
  next step, and the discipline for admitting it is already written: it must beat
  BM25 on the same suite by more than the suite's own noise, or the vector index
  has not earned its infrastructure. Do NOT add an embedding dependency before
  that comparison exists — it would put a priced, versioned, non-reproducible
  service underneath a measurement whose whole value is reproducibility.
- **A bigger corpus before quoting a bigger ratio.** `--sweep` reports both
  lexical strategies matching mega-prompt recall at **3.7x** lower cost, on 5
  documents and 4,474 tokens. That ratio is a floor and is labelled as one in the
  output, but a floor measured on a toy corpus is still a toy measurement. The
  retrieval saving scales with corpus size while retrieval cost does not, so the
  number to publish is the one from a corpus large enough that the mega-prompt is
  not a serious option. Blocked on nothing but a corpus.
  **The previously published 11.2x was wrong** (corrected 2026-08-13). The fault
  was in the scorer, not the retriever: `valueAppearsIn` built its trailing-zero
  variants with `toFixed()` under a magnitude guard, which also admitted every
  rendering a value ROUNDS to — a half-ulp tolerance inside the one function
  DECISIONS.md explicitly says has none. It scored `3.25` as retrieved from
  `3.0x`, `3.75` from `4.1 million shares`, and `14.5` from `roughly 15 to 18`.
  The knee moves 400 -> 1,200 tokens/question, and the `section`-beats-`bm25`
  ordering was the same artifact — they tie. Regression tests now pin the three
  real false positives AND the knee itself, which nothing did before.
- **End-to-end accuracy has been run ONCE, and its ranking is still open.**
  Corrected 2026-08-13: this entry previously said `--yes` had never been
  executed against a real model. It has — four burns on 2026-07-28, recorded in
  FINDINGS.md, three of which measured the instrument (a dead environment
  reporting an identical 33.3% across four arms; a multi-hop arm that stopped on
  hop 1 every time; a `period` bound that rejected the answer shape the
  cross-document questions require). Burn 4 completed 11 of 12 with 11 of 11
  correct on the `agent` arm. What remains unmeasured is the thing the entry was
  really about: **no accuracy ranking between the four arms exists.** Burn 4 was
  a single-arm subset, and the one paired table reverses its own ordering
  depending on whether failed runs are excluded. What it would take: one paired
  four-arm `--yes` run over all 12 questions in one healthy session (48 model
  calls plus the agent arm's planning hops, roughly 60 calls, each a single-turn
  `claude -p` over <= ~2k tokens of context). Recall bounds accuracy from above;
  it does not substitute for it, and the groundedness gate has still rejected
  nothing on real output.
- **The conflict question scores nothing.** `fin-05` is the suite's only
  `expectConflict` row, and its entry says it is "scored on whether BOTH sources
  are cited". Nothing reads the flag. On retrieval the row is scored on nothing
  at all; end to end, `scoreAnswer` marks it correct whenever ANY grounded fact
  comes back — proven by handing it one accepted fact about consolidated revenue,
  a metric the question does not ask about, which scored correct. So one of the
  twelve rows is currently measuring the model's willingness to produce output.
  Fixing it means scoring on the SET of documents cited, which is a real change
  to an accuracy denominator and therefore belongs with the paired burn below,
  not before it. `benchmarks/finance/` stays byte-identical until then — it is
  frozen data, amended by addition, and the 2026-07-28 burns ran against exactly
  these twelve questions.
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

## Design specs

Written before implementation, each carrying its outcome. Kept for provenance —
including the one that was tested and rejected, which is the more useful record.

- [docs/specs/byoa.md](docs/specs/byoa.md) — bring-your-own-agent. Shipped v0.36.0.
- [docs/specs/split-noisy-tasks.md](docs/specs/split-noisy-tasks.md) — splitting the
  high-variance golden tasks. Shipped v0.36.0.
- [docs/specs/weighted-suites.md](docs/specs/weighted-suites.md) — distribution-weighted
  suites. Shipped v0.37.0, after calibration rejected the first cut and forced an
  effective-degrees-of-freedom correction.
- [docs/specs/confidence-sequences.md](docs/specs/confidence-sequences.md) — anytime-valid
  confidence sequences as a retention policy. **Tested and rejected**: the bar/SE ratio is
  binding, so a dead rule would never exit. Two-strike retention stays.
