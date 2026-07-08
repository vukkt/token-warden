# Changelog

## v0.36.0 — 2026-07-08

Bring-your-own-agent (the productization step), narrower golden tasks to cut
suite variance, and a principled retention policy tested and honestly rejected.
Built as a reviewed PR stack; the distribution-weighting work is measured but
deferred (see below).

- **Bring-your-own-agent** (`src/registry.ts`). The four bundled domain agents
  are no longer the ceiling: an integrator drops `<name>.md` agent definitions
  into `TOKEN_WARDEN_AGENTS_DIR` (default `~/.token-warden/agents`) and golden
  suites into `TOKEN_WARDEN_BENCHMARKS_DIR` (default `~/.token-warden/benchmarks`),
  and every command discovers them via `knownAgents()`. With neither env var
  set and no such directory present, behavior is byte-identical to before —
  the bundled four stay the defaults. This is what lets token-warden measure a
  user's own agents against their own workload rather than only the shipped
  fixture.
- **Narrower golden tasks** (`benchmarks/sql/golden-06,07`,
  `benchmarks/testing/golden-05,06`). `/warden-health` and the empirical
  calibration flagged sql-02 and testing-02 as the noisiest tasks, burying
  modest savings under >25% run-to-run variance. Their scope is split into
  four narrower, independent tasks (schema-only / repository-only;
  insert-path / query-path) with hand-verified success checks. Frozen tasks
  are untouched (invariant #4) — these are additions. Lower per-task variance
  means cheaper, sharper verdicts on every future burn.
- **Confidence-sequence retention, tested and rejected**
  (`validation/calibration.ts`). An anytime-valid confidence sequence (Howard
  et al. 2021) was added as a third policy column beside one- and two-strike,
  against a pre-declared decision criterion. It loses: because the per-audit
  SE (~5,500-7,900 tok) dwarfs the ~54-token bar, the time-uniform bound needs
  on the order of (SE/bar)^2 audits to shrink below the bar, so a dead rule
  essentially never exits (~492 cycles vs two-strike's ~6). Two-strike stays,
  now with a principled competitor beaten on the record. A negative result,
  reported as one — nothing tuned to force a win.
- Deferred: distribution-weighted suites (task `weight:` in the verdict). The
  estimators are implemented and proven exact (bit-identical on the unweighted
  path), but the calibration harness showed the weighted false-positive rate
  inflates above the pre-declared tolerance at low run counts — a real
  effective-sample-size effect, not a bug. Held back rather than shipped with a
  gate that under-protects; it returns once the confidence multiple accounts
  for reduced effective degrees of freedom. Same discipline that kept robust-SE
  out of the gate.

## v0.35.0 — 2026-07-06

Statistical self-validation against the project's own recorded data: empirical
(distribution-free) calibration of the verdict gate, and a power planner so a
verification burn is provably adequately powered before it spends. Zero tokens
for both — and the first empirical run already earned its keep (FINDINGS.md):
the real false-positive rate under recorded noise is 2-3x the synthetic
model's claim.

- **Empirical calibration** (`validation/empirical-calibration.ts`,
  `src/db.ts` `goldenReplicateRuns`). Resamples RECORDED active-set golden
  runs — replicate groups keyed by (task, ruleset version, model), the only
  rows guaranteed to be repeated measurements of an identical configuration —
  and pushes A/A splits through the real `assessDelta`/`verdict`/top-up
  pipeline. Both sides of a split come from the same pool, so the true delta
  is zero by construction and the keep rate IS the empirical false-positive
  rate, with no distributional assumption (the synthetic harness assumes
  Gaussian + derailment noise with eyeballed parameters). Permutation mode
  for the exact A/A; bootstrap mode adds semi-synthetic POWER by injecting a
  known saving onto real noise. Wilson CIs (Monte-Carlo error only, stated).
- **`/warden-power`** (new `src/power.ts`). Zero-token power planner: inverts
  the selector's own promotion rule (keep iff delta >= bar + z*SE) into the
  minimum detectable saving at each run count and the runs/side a target
  saving needs at 80%/90% power, using the agent's own recorded per-task
  variances. Deliberately conservative (uniform allocation; the Neyman top-up
  only tightens the SE), so a burn planned with it cannot come out
  underpowered by design. Rent defaults to the median context_cost of the
  agent's active rules.
- `sampleVariance`, `pooledVariance`, and `confidenceZ` are now exported from
  `src/select.ts` (unchanged behavior) so the planner and harness reuse the
  exact production estimators instead of reimplementing them.

## v0.34.0 — 2026-07-04

The roadmap's CLI-shaped features, in one release: the tooling for all three
falsification experiments, per-category regression reporting, advisory dollar
accounting on decisions, suite-noise ranking, and opt-in scheduled selection.
Every measurement invariant is preserved — nothing new gates, evicts, or
spends tokens without an explicit user action or opt-in.

- **Best-of-K distillation** (`src/distill.ts`, `--k 1-3` /
  `TOKEN_WARDEN_DISTILL_K`). The distiller can sample K times per expensive
  run, pooling distinct proposals: samples are deduped against each other
  (trigram, same 0.85 threshold) before the against-past-rules dedupe, and
  the batch is capped at 3 — the selector measures at most 3 candidates per
  invocation, so proposing more would only queue unmeasured rules. Default
  K=1 (no behavior change).
- **`/warden-compress`** (new `src/compress.ts`, migration #15
  `rules.replaces`). Rewrites a measured rule's body at no more than half the
  characters (one headless model call, strict JSON, validated shorter + not a
  near-duplicate) and queues the rewrite as a **swap candidate** carrying
  `replaces = <original id>`. The selector measures a swap against the active
  set *minus* the original — measuring it on top of the semantically identical
  original would pin its marginal delta at ~0 and make the A/B unwinnable by
  construction. The variant faces the same 2x-rent bar standalone; rent is
  length/4, so a variant that holds the delta clears it at half the rent. The
  original is never auto-removed (invariant #1): once the variant is active,
  the original is redundant and exits through its own two-strike re-audits.
  `--dry-run` previews.
- **`/warden-confirm`** (new `src/confirm.ts`). Out-of-fixture confirmation:
  joins each agent's fixture verdicts (latest receipts of active rules) with
  its production cohort verdict. CORROBORATED / CONTRADICTED (recommends a
  fixture re-audit, never auto-evicts) / UNCONFIRMED / NOTHING-TO-CONFIRM;
  `--gate` exits non-zero on a contradiction. Zero tokens, read-only.
- **Per-category regression reporting** (`src/modelbench.ts`,
  `src/compare.ts` `regressedTaskIds`/`formatCategoryRegressions`).
  `/warden-modelbench --agent all` sweeps every domain suite and closes with
  a "Regression by category" roll-up naming exactly which tasks broke in
  which category, plus one combined meta-cost line. Prompt variants are
  per-agent by nature, so promptbench keeps its single-agent shape.
- **`/warden-select --uniform-top-up`** (`src/select.ts`). Forces the top-up
  to one full uniform suite pass instead of the Neyman variance-proportional
  allocation — same budget, spent evenly: the control arm for the allocation
  benchmark deferred from v0.24.0.
- **Advisory dollars on decisions and receipts** (`src/select.ts`,
  `src/receipt.ts`). Each decision line and receipt card now carries
  `≈$X/run` (the agent's real-work token mix priced at the measured model —
  the `/warden-cost` machinery), and the selector prints a weekly projection
  for the rules it kept. Advisory only: the keep/evict gate stays on raw
  tokens; a dollar gate needs its own calibration proof first.
- **Golden-task variance ranking** (`src/health.ts` `rankTaskVariance`,
  `src/db.ts` `goldenTaskTotals`). `/warden-health` ranks each agent's golden
  tasks by coefficient of variation over recent active-set runs and names
  those above the shared 25% warning level as splitting candidates (add task
  files, never edit frozen ones). Informational; never affects `--gate`.
- **Opt-in scheduled selection** (`src/notify.ts` `planAutoSelect`/
  `sessionStart`, `src/db.ts` `lastMeasurementTs`).
  `TOKEN_WARDEN_AUTO_SELECT=1` lets the SessionStart hook spawn the selector
  detached for the agent with the most pending candidates — at most once per
  24h. The cooldown counts ANY benchmark run (active/candidate/audit): the
  selector spends the shared baseline first, so a crash after that pass must
  still start the cooldown — otherwise every session start would re-spawn the
  selector and re-burn the baseline in a loop. Off by default; selection
  stays a user decision otherwise.
- **Distiller resilience** (`src/distill.ts`, `src/compress.ts`). A failed
  best-of-K sample (spawn error, timeout, or non-zero exit) is logged and
  skipped like the invalid-JSON case instead of aborting the batch — earlier
  samples' paid-for proposals survive. Both model-call boundaries now check
  the exit code before parsing stdout (the error-ledger rule), so a CLI
  failure surfaces as "claude exited N: <stderr>" rather than a JSON parse
  error.
- Explicitly not built, per the roadmap's own trigger-gating: Bonferroni
  z-adjustment, bootstrap CIs, robust-SE gate, dollar-weighted gate, rule
  marketplace. 524 → 578 tests.

## v0.33.0 — 2026-07-04

Hardening release: the CLI orchestration layer brought under the unit suite,
the coverage ratchet raised to match, hot-path indexes and a pinned
`synchronous` pragma in the store, and the forward plan consolidated into
[ROADMAP.md](ROADMAP.md).

- **Bench/select CLI orchestration under test** (`src/bench.ts`,
  `src/select.ts`, `test/bench-main.test.ts`, `test/select-main.test.ts`).
  `bench.ts` now exports `main`/`benchAgent` with an injectable suite runner
  (the same seam `select.ts` already used), and `select.ts` exports `main` —
  so task/rule resolution, baseline notes, meta-cost reporting, top-up
  allocation, and decision printing are exercised in-process with the spawn
  boundary stubbed. The real `claude`-spawning path (`runOnce`/`runSuite`)
  remains the intentional integration seam, covered by the e2e smoke. Guard
  branches across the scope/protect/select parsers and the previously
  uncalled `candidateCounts`/`recentQuestionsFrom` helpers are covered too:
  500 → 524 tests.
- **Coverage ratchet raised** (`vitest.config.ts`): lines 89 → 94, statements
  88 → 93, functions 92 → 96, branches 77 → 83, from measured
  95.0/93.9/97.2/84.3 — CI now fails any regression below the new floor.
- **Hot-path indexes** (`src/db.ts`, migration #14): `runs(agent, task_hash)`
  and `rules(agent, status)` — the two filter shapes behind learning curves,
  anomaly windows, active-memory compilation, and candidate listing, which
  previously full-scanned.
- **`synchronous = NORMAL` pinned** (`src/db.ts`). better-sqlite3's bundled
  SQLite already runs WAL at NORMAL via a compile-time default; the Stop
  hook's 2s budget now depends on an explicit pragma instead of that flag.
- **ROADMAP.md** — the deferred experiments, engine improvements, and
  trigger-gated guardrails that lived across the audit doc, FINDINGS,
  DECISIONS, and the README are consolidated into one plan with success
  metrics and triggers; the README roadmap section now summarizes and links.
- **Stale validation driver removed** (`validation/burn-overnight.sh`) — a
  machine-specific one-off burn harness referenced by nothing.
- Plugin/marketplace descriptions now state the measured, CI-enforced
  coverage instead of a hard-coded figure.

## v0.32.0 — 2026-07-04

Closing the measurement loop: two-strike re-audit retention, verdict-grounded
distiller feedback, and a survivorship-bias flag. Zero-token improvements out
of a full repository audit ([docs/audit-2026-07.md](docs/audit-2026-07.md)).

- **Two-strike probation for re-audits** (`src/select.ts`, migration #13
  `rules.probation`). Admission demands savings ≥ bar + z·SE, but retention
  tested only the point estimate — and because the bar (~2× rent) is tiny next
  to the SE, regression to the mean churned real earners (a rule truly saving
  6,000 tok/run was expected to survive only ~7 re-audit cycles; the live DB's
  Grep rule was lost to exactly one such draw). Now the first non-regression
  sub-threshold re-audit puts the rule on probation (kept, flagged
  `PROBATION (strike 1 of 2)`); a second *consecutive* one evicts; a passing
  re-audit clears the strike. A regression still evicts immediately. The
  calibration harness validates the change: a dead rule still exits in ~6
  cycles, while a 6,000-tok/run earner's expected lifetime grows from ~7 to
  ~61 cycles.
- **Verdict-grounded distiller feedback** (`src/distill.ts`, `src/db.ts`).
  The distill prompt now includes the agent's recent evicted rules (≤ 8) with
  their measured deltas and eviction reasons — so the proposer learns from
  measured failures instead of re-deriving falsified ideas in new words
  (trigram dedupe only catches near-verbatim repeats). The closed-loop signal
  the compiler-pass-ordering literature credits with 23–40% of total gains.
- **Completion-drop flag** (`src/select.ts`). Savings means use completed
  runs only, so a rule whose failed runs are dropped looks cheaper than it is.
  Decisions where any task completed at a lower *rate* with the rule are
  flagged `COMPLETION-DROP` (rates, not counts — a Neyman top-up legitimately
  adds runs to one side). Report-only; a full task failure remains the
  regression eviction.
- **Calibration: re-audit churn tables** (`validation/calibration.ts`).
  One-strike vs two-strike expected lifetimes by true effect size, under both
  noise models — the zero-token proof for the retention change.

## v0.31.0 — 2026-07-01

Latency as an advisory measurement axis in A/B comparisons.

- **Wall-clock latency capture** (`src/bench.ts`, `src/db.ts`). Golden runs now
  record `duration_ms` — read from the claude JSON result the bench already
  parses (only `session_id` was used before), so it costs nothing extra. Stored
  in a new nullable `runs.duration_ms` column (migration #12); real-work
  collection and pre-existing rows stay null.
- **Reported in the comparison, never in the verdict** (`src/compare.ts`). The
  model/prompt A/B report gains a per-task `[latency Xs → Ys]` note and an
  overall "Latency (advisory, not in verdict)" line — so a change that saves
  tokens but slows the agent is visible. Latency is *never* a keep/evict input;
  the verdict stays on processing tokens, matching how cache-read and tail-risk
  are surfaced.
- Answers the roadmap's "richer metrics — latency" item. Per-category regression
  reporting remains open.

## v0.30.0 — 2026-06-30

Robust aggregation as a tail-risk warning — and the calibration harness catching
a regression in it (see FINDINGS.md).

- **Tail-risk flag** (`src/select.ts`). `assessDelta` now trims genuine
  "derailment" outliers (a run >50% off the median *and* a 3-MAD outlier;
  conservative, so clean data is untouched) and reports `robustDelta` + `tailRisk`.
  When trimming materially moves the saving, the decision is flagged
  `TAIL-RISK` (in the selector output and the `Decision`) — the rule's cost is
  unstable / occasionally blows up.
- **The verdict deliberately does NOT use the robust SE.** Re-running the
  calibration harness with robust-SE-in-the-gate *raised* the false-positive rate
  (~3% → ~7% on the derailment model): a trimmed zero-effect rule's SE is
  over-confident. So keep/evict stays on the mean and the raw (correctly
  calibrated) within-task SE; robust aggregation is a *warning*, not a gate input.
- No behavior change to the keep/evict decision vs v0.29.0 — only the added
  `robustDelta`/`tailRisk` reporting fields and the output flag.
- 489 tests (+3), green on Node 22 and 24.

## v0.29.0 — 2026-06-29

The engine calibrates itself, tightens its confidence default, and feeds its wins
back into proposals.

- **Calibration harness** (`validation/calibration.ts`, zero-token). A Monte-Carlo
  that injects synthetic rules with known effect + noise into the *real*
  `assessDelta`/`verdict` path and measures false-positive rate and statistical
  power. It found the old `|delta − bar| < 1·SE` band kept a **zero-value rule
  ~16% of the time**.
- **Confidence default tightened to `z = 2`** (`WARDEN_CONFIDENCE_Z`, ~95%
  one-sided), dropping the false-positive rate to **~2.5%**. The honest cost is
  power — at ~25% noise the engine confidently banks only rules worth ≳ 30% of a
  session at low run counts; smaller ones need more runs (which the Neyman top-up
  spends). Lower toward 1 to trade precision for power.
- **Self-reinforcing distiller** (`src/distill.ts`). `buildPrompt` now feeds the
  agent's already-banked rules back in with a "do NOT repeat — propose a new
  practice they don't cover" instruction, so each proven rule shapes the next.
- FINDINGS: calibration table, and an honest re-framing of the positive control
  (banked under the old z=1 band, borderline under z=2 at runs=2 — the engine
  keeps a real rule but runs=2 was underpowered).
- 486 tests (+5), green on Node 22 and 24.

## v0.28.0 — 2026-06-29

Three roadmap features plus a concise, more visual README.

- **Transcript provenance** (`rules.born_digest`). Each distilled rule stores a
  short digest of the session it was born from; `/warden-receipt` shows it as a
  "born of:" line, so you can see exactly the wasteful behavior that motivated
  each rule. Memory review becomes code review.
- **Per-rule scope** (`/warden-scope`, `rules.scope`). Give a rule an "allowed
  where" predicate (a language, a service, a task type); it compiles into memory
  as `(when <where>) <rule>` so the agent applies it only there. Advisory — the
  agent self-applies it; the keep/evict measurement is unchanged.
- **Stale-rule flagging** (`/warden-health`). Flags active rules not re-audited
  within N days (default 30) so their measured savings can be re-validated.
  Recommends a re-audit, **never auto-evicts** (the controlled fixture stays the
  only evictor); protected rules are exempt; `--gate` exits non-zero in CI.
- **README rewrite**: the loop is now a GitHub-native Mermaid flowchart (was
  ASCII), the four stages condensed to a tight list, the distiller note corrected
  to Sonnet, and the new commands added.
- DB migration #11 (`rules.born_digest`, `rules.scope`). Append-only.
- 481 tests (+19), green on Node 22 and 24.

## v0.27.0 — 2026-06-25

Horizon projection — scale the dollar savings over time, with a with-vs-without
comparison, plus visual docs.

- **`/warden-cost --project`** (`src/cost.ts`, new `projectAgent`): projects an
  agent's active rules over a horizon (default **13 weeks ≈ 3 months**; set with
  `--months` / `--weeks` and `--sessions-per-week`). Reports gross savings, the
  one-time operating (benchmark discovery) cost, NET benefit, break-even, and —
  when real-work runs exist to estimate a baseline — the cost **with vs. without**
  the plugin and the % saved.
- **README "What it saves"** section with three GitHub-native Mermaid bar charts
  (cost/session with vs. without, 3-month net savings by usage profile, and a
  power-user 3-month with-vs-without comparison) plus a 3-month/annual savings
  table — all clearly labelled as the positive-control illustration (manufactured
  headroom), conditional on a rule surviving on the user's workload.
- 462 tests (+5), green on Node 22 and 24.

## v0.26.0 — 2026-06-24

Dollar accounting — translate token savings into money, the unit the recurring
critique demanded (see FINDINGS.md).

- **New `src/pricing.ts`**: a price table (public Anthropic per-1M-token rates;
  cache-write 1.25× input, cache-read 0.1× input) keyed by model, with every rate
  overridable via `TOKEN_WARDEN_PRICE_INPUT` / `_OUTPUT` / `_CACHE_WRITE` /
  `_CACHE_READ`. `dollarsForTokens` prices a typed breakdown; `blendedDollarsPerToken`
  derives the agent's real $/token from its actual mix.
- **New `/warden-cost`** (`src/cost.ts`): per active rule, the dollar value —
  savings/session, rent/session, net/session, weekly total, and a break-even
  against the estimated discovery cost. Savings are priced at the agent's
  **blended** mix (most saved tokens are cheap input/cache-read, so the figure is
  the truthful magnitude, not an inflated output-rate number); rent at the input
  rate. The keep/evict gate stays in tokens — this is the dollar lens on it.
- **Re-priced both real-token results** (FINDINGS): the dollar lens *agrees with
  the token verdict on both* — the surviving rule nets ~$0.032/run (~500× its
  rent, +1.57σ); the inconclusive one is ~$0.009/run and within noise. The engine
  is internally consistent and now dollar-honest about the (modest, per-run)
  magnitude.
- New `agentTokenMix` db helper (sums an agent's input/output/cache token types).
- 457 tests (+20), green on Node 22 and 24.

## v0.25.1 — 2026-06-23

Refinement pass on the v0.25.0 features.

- **Fix: `/warden-contradict` now checks the user's project CLAUDE.md.** The slash
  command `cd`s into the plugin root, so the previous `process.cwd()/CLAUDE.md`
  default read token-warden's own file. It now prefers `$CLAUDE_PROJECT_DIR`
  (the user's repo root) and falls back to cwd.
- **Fix: verdict reason rounding.** The displayed cache-aware bar used `round`,
  which could print `savings 21 < 2× rent (21)`; it now uses `ceil` so a
  sub-threshold delta always reads strictly below the bar.
- **`/warden-sample-tasks` gives a clear error** when `--from` does not exist
  instead of a raw `ENOENT`.
- Perf: `findContradictions` tokenizes each CLAUDE.md line once instead of once
  per rule.
- 437 tests (+2), green on Node 22 and 24.

## v0.25.0 — 2026-06-23

Four features hardening the scope boundary raised in review: the token gate
should govern efficiency rules, not behavioral ones, and shouldn't depend on a
perfect suite to stay safe.

- **Protected (human-authored / behavioral) rules** (`/warden-protect`, new
  `protected` column). A protected rule is compiled into memory and counted for
  rent but is **never token-evicted** — the selector never re-audits it, and only
  a human removes it. The 2× gate is the right test for an efficiency rule and the
  wrong one for a behavioral rule (an edge-case fix, a safety constraint) whose
  value is not measured in tokens. `--add`, `--protect <id>`, `--unprotect <id>`,
  `--list`.
- **Cache-aware rent.** `effectiveRent` now prices in the one-time cache
  re-prefill a rule incurs when the ruleset changes (memory block re-created at
  ~1.25× input, amortized over a week). The 2× bar is now slightly *harder*, never
  easier — pricing the cache bust in rather than ignoring it. Verdict logic and
  the regression gate are otherwise unchanged.
- **Contradicted-by-CLAUDE.md falsification** (`/warden-contradict`). A zero-token
  lexical check (shared topic + opposite polarity, or an antonym pair on a shared
  topic) that flags active rules conflicting with the repo's conventions. It
  **recommends review, never auto-evicts** (the controlled fixture stays the only
  authority that removes a rule); `--gate` exits non-zero in CI.
- **Production-sampled task drafts** (`/warden-sample-tasks`). Drafts candidate
  golden tasks from real session transcripts (opening prompt, de-duplicated,
  `success_check` left as TODO) to cut the suite-building burden. Never
  auto-freezes a task — a human writes the check and moves it into the suite.
- DB migration #10 (`rules.protected`). Append-only; existing rules default to 0.
- Docs: README commands + roadmap, DECISIONS rationale, FINDINGS note.
- 435 tests (+41), green on Node 22 and 24.

## v0.24.0 — 2026-06-23

Neyman (variance-proportional) top-up allocation — the precision lever the
within-task SE made possible (see FINDINGS.md). Same token budget, placed where
it shrinks the error bar.

- **An uncertain verdict now tops up by variance, not uniformly** (`src/select.ts`,
  new `allocateTopUpRuns`). The old top-up re-ran the whole measured side once
  more. Since the SE is `sqrt((1/K²)·Σᵢ s²ᵢ/nᵢ)`, one extra run on task i cuts its
  term by `s²ᵢ/(nᵢ(nᵢ+1))`; the selector greedily hands each run in the budget to
  the task with the largest such marginal — pouring runs into the few
  high-variance tasks that dominate the error bar and skipping the quiet ones.
- **Cost-neutral, not a loosened bar.** The budget equals one full duplicate pass
  (what the uniform top-up cost), so this spends the same tokens, just better
  placed. The verdict logic, 2× threshold, and uncertainty test are unchanged.
- **Falls back to a uniform pass at runs=1** (no within-task variance to allocate
  against), matching the v0.23.0 SE fallback; regressed tasks are never allocated
  to. `SuiteRunner` gained an optional `allocation` argument (backward-compatible).
- Docs: FINDINGS lever now shipped, DECISIONS rationale.
- 394 tests (+5: 4 allocator unit tests + 1 selector routing test), green on
  Node 22 and 24.

## v0.23.0 — 2026-06-23

The within-task standard error — a correctness fix to the verdict's statistics
that makes the run-count lever actually buy confidence (see FINDINGS.md).

- **`assessDelta` now builds the standard error from propagated within-task run
  variance**, not the spread between tasks (`src/select.ts`). For a frozen golden
  suite the tasks are the whole population — their differing savings are fixed
  offsets, not sampling error — so the only sampling error is run-to-run noise
  within a task: `SE = sqrt( (1/K²)·Σᵢ [s²_without,i/n_i + s²_with,i/n_i] )`.
- **The point estimate and the regression gate are unchanged.** This is a
  correctness fix, not a loosening of the 2× bar — only the confidence interval
  changes, to the one the frozen-suite design implies.
- **Why it matters:** the old SE was independent of run count, so "more runs"
  could not tighten it — the v0.18 run-count lever was statistically inert. The
  new SE shrinks as `1/√runs`. On the real full-loop data the old SE was a
  falsely-confident 4,711; the corrected SE is an honest 7,995 at runs=2 and
  collapses as runs rise. Two new unit tests pin both properties.
- **`DeltaAssessment.standardErrorBasis`** (`"within-task" | "between-task"`) is
  reported so a verdict's confidence basis is auditable; at runs=1 it falls back
  to the legacy between-task spread rather than silently dropping the uncertainty
  flag. The validation harnesses print the basis.
- Docs: FINDINGS statistical-correction section with the real before/after,
  DECISIONS rationale (fixed-task vs generalization), README roadmap note on the
  next lever (Neyman top-up allocation).
- 389 tests (+4), green on Node 22 and 24.

## v0.22.0 — 2026-06-22

Distiller candidate-quality upgrade — the full-loop experiment localized the
loop's bottleneck to *what the distiller proposes*, not the measurement engine
(see FINDINGS.md). This release targets that.

- **Distiller now defaults to `sonnet`** (`src/distill.ts`, new
  `TOKEN_WARDEN_DISTILL_MODEL`, default `sonnet`). The full-loop run showed haiku
  proposing a narrow, ~4%-effect rule (`ls` before `find`) that the
  `(noise / effect)²` math leaves swamped by run-to-run variance. A stronger
  distill model is the cheapest lever on candidate impact. Override with
  `TOKEN_WARDEN_DISTILL_MODEL=haiku` to economize.
- **`buildPrompt` rewritten to demand the single highest-impact rule.** It now
  instructs the model to first identify the biggest source of wasted tokens in
  the session and target *that*, with few-shot exemplars of high-impact rules
  (grep before reading whole files; never re-read a file; state a one-line plan).
  The SAME-RESULT false-economy guard (no skipping steps / cutting verification /
  trading thoroughness) is kept intact.
- `validation/full-loop-experiment.ts` uses the same env-configurable model.
- Why no measurement-side change: statistics shrink the constant in
  `n ≈ (z·σ/d)²`, not the `(σ/d)²` scaling — only a larger effect `d` (a
  higher-impact candidate) makes a rule economically detectable. The bar stays
  exactly where it was.
- Docs: CONTRIBUTING config table row, DECISIONS rationale.
- 385 tests, green on Node 22 and 24.

## v0.21.0 — 2026-06-22

Cohort governance — the falsification path (rule governance roadmap), plus a
primed full-loop experiment.

- **Cohort verdict now drives a governance action** (`src/cohort.ts`). Every
  `/warden-cohort` result carries a recommendation: REGRESSED -> **re-audit**
  (real work got costlier; re-audit the agent's rules on the fixture), IMPROVED
  -> **corroborated**, NO-CHANGE -> **no-signal**. It deliberately **flags, never
  auto-evicts** — the signal is observational, so a regression recommends a
  *controlled* fixture re-audit, which stays the only authority that removes a
  rule.
- **New `--gate` flag**: `/warden-cohort --gate` exits non-zero if any agent
  regressed in production, so a CI pipeline can fail and prompt the re-audit. The
  production half of the falsification loop the design called for.
- **Primed: `validation/full-loop-experiment.ts`** — proves the still-unproven
  half (the distiller). It runs the real distiller pipeline (`buildPrompt` + the
  haiku call + `parseRulesJson`) on a wasteful session transcript to get a rule
  the *system* proposed, then benchmarks that rule on the naive agent. Dry-run by
  default; `--yes` (with `--transcript`) spends tokens. A SURVIVES here would be
  the first end-to-end demonstration of the autonomous loop banking its own rule.
- Docs: `docs/production-cohort-validation.md` governance section, README command
  row, DECISIONS updated.
- 385 tests (+6), green on Node 22 and 24.

## v0.20.0 — 2026-06-22

Production-cohort validation (roadmap: rule governance and falsification) — the
out-of-fixture signal, and the first scalability step.

- **New `/warden-cohort` command + `src/cohort.ts`.** Answers a question the
  frozen-fixture benchmark can't: *did rules make REAL work cheaper?* It groups
  the agent's completed real-work sessions by the ruleset version active at the
  time and compares the earliest cohort (before rules) against the latest (after),
  using per-session totals so it can put a standard error on the difference. The
  verdict is **improved / regressed / no-change / insufficient-data**, confident
  when `|delta| > 2x` the pooled standard error, with a `--min-n` floor (default
  5) and `--project` scoping. Read-only; spends no tokens.
- **New `realWorkTotalsByVersion` db query** returns raw per-session real-work
  totals by ruleset version (the existing `realWorkCurveByAgent` pre-averages, so
  it can't yield a variance). Reuses the established real-work filters
  (`task_hash IS NULL AND completed = 1`).
- **Why it matters:** the fixture benchmark only covers the bundled agents and
  costs extra tokens; cohort validation works on any real workload for free and
  is the production half of rule governance — REGRESSED is the natural trigger for
  re-audit/eviction (follow-on). Deliberately **observational** (real sessions
  aren't task-controlled; `--project` reduces task-mix confounding), so it
  corroborates the controlled benchmark rather than replacing it.
- Docs: new [`docs/production-cohort-validation.md`](docs/production-cohort-validation.md)
  with the design, statistics, and Mermaid diagrams; README commands + module map
  and ARCHITECTURE updated.
- 379 tests (+14 for cohort), green on Node 22 and 24.

## v0.19.0 — 2026-06-19

Benchmark variance reduction — the `FINDINGS.md` follow-through, and the direct
path to the project's one unmet goal (a *surviving* rule).

- **Quieter, larger golden suites for the two noisiest agents.** The validation
  burn found `testing-02` (~150k tok/run) and `sql-02` varied >25% run-to-run,
  burying modest savings under noise. The selector's standard error is
  `sqrt(variance / n_tasks)`, so adding low-variance tasks tightens it directly.
  Added three deterministic anchor tasks as **pure additions with fresh ids — the
  existing frozen baselines are untouched** (design invariant): `testing-04`
  (single-table `userRepo` tests, no joins — the quiet sibling of `testing-02`),
  `sql-04` (additive `getUserByEmail` query), and `sql-05` (a single-file
  `orders(created_at)` index). `sql` is now 5 tasks, `testing` 4; `frontend`/
  `backend` unchanged at 3.
- **Suite-integrity test hardened.** The golden-suite test asserted exactly three
  tasks per agent; it now asserts a floor of three plus **unique task ids** (a
  duplicate id would silently collide on one frozen baseline).
- Docs updated for the now-variable suite size (no hardcoded "three tasks"; the
  freeze/validation cost estimates scale with suite size × the default 3 runs).
- 363 tests, green on Node 22 and 24.

## v0.18.0 — 2026-06-17

Fixes driven by the real-token validation burn (see `FINDINGS.md`). The burn
confirmed the measurement and safety gates work — it correctly evicted a
distilled rule that saved 38k tokens by breaking the task — but located two real
limiters: benchmark variance and candidate quality. This release addresses both.

- **Default run count 2 → 3** (`/warden-bench`, `/warden-select`). Real
  golden-suite runs varied >25%; a third run per configuration tightens the
  standard error so the selector can distinguish a genuine small saving from
  noise instead of evicting it as uncertain. Override with `--runs`.
- **Distiller false-economy guard.** The distillation prompt now explicitly
  forbids rules that skip steps, give up/retry less, cut verification, or trade
  thoroughness for tokens — the class of rule the burn caught the selector
  evicting (a token saver that failed every task). `buildPrompt` is exported and
  tested for the guard.
- **Docs:** new `FINDINGS.md` (the burn methodology, results, and conclusions);
  README roadmap updated (was stale at v0.13.0) with the validation status and a
  near-term plan aimed at producing the first *surviving* rule.
- The `validation/` harness (added across prior commits) is documented and
  reproducible: `validation/run.sh`, `burn-all.sh`, and a zero-token
  `dress-rehearsal.ts`. 363 tests, green on Node 22 and 24.

## v0.17.0 — 2026-06-16

Quality hardening — no plugin behavior change; this release is about making the
codebase provably tested and tight, with CI guards that can't silently slip.

- **90% line coverage (78% branch), CI-gated.** Added `@vitest/coverage-v8` with
  a ratchet-floor threshold; the new `coverage` pipeline stage fails the build on
  any regression. Coverage rose from ~66% to **90%** by unit-testing the
  subprocess/stdin CLIs (`collect`, `gate`, `distill`, `evolve`, `modelbench`,
  `promptbench`) with mocked `child_process`/stdin boundaries — real orchestration
  tests (fail-open contracts, verdict decisions, anomaly alerts), not padding. The
  untestable `invokedDirectly` entry shims are honestly excluded via `v8 ignore`.
- **Dead-code gate.** `knip` (unused files/exports/deps) is wired into CI and the
  module API surface was tightened (8 internal-only exports un-exported). Zero
  unused SQL fields.
- **Component-integration + performance tests.** `test/integration.test.ts` wires
  the real modules end-to-end (collection → distill trigger → selector → receipts
  → status) through one DB; `test/perf.test.ts` holds hot-path budgets — transcript
  parser ~39 MB/s (2 MB in ~50 ms vs the 2 s Stop-hook budget), 50k tool events
  attributed in ~24 ms, a 2k-session rollup in ~1.3 ms.
- 361 tests, green on Node 22 and 24.

## v0.16.0 — 2026-06-16

Rule receipts — the per-rule verdict card (community-suggested).

- **New `/warden-receipt` command** (`npx tsx src/receipt.ts [--agent <name>]
  [--json]`) renders the evidence behind each keep/evict decision as one card:
  token savings vs. context rent (with variance and ROI multiple), the model and
  golden-suite hash it was measured under, per-task pass/fail with vs. without
  the rule, and the tool-call / file-reread **activity profile** with vs. without
  (shown as a signed % so a reviewer can see whether a "cheap" rule did less
  work). Read-only; the natural payload for sharing a rule — "my delta is
  evidence, not authority for your repo."
- The selector now records a receipt snapshot (`rule_receipts` table, migration
  #9) at every decision — initial and each re-audit, so a rule has an audit
  trail. **The keep/evict verdict logic is unchanged**; receipts are additive
  capture. `RunResult` now carries tool-call / file-reread counts; `bench.ts`
  gains `goldenSuiteHash` for suite provenance.
- The safety axis is surfaced, not auto-judged: a big activity drop is usually
  the *point* of an efficiency rule, so the receipt shows the numbers and leaves
  the call to a human — the binding safety gate remains the per-task pass/fail
  regression, which evicts on its own.
- 292 tests, green on Node 22 and 24.

## v0.15.0 — 2026-06-16

Tooling and docs — no plugin behavior change.

- **Staged CI/CD pipeline.** `.github/workflows/ci.yml` is now a dependent-stage
  pipeline — `quality` (lint, typecheck, manifest version consistency) →
  `test` (Node 22 + 24) and `fixture` in parallel → `validate` (plugin-manifest
  validation + a CLI smoke run) → `release`. The `release` stage runs only on a
  `vX.Y.Z` tag: it verifies the tag matches the manifests and publishes the
  GitHub release with notes from `CHANGELOG.md`. Tag-push is now the whole
  deploy step.
- **Release helper scripts** (`scripts/check-versions.mjs`,
  `scripts/changelog-section.mjs`) — version-consistency guard and changelog
  extraction, reused by CI and runnable locally (`npm run check:versions`).
- **Standard project docs:** `CONTRIBUTING.md` (setup, the pipeline, the release
  flow, the design invariants) and `SECURITY.md` (reporting + the security
  model). README gains a **Quickstart** at the top of "Getting started".
- A professional sweep of every source file found it clean (no TODO/FIXME, no
  `any`, no stray debug, no non-text bytes). 275 tests, green on Node 22 and 24.

## v0.14.1 — 2026-06-16

Test-only hardening — no behavior or API change.

- Locked the `assessDelta` degenerate-input boundaries that protect a keep/evict
  verdict from a divide-by-zero `NaN`: a single comparable task yields a finite
  point estimate with null standard error (the `savings.length >= 2` guard), and
  no comparable task yields a null delta rather than `NaN`. An audit confirmed
  the verdict math is otherwise free of divide-by-zero / `NaN` paths.
- 275 tests, green on Node 22 and 24.

## v0.14.0 — 2026-06-16

Hardening and simplification release — no new commands; existing behavior is
unchanged except that the inter-agent approval prompt is now injection-proof.

- **Security: `gate.ts` approval prompt is sanitized.** The PreToolUse prompt
  for an inter-agent `SendMessage` interpolated the sender, recipient, and
  message body. A hostile teammate message could embed ANSI/control sequences
  to forge or obscure the line the user approves. Every interpolated field now
  passes through the shared sanitizer (control/ANSI stripped, agent names
  capped); the forged-newline and escape-sequence vectors are closed.
  Verified end-to-end.
- **New `src/sanitize.ts`** — `displayText` extracted into a single
  presentation-security chokepoint, used by `status`, `compare`, `attribute`,
  and `gate`; `attribute`/`compare` no longer import it from the heavier
  `status` module.
- **Fixed: NUL bytes in `attribute.ts`.** `aggregateToolCosts` keyed its map
  with NUL-delimited strings (literal `\x00` baked into the source) — invisible,
  collision-prone, and treated as binary by tools. Replaced with a
  collision-proof `JSON.stringify` key. New `test/source-hygiene.test.ts` fails
  the build on any NUL/disallowed control byte in `src/` or `test/`.
- **Simplification:** the run-total token sum is centralized in one
  `RUN_TOTAL_TOKENS_SQL` constant (was hand-written 10×); the duplicated
  candidate/re-audit verdict-decide path in `select.ts` is one `decide` helper.
  Both behavior-preserving.
- Added tests for `parseAgentDefinition`'s memory-scope isolation (benchmarks
  never touch real agent-memory). 273 tests, green on Node 22 and 24.

## v0.13.0 — 2026-06-15

Skill / MCP cost attribution (roadmap #5) — **#5 complete.** Decomposition, not
a verdict: it answers "where did the tokens go?" by attributing each real-work
session's footprint to the tool, skill, or MCP server that produced it. Fully
orthogonal to the selector/benchmark path — it never promotes, evicts, or
measures a rule.

- New `src/attribute.ts` (`npx tsx src/attribute.ts`) renders a cross-session
  rollup of tool/skill/MCP cost, or a single transcript with `--transcript`.
  Filters: `--agent`, `--kind builtin|mcp|skill`, `--limit`, `--json`. New
  `/warden-attribute` command.
- `src/transcript.ts` now joins each `tool_use` to its `tool_result` by id in
  the existing single streaming pass, capturing the input chars the model
  generated and the result chars the tool injected back into context. Exposed
  as `toolEvents` on `ParsedRun`; the hot Stop-hook budget is unchanged
  (one pass, O(tool calls)).
- `src/db.ts` migration #8 adds a `tool_costs` table; `src/collect.ts` persists
  per-session costs inside the existing fail-open block (real-work only —
  golden runs are never attributed). `/warden-status` gains a top-costs section.
- Footprint is measured in characters (exact, deterministic); a rough ≈tokens
  figure (chars ÷ 4) is shown for intuition, not as a billed token count.
- Hardening from an adversarial review: a `tool_result` content array with an
  odd sibling (a bare string, an image block) no longer zeroes the whole
  result's footprint — each element is read defensively. `--json` is documented
  as the raw, unsanitized machine-readable path.
- 219 tests (+55), green on Node 22 and 24.
- Roadmap status: of the six directions, #1, #2, #3, #4, #5 (plus automated
  prompt evolution) are shipped; only #6 (rule marketplaces) remains.

## v0.12.0 — 2026-06-15

Team-shared rule ledgers (roadmap #3), increment 3: the CI gate — **#3 complete.**

- New `src/verify-ledger.ts` (`npx tsx src/verify-ledger.ts [file...]`) validates
  committed `.warden/*.rules.md` ledgers and exits non-zero if any is corrupt
  or hand-edited, so a CI job can gate the PR. Deterministic and offline —
  spends no model tokens and needs no secrets; reuses increment 2's
  `parseLedgerFile`.
- A deeper gate that re-benchmarks each rule's claimed delta in CI is possible
  but requires a model-token budget and credentials, so it is a documented
  deployment choice rather than a default.
- Roadmap status: of the six directions, #1, #2, #3, #4 (plus automated prompt
  evolution) are shipped; #5 (skill/MCP cost attribution) and #6 (rule
  marketplaces) remain.

## v0.11.0 — 2026-06-15

Team-shared rule ledgers (roadmap #3), increment 2: import + re-verify.

- New `/warden-adopt --from <path>` and `src/adopt.ts` read a shared ledger
  (from `/warden-share`) and queue its rules as **candidates** locally. The
  foreign measured delta is discarded and the context rent is recomputed
  locally, so by invariant #1 an adopted rule is never injected into memory
  until the local selector re-measures it on this machine's golden suite —
  "measured, not claimed" holds across machines. Near-duplicates of any
  existing rule (active/candidate/evicted) are skipped, so a rule already
  falsified locally cannot be re-adopted; re-adopting is idempotent.
- **No new trust path:** an adopted rule is just a candidate, so the entire
  existing selector (including the variance-conservative verdict) decides its
  fate unchanged. The ledger JSON is zod-validated; control-char rule bodies
  and malformed/missing blocks are rejected.

## v0.10.0 — 2026-06-15

Team-shared rule ledgers (roadmap #3), increment 1: export.

- New `/warden-share <agent>` and `src/share.ts` write an agent's active rules
  — body, measured token delta, context rent, and provenance — to a committed,
  reviewable artifact (default `.warden/<agent>.rules.md`): a human-readable
  bullet list plus a machine-readable JSON block that round-trips, so a PR
  adding a rule arrives with its proof and a later import can re-verify it.
- **Read-only and zero-coupling by design**: it only reads the rule ledger and
  writes a file, so it cannot affect the collect/distill/select loop. The
  risky part — importing a foreign ledger — is deferred precisely because a
  shared delta must be re-measured on the importer's own suite, never trusted.
- Also: un-exported 7 internal-only symbols across distill/gate/select/evolve
  to tighten the module API surface (no behavior change).

## v0.9.1 — 2026-06-15

Documentation fixes (no code changes).

- **Roadmap de-drifted.** Model-migration benchmarking, prompt A/B testing, and
  cost-anomaly alerting were still listed as future "bigger directions" while
  already shipped (v0.5/v0.6/v0.9). Removed them, and collapsed the
  ever-growing "shipped since v0.1.0" list into a one-line pointer to this
  changelog — the canonical record of what shipped — so the two stop drifting.
- **Testing section** wording corrected: the CI badge shows pass/fail, not a
  test count; the prose now gives an approximate count and says so.

## v0.9.0 — 2026-06-15

Real-time cost anomaly alerting (roadmap #4).

- The `Stop` hook now flags a session that ends unusually expensive for its
  agent — total tokens ≥ 2× the agent's recent median, given ≥ 5 prior
  sessions — with a one-line heads-up to the user via `systemMessage`
  (informs the human; does not feed the model, so no behavioral loop). A
  higher bar than the distiller's p75 trigger, so alerts stay rare and
  meaningful. Fires on the main session only (subagent events are
  mid-conversation); opt out with `TOKEN_WARDEN_NO_ALERTS=1`.
- Fail-safe like the rest of the hook: any error leaves the session
  untouched and emits nothing.
- Fix: `collect.ts` now guards its top-level `main()` behind an
  invoked-directly check (like every other CLI module), so importing it to
  unit-test `detectAnomaly` no longer executes the hook (which blocked on
  stdin). No runtime change to the hook itself.

## v0.8.0 — 2026-06-15

Security hardening of the v0.6/v0.7 features (from a pen-test pass) and a
variance-conservative rule-promotion algorithm.

### Security

- **Prompt evolution: `description` is now a protected frontmatter field** — a
  proposed variant changing it (which controls when Claude delegates to the
  agent) is delegation-scope drift and is rejected before measurement,
  alongside name/tools/model/memory.
- **Proposal bodies with control/escape characters are rejected** rather than
  written to disk (terminal-escape hygiene).
- **Comparison-report labels are sanitized.** Model ids and variant filenames
  flow into the report that the slash commands relay into the model's context;
  control/ANSI characters and newlines are now stripped so a crafted label
  cannot inject fake report lines (the report-injection class the v0.4.0 audit
  fixed for `/warden-status`).

### Algorithm

- **Variance-conservative rule promotion.** A candidate whose measured savings
  stay within one standard error of the 2×-rent threshold after the top-up
  budget (`uncertain`) is now **evicted, not activated** — a rule pays context
  rent in every future session, so promotion requires confidence it clears the
  bar, not a point estimate that merely lands above it. Re-audit of an
  already-active rule keeps the gentler point-estimate test, so one noisy
  re-measure does not churn out a good rule. Clear, low-variance wins are
  unaffected.

## v0.7.0 — 2026-06-15

Automated prompt evolution: propose a token-cheaper rewrite of an agent's
prompt, measure it, and recommend it only if it provably wins.

- New `/warden-evolve <agent>` and `src/evolve.ts`. One model call proposes a
  tighter variant of `agents/<name>.md` (protected frontmatter —
  name/tools/model/memory — enforced unchanged; rejected before measurement
  otherwise), the variant is benchmarked against the shipped prompt through the
  shared engine, and a measurable winner (no regressions, beyond noise) is
  written to `~/.token-warden/proposals/` with a recommendation. **Never
  auto-applied** — the agent files are committed source and three golden tasks
  cannot fully capture an agent's behavior, so a human reviews and applies.
- Consolidated the duplicated comparison orchestration (run both sides + the
  variance top-up loop) into `runComparison` in `compare.ts`; `modelbench.ts`
  and `promptbench.ts` now share it, and `reportMetaCost` moved there too. No
  behaviour changed.

## v0.6.0 — 2026-06-14

Prompt / agent-definition A/B testing (roadmap #2): measure a proposed edit to
an agent's system prompt instead of guessing whether it helps.

- New `/warden-promptbench <agent> --variant <file.md>` and `src/promptbench.ts`.
  Runs the agent's golden suite under the shipped definition (baseline) and a
  variant agent file (candidate), holding the agent's active rules AND model
  constant so only the prompt varies. A winning variant is reported, not
  auto-applied.
- **Extracted the comparison engine into `src/compare.ts`** — the
  processing-token verdict, variance top-up, per-task report, and caveats are
  now shared by model and prompt benchmarking. `modelbench.ts` became a thin
  consumer; no behaviour changed (the core's tests moved with it).
- New `RunConfig` value `'promptbench'`; the status golden-run count now
  whitelists history configs (`active`/`candidate`/`audit`) so any A/B
  comparison kind is excluded automatically.
- `parseAgentDefinition` and a `definitionOverride` on `SuiteOptions` let
  `runSuite` run an arbitrary agent definition (the seam prompt-bench varies).

## v0.5.0 — 2026-06-14

Model-migration benchmarking (roadmap #1): "is model B cheaper than model A on
this agent's workload?", answered with the same measured rigor as rule selection.

- New `/warden-modelbench <agent> --model <id> [--baseline <id>] [--runs N]`
  and `src/modelbench.ts`. Runs an agent's golden suite under two models with
  the agent's active rules held constant, so only the model varies.
- Verdict uses **processing tokens** (input + output + cache_creation), not the
  raw four-component total — cache-read tokens (cheap re-reads, dominant in the
  sum, partly a scheduling artifact) distort a cross-model comparison and are
  reported separately instead. No dollar conversion (models are priced
  differently per token).
- Reuses `runSuite` (via a new optional `model` override) and the selector's
  `assessDelta`/variance top-up; `compareRuns` is a pure, fully unit-tested
  core. Runs recorded with `config='modelbench'`, isolated from baselines,
  learning curves, p75, and golden-run counts.
- Schema migration 7: nullable `runs.model` column (forensic provenance;
  populated for all golden runs).

## v0.4.1 — 2026-06-13

Dependency reconciliation after the first Dependabot batch.

- Merged `actions/setup-node` v5 → v6; verified main builds clean under the
  TypeScript 5.9 → 6.0 and `@types/node` 24 → 25 major bumps that landed
  alongside it (typecheck exit 0, 120 tests pass).
- Migrated `biome.json` to the 2.5.0 schema (`preset: "recommended"` replaces
  the deprecated `recommended` field) — the biome 2.5.0 bump had left the
  config drifting and printing lint infos on every run.
- README roadmap refreshed: subagent collection moved to shipped; added a
  "Bigger directions" tier (model-migration benchmarking, prompt A/B testing,
  team-shared rule ledgers, real-time cost anomaly alerting).

## v0.4.0 — 2026-06-12

Full-repo audit (two parallel review agents + live verification). Headline fix:
**subagent sessions are now collected** — previously only the main session's
`Stop` hook was registered, so the four domain agents' real work never reached
the ledger and the learning loop could not engage on real work at all.

- `SubagentStop` hook: derives the subagent's sidechain transcript from the
  parent path (verified live), records it under a `session#agent_id` key, and
  never double-counts when no sidechain exists.
- Distillation correctness: domain agents only (others are unmeasurable), p75
  priors computed over real-work runs only, and at most one distillation per
  run (Stop fires every turn and previously could spawn a haiku call per turn).
- Bench: golden runs can no longer trigger a globally-installed plugin's own
  distiller (`TOKEN_WARDEN_NO_DISTILL` set in the spawn env); `--agent all
  --task` rejected up front; variance warning now works for any n≥2 runs.
- Hardening: `WARDEN_SESSIONS_PER_WEEK` validated; NULL projects no longer
  silently dropped from per-project curves; status CLI error handling; dead
  exports removed.
- Infra: vitest 4 (0 npm-audit findings, was 5 high), Biome pinned, Node ≥22
  (20 is EOL), CI concurrency + timeouts, Dependabot (fixture excluded —
  frozen by design). README staleness fixed (test counts, ToC, module table).

## v0.3.0 — 2026-06-12

Cross-project learning curves — the test of the system's core thesis: do
golden-suite gains transfer to real work?

- `/warden-status` now charts **average completed real-work session cost per
  ruleset version**, per domain agent and per project (top 5 by volume), with
  the percentage change since the first version, e.g.
  `sql: v0 48,770 (n=3) → v2 31,002 (n=5)  [-36.4% vs v0]`.
- Methodology: completed sessions only (invariant #3), golden runs excluded,
  and `main` excluded — compiled rules never apply to it, so including it
  would only add noise.

## v0.2.4 — 2026-06-12

Memory optimization of the transcript hot path (runs on every session end).

- **Streaming transcript parser**: `collect.ts` now parses the transcript file
  line-by-line (`parseTranscriptFile`) instead of reading it whole. Measured on
  a 29 MB / 70k-entry transcript: **RSS 175 MB → 84 MB (−52%)**, heap
  38 MB → 11 MB, 0.44 s wall — well inside the 2 s hook budget. The string and
  streaming parsers share one accumulator and are tested to produce identical
  results.
- The per-message usage map now stores only the four token counters instead of
  the full loose-parsed usage objects (which retained every unknown transcript
  field).
- `digestTranscript` buffers are bounded as lines are fed — O(maxChars) memory
  regardless of transcript size, instead of accumulating every line before
  truncating.
- Line iteration no longer materializes a split() array of all lines.

## v0.2.3 — 2026-06-12

Residual-risk hardening (see README "Security notes").

- **Prompt-injection defense in depth**: the distiller rejects rule bodies
  containing control characters or newlines; `renderStatus` sanitizes every
  untrusted string it displays (ANSI/control stripped, newlines collapsed,
  length clamped) so collected data cannot forge report sections; the
  `/warden-status` command instructs the relaying model to treat report
  contents as data, never instructions.
- **Bench suites survive broken runs**: a crashed `claude` invocation,
  vanished transcript, or timeout is recorded as a failed result
  (`RUN-ERROR`) and the suite continues instead of aborting.
- **Explicit POSIX guard**: `bench` and `select` fail fast on Windows with a
  WSL pointer instead of cryptic downstream errors; requirement documented.

## v0.2.2 — 2026-06-12

Hardening fixes from an adversarial test pass.

- **Gate: stored question bodies are capped at 2,000 chars.** A single huge
  `SendMessage` body (tested at 5 MB) was persisted whole into the questions
  ledger; insert and approve now truncate identically so pending-row matching
  still works.
- **Parser: UTF-8 BOM tolerated** — a BOM-prefixed transcript no longer counts
  its first line as malformed.
- Verified under attack and unchanged: corrupt/garbage DB file, read-only data
  dir, directory-as-transcript, future-schema DB (plugin downgrade), 10
  concurrent Stop hooks on one DB, SQL/shell/path-traversal strings in payload
  fields, CRLF+emoji transcripts, 8 MB transcript in 0.25 s, missing `claude`
  binary (distiller fails open), corrupt DB at session start (notifier stays
  silent).

## v0.2.1 — 2026-06-12

Repo hygiene and CI release.

- MIT `LICENSE` file, `CHANGELOG.md`, and full package metadata
  (license/author/repository); GitHub description and topics set.
- GitHub Actions CI: typecheck, lint, and tests on Node 20 and 24, plus the
  fixture's own suite; `actions/checkout@v5` and `actions/setup-node@v5`.
- Lint fix surfaced by CI's clean install: replaced a value-returning
  `forEach` callback in a test with `for…of`.
- README badges (CI, license).

## v0.2.0 — 2026-06-12

- **Variance-aware verdicts**: the selector computes the standard error of per-task
  savings and spends a bounded top-up measurement pass (`--top-up`, default 1) when a
  verdict is within one SE of the keep/evict threshold; verdicts still within noise are
  recorded with a low-confidence annotation.
- **`/warden-select` command** and a `SessionStart` nudge that surfaces pending
  candidates without auto-spending benchmark tokens.
- **Question-driven distillation**: an agent's recent cross-agent questions are fed to
  the distiller as a memory-gap signal.
- **Per-project tracking** (`runs.project`, migration 6) with a per-project token
  breakdown in `/warden-status`.
- **Rule provenance**: active rules show the run they were distilled from.
- Self-hosted marketplace (`/plugin marketplace add vukkt/token-warden`) and a
  dependency-bootstrapping Stop hook for cache installs.

## v0.1.0 — 2026-06-12

Initial release. All five build phases of the original specification:

- **Collector**: Stop-hook transcript ingestion into SQLite (usage deduplicated by
  message id; never blocks a session).
- **Agents + benchmark system**: four domain subagents (`frontend`, `backend`, `sql`,
  `testing`), a frozen full-stack fixture repo, three golden tasks per agent, and a
  headless benchmark runner with permanently frozen first-run baselines.
- **Distiller + selector**: p75-triggered candidate generation (haiku, strict JSON,
  trigram dedupe) and measured keep/evict decisions (savings ≥ 2× context rent) with
  round-robin re-audit and wholesale `MEMORY.md` compilation.
- **Visibility**: `/warden-status` and `/warden-bench` with meta-cost reporting.
- **Inter-agent approval gate** on `SendMessage` (Agent Teams, experimental) with a
  logged question ledger.
