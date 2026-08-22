# Roadmap

The forward plan for token-warden, consolidated from the July 2026 audit
([docs/audit-2026-07.md](docs/audit-2026-07.md)), the validation findings
([FINDINGS.md](FINDINGS.md)), and the decision log ([DECISIONS.md](DECISIONS.md)).
Shipped history lives in [CHANGELOG.md](CHANGELOG.md); this file tracks only
what is ahead. Items are grouped by theme, and each carries the condition that
justifies doing it — nothing here ships without a measured proof, per the
project's core discipline (LLM proposes, deterministic verifier measures, only
measured survivors persist).

> **v1.0.0 REMOVED MOST OF THE COMMANDS THIS FILE REFERS TO.** The RAG subtree,
> the A/B benchmarking suite, the team ledger and ten advisory diagnostics were
> deleted — 22 commands down to 6. Entries below naming `/warden-cohort`,
> `/warden-dogfood`, `/warden-ragbench`, `/warden-modelbench`,
> `/warden-promptbench`, `/warden-evolve`, `/warden-attribute`,
> `/warden-share`, `/warden-adopt`, `/warden-protect`, `/warden-scope`,
> `/warden-health`, `/warden-compress`, `/warden-confirm`,
> `/warden-contradict` or `/warden-sample-tasks` describe work that WAS shipped
> and has since been withdrawn. They are left in place because the reasoning
> that motivated each is still the record of how this project thought, and
> because several would be the right thing to rebuild if the open question in
> section 1 ever resolves. See [docs/four-theorems.md](docs/four-theorems.md)
> section 2 for why they went.
>
> **The v1.0.0 measurements also invalidate this file's central instinct.**
> Multiple entries below propose making the gate STRICTER. The stream
> calibration showed the gate was already about 200x too strict for its own
> economics, and the default confidence multiple has moved 2 -> 1.5. Treat any
> "tighten the gate" item here as superseded until it is re-argued against
> net tokens rather than against false-positive rate.

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
  Re-open only on an environment with larger windows. **Do not re-run it as-is**
  — that is a fourth ~16M-token burn with the same expected outcome.

  *Update (2026-08-13): the "re-open after suite variance comes down" escape
  clause is withdrawn, because that route has now been measured and does not
  exist.* The gate's own metric needs **35 runs/side and 49.2M tokens** to
  resolve the recorded +10,851 effect at 80% power — six to sixteen times the
  largest quota window ever observed here. The most aggressive suite narrowing
  possible (keep only the three quietest tasks) still needs **16M tokens and 282
  runs**, i.e. more than the burns that already died twice. And re-scoring on a
  quieter metric makes it WORSE, not better: differencing burn 1's own arms
  gives delta/SE of 0.63 on total tokens, 0.56 on cost-equivalent and 0.26 on
  processing — the error bar shrinks 28-fold and detectability drops, because
  the effect lives in cache-read, the noisiest and cheapest component. The
  effect is 0.77 of one tool call against a run-to-run turn spread of 1.0-4.2
  calls: smaller than one unit of the thing that varies.
- **Out-of-fixture confirmation.** Shipped: `/warden-confirm` joins fixture
  receipts with the production cohort verdict per agent (corroborated /
  contradicted / unconfirmed), `--gate` for CI. Open: the dogfood window that
  gives it data (section 1).

## 3. Engine improvements

- **Adopt the brand vocabulary in `src/types.ts`.** `types.ts` defines nominal
  brands — `AgentName`, `TaskId`, `RulesetVersion`, `TokenCount`, `UsdAmount`,
  `ArmRole`, `AbDimension`, `AbOutcome` — and points here for the plan. This is
  that plan, written down 2026-08-20 after the pointer was found dangling.

  Nine of the ten are adopted by nothing today; only `RuleId` is in real use
  (`contradict.ts`). They are kept rather than deleted because each encodes a
  distinction the code currently gets wrong by accident somewhere, and
  `AbOutcome` in particular documents a live defect: `compare.ts#Comparison`
  carries `regression` / `environmentFailure` / `uncertain` as three booleans,
  which makes eight states representable when six are legal (a regression that
  is also an environment failure is nonsense), and every consumer re-derives the
  precedence cascade by hand. Deleting the type would delete that finding.

  Adoption order, cheapest first: `TokenCount` and `UsdAmount` at the
  `pricing.ts` boundary (they encode the rule that a dollar figure must never
  reach a gate expecting tokens); `AgentName` at `registry.ts#assertKnownAgent`;
  then `AbOutcome` inside `Comparison`, which is the one with real value and
  real blast radius. `test/types-adoption.test.ts` pins the unadopted set, so
  the list can shrink freely and only grows by editing it.

  Not urgent. Brands are compile-time only, so none of this changes a number,
  which is exactly why it keeps losing to work that does.

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
- **Cut golden-suite variance further — CLOSED as not achievable this way
  (2026-08-13).** The premise was that specific tasks are noisy and that
  narrower replacements would quiet the suite. Shipped along the way and still
  useful: `/warden-health`'s per-task variance ranking (v0.34.0) and the splits
  `sql-06`/`sql-07`, `testing-05`/`testing-06` (v0.36.0, added as new files with
  the frozen originals untouched). But
  [`validation/variance-decomposition.ts`](validation/variance-decomposition.ts)
  measured the premise and it is false.

  **The noise is not in the tasks.** One integer — the run's `tool_calls` count
  — explains **94.6%** of the within-task spread the gate consumes, and its
  coefficient of variation is flat at 22.4%-42.0% across tasks whose mean turn
  counts span 3.8 to 13.3. `sql-03`/`04`/`05` dominate the standard error
  because they are two to three times bigger, not because they are defective.
  There is nothing in them to fix, and a narrower task inherits the same CV.

  **Removing them does not help, and the honest arithmetic says why.** At a
  fixed 6M-token budget (the generous end of a real quota window), discarding
  four of the seven tasks moves the gate's statistic from 0.97 to 1.78 against
  the 2.84 it needs — because under a proportional effect a dropped task takes
  its SIGNAL with its noise. Comparing standard errors alone makes this look
  like progress; it is not. Full numbers, with bootstrap intervals and the
  trial-count stability check, in FINDINGS.md; each one pinned in
  `test/variance-published.test.ts`.

  Two things remain genuinely open, and neither is task design. (i) The gate's
  metric weights cache-read at 1.0 when it bills at 0.1, so it prices an agentic
  turn at **5.7x** its real cost — switching to a cost-weighted metric is
  defensible on economics alone, but it re-defines the estimand behind every
  published FP/FN number and so is re-calibration work, not a tweak. It would
  NOT have rescued the compression burn (see below). (ii) The agent's own
  turn-count variability is the only quantity that would move the floor, and
  nothing in this repository controls it.
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
  **The recovery half SHIPPED in v0.44.0.** The dedupe can now tell a measured
  negative from a measured positive too noisy to bank: an eviction whose point
  estimate cleared the bar and reached at least half the gate's confidence
  margin is classed `underpowered`, and such a body may be proposed once more.
  The re-proposal is a fresh candidate measured from scratch, held (free) until
  the run budget exceeds the depth its eviction was decided at, and judged at
  1.5x the ordinary margin. This entry's own prediction was right and turned out
  to be the load-bearing part: re-running into the same noise reproduces the
  verdict, and the equal-depth variant measured SIX TIMES the false-positive cost
  for LESS power than the deeper one (FINDINGS.md). Cost of the whole feature:
  +0.08 points of false positives on a 10.7% base at 20,000 trials, for +9.30
  points of recovered power on a 20%-saving rule.
  Still open: a rule evicted at RE-AUDIT is deliberately not recoverable (its
  point estimate is below the bar by construction, and it had already been banked
  once), so the Type II tail measured on the retention side is addressed only by
  the retention budget above, not by recovery. **The false-negative rate is now measured** (v0.42.0). The prerequisite this
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
  lexical strategies matching mega-prompt recall at **4.4x** lower cost, on 5
  documents rendering to 5,648 tokens. That ratio is a floor and is labelled as
  one in the output, but a floor measured on a toy corpus is still a toy
  measurement. The
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
  **Corrected again 2026-08-15**, this time in the cost accounting rather than
  the scorer: `Retrieval.tokens` priced chunk bodies while the prompt adds a
  per-chunk citation label, understating every arm by 17.6-20.8% and letting the
  assembled context exceed its stated budget on all 12 questions. Fixing it
  exposed a second defect — the packer skipped past chunks that did not fit, so
  recall could FALL as budget rose (78% at 400, 67% at 600); it now takes a
  prefix and stops, because nested selections are the only ones that can be
  monotone. Knee 1,200 -> 1,400, ratio 3.7x -> 4.4x, floor 22% -> 11%. The ratio
  rose because the mega-prompt's own cost was understated by more than
  retrieval's.
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
