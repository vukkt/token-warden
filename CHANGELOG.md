# Changelog

## Unreleased

### One keep-bar, and one way to write a log line

Two duplications where the copies had already started to matter.

**The keep-bar.** `2 * effectiveRent(...)` was written out ten times across
`select.ts` and `power.ts`, plus five more in `validation/`. No copy was wrong.
The hazard is that the PLANNER (`power.ts`, which tells you how many runs a
comparison needs) and the GATE (`select.ts`, which decides) have to agree on the
bar exactly; a drift between them would have surfaced as a plausible-looking run
count rather than an error. Now `keepBar()` in `stats.ts`, one definition.

The `test/` sites still spell it `2 * effectiveRent(...)` on purpose. If the
tests adopted the helper too, a wrong helper would satisfy its own tests — the
expectations stay independent, and `keepBar` is pinned separately against the
definition it replaced.

**Log rotation, and log sanitizing.** Five modules had grown their own
`logLine`, and the copies had diverged on the two things that matter:

- Only `gate.ts` rotated. `collect`, `distill`, `evolve` and `notify` grew
  without bound in the user's `~/.token-warden` directory, and `collect.log` is
  the highest-frequency writer of the five — a line every session, whether or
  not anything happened.
- `collect`, `distill` and `evolve` flattened the line through `displayText`;
  `gate` and `notify` did not. Every one of these logs interpolates untrusted
  text: session ids, paths, transcript-supplied agent names, error strings,
  model output. A newline in any of them forges a second timestamped entry,
  which was PROVEN exploitable against `distill.log` before that copy was fixed.
  So `gate.log` and `notify.log` were the sixth and seventh instances of the
  same contract gap v0.45.0 closed elsewhere.

`src/logfile.ts` now does mkdir, rotate, sanitize and append in one place, and
all five delegate to it. Both properties hold by construction rather than by
five authors remembering them.

Rotation is 1 MiB keeping ONE generation — breadcrumbs, not an audit trail; the
ledger is the audit trail and it is a database. The `statSync` costs one syscall
and is safe inside the Stop hook's sub-2-second budget, which `collect.ts`
already demonstrates by stating the transcript on the same path.

Both guards verified by watching them fail: disabling rotation fails two tests,
removing the sanitize call fails three.

## v0.45.0 — 2026-08-15

### CORRECTION: retrieval cost was under-priced by a fifth; the ratio is 4.4x, not 3.7x

`Retrieval.tokens` summed the retrieved chunk BODIES. What the pipeline actually
sends is `renderContext()`, which prefixes every chunk with
`[chunkId] — section > path`. That label is not decoration: it is the handle a
citation must quote, and `extract.ts` rejects any fact whose citation does not
resolve — so it could not be dropped to close the gap. It was real context that
nothing priced, by **17.6% to 20.8%** depending on the arm.

The consequence was worse than the reported numbers being low. `underBudget`
packed against the same unpriced metric, so the assembled context **exceeded its
stated budget on 12 of 12 questions, in every arm, at every swept budget**. The
budget was a bound on chunk text, not on context.

Both now derive from a single `renderChunk`, so the packer prices exactly what
the renderer emits and the two cannot drift apart by editing one of them.

**Fixing it forced a second fix.** Packing against honest costs made recall
NON-MONOTONE in budget — 78% at 400 tokens falling to 67% at 600 — because the
packer skipped past a chunk that did not fit and took smaller ones after it, so
a larger budget could drop a chunk a smaller budget had kept. `sweepBudgets`
exists to locate a knee, and a curve that can fall as its input rises has no
well-defined knee: the headline would depend on which budgets happened to be
sampled.

The packer now takes a prefix and stops. That is forced, not preferred:
monotone recall requires the selected sets to NEST as the budget grows, and a
nested family under a fixed score order is exactly the set of prefixes of that
order — so "monotone AND budget-filling" was never available to choose. The cost
is paid knowingly: below the knee it leaves room unused and retrieves less (67%
rather than 78% at 400 tokens). At the knee it is strictly better on both axes,
reaching 100% recall for 1,281 tokens against 1,393.

Re-pinned, all measured on the bundled suite:

| figure | was | is |
|---|---|---|
| knee | 1,200 tok/question | **1,400** |
| mega-prompt ratio | 3.7x | **4.4x** (`bm25`), 4.3x (`section`) |
| recall floor at 200 tok | 22% | **11%** |
| mega-prompt cost | 4,474 tok | **5,648** |

The ratio ROSE because the mega-prompt's own cost was understated by more than
retrieval's — it carries every chunk, so it carries every label.

The test that pinned the gap was written to fail when the gap CLOSED, and it
did. It is now two tests: one asserting reported cost equals sent cost on every
arm, one asserting the budget is a real bound. `test/retrieve.test.ts` also pins
the nesting property directly, so a future packer that fills better but drops a
previously-kept chunk fails on the invariant rather than on a moved number.

### The sanitizer's contract is now enforced by construction, not by discipline

`sanitize.ts` opens by calling itself "the single chokepoint every model- or
environment-derived string must pass through before it is rendered into a
report, a log line, or a user-facing permission prompt." The contract was
documented, real, and honoured by `status.ts`, `scope.ts` and `collect.ts` — and
violated in seven other places. Those violations were found across two audit
passes by six agents working independently, none of whom could see each other's
findings. Six independent rediscoveries of one rule is not six mistakes; it is a
rule that cannot be held by discipline.

The last three are closed here. `select.ts` rendered the rule body raw in the
SELECTOR'S OWN decision report — the one place a reader looks to see what was
kept and what was evicted, so a body carrying a newline forged an extra decision
row exactly where it would be believed. `compress.ts` printed the model's
rewrite raw on both the dry-run and the queued path.

`test/sanitize-contract.test.ts` now requires every interpolation of a
model-derived field in `src/` to pass through `displayText` (or `truncateBody`,
a wrapper over it) at the call site, or to appear in an allowlist **with a
stated reason**. There are five entries, each naming why the text is not a
render: prompt bodies that must reach the model verbatim, `distill`'s arguments
to `logLine` which sanitizes at the sink, `memory.ts` compiling MEMORY.md where
the body IS the payload the agent loads, and `compress`'s `bornDigest` which is
persisted rather than printed. The allowlist is the thing a reviewer has to
argue with — the same device `golden-checks.test.ts` uses for its known-vacuous
checks. An entry that stops matching a live site fails too: an exemption that no
longer applies is a licence nobody revoked.

Verified by WATCHING IT FAIL, not merely by passing. Reintroducing the
`select.ts` violation into real source produces `select.ts:2031 in
decisionLine() renders ${decision.rule.body} without displayText`. A guard
nobody has seen fail is not yet a guard — the same standard applied to the
validation-import guard in v0.44.0.

It caught its own false positive during development: `protect.ts`'s fallback
string `?? "does not meet the rule body contract"` matched on the word *body*
inside a string literal rather than a field read, so the matcher now strips
quoted text before testing.

Deliberately narrow. This is a source-text guard, not a taint tracker: it cannot
follow a body through a variable, an array, or a helper. It catches the shape
all seven real violations actually took — a tainted field interpolated directly
into a rendered string — so a failure is always a real finding rather than noise
to be silenced.

## v0.44.0 — 2026-08-14

### CORRECTION: the retrieval headline was 11.2x and is 3.7x

v0.42.0 published `section` retrieval matching mega-prompt recall from 400
tokens/question, 11.2x cheaper, with `bm25` at 600 and 7.5x. Both figures were
wrong, and the fault was in the SCORER, not the retriever.

`valueAppearsIn` decides whether a strategy put the answer into the context, so
it is the sole source of every recall number in this feature. It built its
trailing-zero variants with `n.toFixed(dp)` under the guard `n >= 10 ** -dp`.
`toFixed` pads and rounds, and nothing separated the two — so the accepted set
contained every rendering a value ROUNDS to. That is a half-unit-in-the-last-place
tolerance window sitting inside the one function DECISIONS.md says has none.

Against the bundled corpus it was scoring `3.25` as retrieved from "compared with
**3.0x**", `3.75` from "repurchased **4.1 million shares**", and a `14.5%` segment
margin from "roughly **15 to 18**" distribution centres. In each case the literal
value was absent from the retrieved context.

Corrected: the knee moves 400 -> **1,200 tokens/question** and the ratio
**11.2x -> 3.7x** (`bm25`'s 7.5x moves to 3.7x as well). `section` no longer beats
`bm25` — they tie, and below the knee `section` is briefly worse. The "87.5% doc
recall" asterisk disappears, because at the true knee both lexical arms retrieve
every required document. Every correction is unfavourable to retrieval.

Fixed by keeping a rendering only when `Number(n.toFixed(dp)) === n`. All eight
pre-existing `valueAppearsIn` tests still pass unchanged, which is the point: they
used values whose rounded forms did not happen to appear in their fixtures.

**Nothing had pinned any published number.** `sweepBudgets` was tested for
monotonicity and for the existence of a knee, never its value. `test/ragbench.ts`
now pins the knee, the 22% floor at 200 tokens and the `section`-is-not-better
ordering; `test/extract.test.ts` pins the three real false positives.

### Documentation brought back to the evidence

- **README and ROADMAP said end-to-end accuracy "has never been run".** It has —
  four burns on 2026-07-28, recorded in FINDINGS.md at the time, in a commit that
  updated FINDINGS and nothing else. What is genuinely unestablished is narrower
  and is now stated as such: there is no accuracy RANKING between the four arms.
- **`fin-07` is described as the question lexical retrieval fails.** It does not
  fail, at any budget at or above the knee. The suite therefore contains no case a
  semantic retriever would win, which is now the first work item under hybrid
  retrieval rather than an unstated gap.
- **`expectConflict` is inert.** `fin-05` claims to be "scored on whether BOTH
  sources are cited"; nothing reads the flag, and end to end any single grounded
  fact marks the row correct. Named in `scoreAnswer` and in ROADMAP rather than
  tightened silently, since changing it would move an accuracy figure no re-run
  exists to re-establish. `benchmarks/finance/` is byte-identical: benchmark data
  is frozen and amended by addition, and the 2026-07-28 burns ran against exactly
  these twelve questions.
- The retrieval limitation is now listed under README *Limitations* with the
  corpus size (5 documents, 4,474 tokens) attached.

### `/warden-dogfood` — the production window is now observable

ROADMAP section 1 (the production dogfood window) had shown no progress since
June 2026, and the reason was not effort. Every real-work session in the ledger
is recorded under `main` or an ad-hoc subagent type, and `collect.ts` gates the
distiller spawn on `knownAgents()` membership, so all nine of them are INERT:
billed and stored, but unable to produce a candidate rule. Nothing in the
product said so — `/warden-status` even prints a `main` row in its summary
table — so a window that never started looked exactly like one that was running.
Collection had additionally recorded nothing for 61 days, which no command
reported either.

`npx tsx src/dogfood.ts` (`/warden-dogfood`) answers, read-only and free:
collection liveness (LIVE / IDLE / STOPPED / NEVER-RECORDED, from the freshness
of the newest real-work row — there is no hook heartbeat and `collect.log` is
append-on-exception); real-work sessions per agent with date ranges; which
agents can trigger distillation and which are INERT; how many more completed
sessions each known agent needs before the p75 trigger arms, and the token
threshold once it has; whether `TOKEN_WARDEN_NO_COLLECT` / `TOKEN_WARDEN_NO_DISTILL`
are switched on and whether the hook dependency marker exists; and exactly ONE
next action.

The readiness figures come from the distiller's own `MIN_PRIOR_RUNS`,
`ROLLING_WINDOW` and `p75` rather than a second copy, and the printed threshold
is re-checked against the live `shouldDistill` predicate before it is shown — a
mismatch prints a `WARNING:` instead of a number the gate does not agree with.

**`main` is deliberately not admitted to distillation.** A `main` rule has no
golden suite to be measured on and no agent-memory file to be installed into
(the bundled agents get `~/.claude/agent-memory/<agent>/MEMORY.md` because they
declare `memory: user`; the main thread's equivalent is `CLAUDE.md`, which this
project never writes). The supported path for a real workload is BYOA. See
DECISIONS.md.

### One bug fix, and one roadmap item closed by measuring its premise

**`bench.ts`: a zero-token run is never a completed measurement.** `runOnce`
took the success check at its word, so on a task whose check passes on the
PRISTINE fixture (`sql-01`, `backend-03`) every quota-dead run was banked as a
free success. The live ledger holds 19 such rows on `sql-01`, dragging that
task's candidate-pool mean from 70,855 to 46,815 tokens. Worse, every
environment-failure guard — `isEnvironmentFailure`, `passEnvironmentFailure`,
the consecutive-streak abort — requires `completed = false`, so a quota death on
a vacuous task was invisible to all of them; and on an active pass one such run
would have frozen a 0-token `run1` denominator permanently. Fixed at the source;
`compare.ts` re-derives the same flag for rows written before the fix.
`isEnvironmentFailure` itself is deliberately unchanged (dropping its
`!completed` half breaks the calibration harnesses, which work at token scales
of hundreds by design). This connects the golden-check vacuity audit to the
v0.38.0 abort guard, which had been treated as unrelated.

**New: `validation/variance-decomposition.ts`** — zero tokens, ledger opened
read-only. It recovers replicate pools the existing tooling could not see (an
A/B burn records both arms under `config='candidate'` at the same ruleset
version, so a group must also be a contiguous block of one task's runs), scores
three metrics side by side, and plans burns through the shipped
`src/power.ts` estimators rather than a second copy.

**ROADMAP's "cut golden-suite variance further" is CLOSED as not achievable
that way.** The premise was that specific tasks are noisy and narrower
replacements would quiet the suite. Measured, it is false: the run's
`tool_calls` count explains **94.6%** of the within-task spread, and its CV is
flat at 22.4%-42.0% across tasks whose mean turn counts span 3.8 to 13.3 — the
spread belongs to the agent, not to any task. At a fixed 6M-token budget,
discarding four of seven tasks moves the gate's statistic from 0.97 to 1.78
against the 2.84 it needs, because a dropped task takes its signal with its
noise. The compression A/B's "re-open when variance comes down" clause is
withdrawn: that route needs 49.2M tokens on the gate's metric, 16M on the
narrowest possible suite, and a quieter metric makes detectability worse.

Every published figure is pinned in `test/variance-published.test.ts` against a
frozen extract of the runs it came from, so the document cannot drift out of
agreement with the estimators.

### Rules the gate could not resolve are no longer excluded for life

An evicted candidate now records WHY it was evicted. `underpowered` means the
point estimate cleared the 2x-rent bar and reached at least half the confidence
margin promotion demands, so only the WIDTH of the measurement stopped it —
the hypothesis was never actually tested. Everything else (sub-threshold,
non-positive, regression, environment failure, re-audit) is unchanged and
still final.

The distiller's trigram dedupe stops suppressing those bodies. A re-proposal is
queued as a fresh CANDIDATE pointing back at the eviction it re-tries: measured
from scratch, on its own baseline, never re-banked on the old numbers. It is
HELD, costing nothing, until an invocation brings more runs per side than the
measurement that could not resolve it, and it must then clear the bar by 1.5x
the ordinary margin.

Why this matters: FINDINGS has measured the Type II tail at an order of
magnitude above the Type I tail since v0.42.0 — a rule genuinely saving 2% of a
run is evicted 70-78% of the time — while the dedupe made every one of those
evictions permanent.

**Measured before shipping** (`validation/empirical-calibration.ts --mode
recovery`, zero tokens, `sql` pool, 20,000 trials/row, three seeds):

| True saving | control | with recovery | difference |
|---|---|---|---|
| 0 (false positives) | 10.7% | 10.8% | **+0.08pt** |
| 10% | 34.1% | 36.5% | +2.46pt |
| 20% | 69.4% | 78.7% | **+9.30pt** |

A second look cannot be free — total risk is `p + P(zone|H0)·p2` — so this is
reported as the increase it is: 0.75% relative, buying 13.4% relative power on
the 20% row, a marginal ratio of 116:1 against the gate's own 6.5:1. The
equal-depth variant (+0.48pt for less power) and the no-extra-strictness variant
(+0.50pt) were both measured and rejected; see FINDINGS.md.

`/warden-status` marks such evictions `[UNDERPOWERED: not falsified,
re-measurable at >N runs/side]`, and `/warden-select` reports any recovery
attempt it held and the `--runs` value that would release it.

- Migration #18: `rules.underpowered`, `rules.recovery_runs`, `rules.recovers`.
- `WARDEN_RECOVERY_MARGIN` (0.5) and `WARDEN_RECOVERY_STRICTNESS` (1.5) expose
  the two tuned parameters; both reject out-of-range values rather than
  clamping, and both are pinned by tests.
- Underpowered evictions are also removed from the distiller's negative-feedback
  block, which told the proposer "measured and rejected, aim at a bigger waste
  source" — the wrong lesson from a large-but-unresolvable effect, and a
  contradiction of the dedupe now letting the body through.



## v0.43.1 — 2026-08-05

Verification and documentation only. No behaviour change: the gate, the
estimators and the retention budget are byte-identical to v0.43.0.

### The golden-check vacuity audit is finished, and now enforced

A `success_check` that passes on the PRISTINE fixture — before any agent has
touched it — is a dead sensor: it cannot detect a regression, and because a
quota-dead run on it records `completed = true`, it is invisible to the
environment-failure discriminator as well. v0.40.0 found two by hand
(`sql-01`, `backend-03`) and ROADMAP left the remaining checks open.

All 21 bundled checks have now been EXECUTED against an untouched fixture,
replicating `bench.ts`'s real invocation (same copy filter, `node_modules`
symlink, `bash -c`, allowlisted environment). **The suite is clean** — the only
checks that pass untouched are the two already known. A second, stricter pass
confirmed no check hides a vacuous *behavioural* clause behind a trailing
`npx vitest run`, a shape that cannot distinguish "the agent did the thing
asked" from "the agent did not break the existing tests".

**The suspicion recorded in ROADMAP about `sql-05` was wrong.** It claimed that
guard "also passes pristine". Executed, its grep exits 1: it requires an index
on `created_at`, and the pristine schema indexes only `products(name)`. The
suspicion had been formed by READING the grep — the exact mistake the audit it
annotated exists to warn about. Corrected.

`test/golden-checks.test.ts` enforces this on every CI run in ~0.5s, without
spawning a test runner: every bundled task must carry a non-test clause that
FAILS on the pristine fixture. Because a check is an `&&` chain, one failing
clause proves the whole check fails pristine, so the fast form is a sound proof
rather than an approximation. `sql-01` and `backend-03` are a named allowlist
whose vacuous state is PINNED — repairing one in place fails the test and forces
the add-don't-edit conversation, since editing them invalidates the frozen
`run1_tokens` baselines they still carry. The guard was verified by injecting a
vacuous check and confirming it failed before being committed.

### README

Brought to the tagged version: 1,235 tests across 53 files, 48 releases, 15.1k
source / 19.5k test lines. Its false-eviction headline moves 79.8% -> 78.2% (the
v0.43.0 correction) and now states plainly that the first figure was retracted
rather than quietly edited. Adds the two retention-budget designs that measured
to nothing, since that section is about the project's standard rather than its
metrics.

## v0.43.0 — 2026-08-03

The variance-proportional RE-AUDIT budget: the retention-side analogue of the
Neyman top-up the admission side has used since v0.24.0. v0.42.0 measured the
gate's Type II tail and concluded that recovery matters more than admission
precision; this is the first policy built on that conclusion.

### The policy

A re-audit that lands within noise of the bar now buys extra measurement rounds
when — and only when — noise, rather than the rule, is what threatens it. The
stake is the rule's banked margin over its own bar; the threat is the noise band
of the current draw at the gate's own confidence multiple. Their ratio sets the
budget, capped at two extra rounds (`MAX_RETENTION_ROUNDS`).

Nothing about the keep/evict inequality moves. The bar, the confidence multiple
and two-strike retention are untouched, a regression still evicts immediately,
and CANDIDATES get no retention rounds at all — admission is byte-identical to
v0.42.0. `--retention-rounds 0` restores the old behaviour as the control arm.

### Two designs measured and discarded before this one

Both would have shipped on intuition; the zero-token harness rejected both.

- **Extra rounds on the measured side only** — the shape ROADMAP itself
  proposed. Worth nothing (78.2% -> 79.1% false eviction at a 2% true saving) at
  2.2 extra passes per re-audit. The delta's error sums BOTH sides, so no budget
  spent on one side can cross the floor the frozen side sets. Retention rounds
  therefore re-measure both sides.
- **Neyman placement for those rounds** — the house style everywhere else in the
  codebase. Actively harmful: same tokens, uniform placement instead, and a 5%
  rule's false eviction falls 49.6% -> 29.3%, a 10% rule's 11.9% -> 2.0%. At 2
  runs/task the variance estimate carries one degree of freedom, so
  concentrating a round on "the noisiest task" chases an artifact. Retention
  rounds are placed uniformly; the first top-up keeps Neyman.

### Measured effect (sql pool, 2 runs/side, 12 re-audits, 3,000 trials, zero tokens)

| True saving | control | with budget | passes/audit |
|---|---|---|---|
| 2.0% | 78.2% | **70.3%** | 0.87 -> 2.37 |
| 5.0% | 53.8% | **32.5%** | 0.84 -> 2.22 |
| 10.0% | 16.3% | **5.4%** | 0.75 -> 1.62 |
| 20.0% | 0.2% | 0.3% | 0.48 -> 0.65 |

A rule genuinely saving 10% of a run is three times likelier to survive its own
re-audits. The 20% row is the control that should not move, and does not: a
decisively measured rule buys no rounds. It does not close the tail — a 2% rule
is still evicted 70% of the time, and suite variance remains the binding
constraint.

### Harness correction

`--mode eviction` decided every simulated re-audit on its first look, but
`measureWithTopUp` has always spent a top-up pass when the verdict lands within
noise. The v0.42.0 table therefore measured a stricter pipeline than the one
that ships; corrected control column 78.2% / 53.8% / 16.3% against the published
79.8% / 60.8% / 25.0%. The v0.42.0 conclusion survives, its magnitudes do not.
Same class of error as burn 1 of the RAG benchmark, and recorded as such in
FINDINGS.md.

### Repository

`withDb(body)` in `db.ts` replaces 21 hand-written `const db = openDb(); try {
... } finally { db.close(); }` blocks — the last open item from the v0.41.0
shared-module extractions, withheld then because it rewrites the BODY of every
call site rather than a uniform trailer. It sits beside `openDb` so no command
gained an import to adopt it. `collect` keeps its own `openHookDb` (shortened
`busy_timeout` so a contended write stays retriable inside the hook's budget).
The three read-only import allowlists that name the helper (`contradict`,
`cohort`, `confirm`) were updated deliberately: `withDb` is the same capability
as `openDb`, which is exactly what those tests exist to police.

Also: `DeltaAssessment` carries `confidenceMultiple` so the budget reasons about
the same noise band the gate does rather than forming a second opinion; the
receipt now records the reference side AS COMPARED, including retention runs;
`falseEvictionTrial` reports what a sequence cost in passes, not only whether it
survived. `--retention-rounds N` on both `/warden-select` and the harness.

## v0.42.0 — 2026-07-28

Two additions: the gate's unmeasured error tail, and a second kind of context
for the gate to measure.

### The false-eviction rate, measured

The A/A harness has published the gate's false-POSITIVE rate since v0.35.0
(8.8% empirical against a ~2.5% synthetic claim). Its false-NEGATIVE rate was
never measured, and ROADMAP explicitly forbade building eviction-recovery
machinery until it was — "guessing at the other tail is how the robust-SE
estimator got vetoed."

`validation/empirical-calibration.ts --mode eviction` closes it, at zero token
cost: resample the agent's own recorded runs, subtract a KNOWN true saving to
synthesize a rule that genuinely earns, and replay it through the real verdict
path for N consecutive re-audits carrying probation state. `twoStrikeRetention`
is now EXPORTED from `src/select.ts` and imported by the harness rather than
reimplemented, because a reimplementation is free to drift from the policy it
claims to measure.

On `sql`, 2 runs/side, 12 re-audits, 400 trials: a rule truly saving 2% of a run
is falsely evicted **79.8%** of the time. 5% -> 60.8%, 10% -> 25.0%, 20% ->
1.5%. **The Type II tail is an order of magnitude worse than the Type I tail.**
Two-strike retention holds — no trial ever evicted on cycle 1, asserted in test
— but it only buys delay; the median failure lands on cycle 4-7. The conclusion
is that recovery matters more than admission precision, and that the binding
constraint is suite variance rather than retention policy.

Also fixes mode gating: `--mode eviction` previously also ran the permutation
block, which tested `mode !== "bootstrap"`.

### Context architecture: retrieval as a second measurable context source

The project's one idea is that context must pay for itself. Until now the unit
was a memory RULE. A retrieved document chunk is the same kind of object — it
occupies context, it costs tokens on every call, and somebody is asserting
without evidence that it earns its place. So retrieval enters as a second
context source for the gate that already exists, not as a separate product.

New modules:

- `src/corpus.ts` — ingestion for md/txt/csv/html. Chunks on the document's own
  declared structure rather than fixed windows, because a fixed window severs a
  table from the header row naming its units and period, and an unlabeled number
  is not a fact. Every chunk carries a char span, which is what makes a citation
  checkable. Deterministic and model-free by requirement, not by thrift: the
  corpus is the ground truth extracted facts are checked against, so a
  model-produced span would make the check circular.
- `src/retrieve.ts` — `full` (mega-prompt), `bm25`, `section` (expand a hit to
  its whole section). Lexical, deliberately: financial questions turn on exact
  periods, and an embedding places "Q3 2023 revenue" and "Q3 2024 revenue" on
  top of each other. It is also zero-token and deterministic, so re-running last
  month's benchmark gives last month's retrieval. Stated cost: it misses
  paraphrase, and the suite includes a question it fails for that reason.
- `src/extract.ts` — structured extraction behind a GROUNDEDNESS gate. Every
  fact must cite a chunk and quote the span containing its value; the citation
  is then checked mechanically, without a model. Facts that fail are rejected
  and counted, never merely flagged. This converts fabrication from an invisible
  failure into a counted one. It does not prove correct INTERPRETATION — a value
  truthfully quoted from the prior-year column passes — and that limit is stated
  in the module rather than papered over.
- `src/interrogate.ts` — the multi-hop arm, bounded at 4 hops. Justified
  narrowly: it wins where the second query depends on the first result, and
  pays extra round-trips for nothing everywhere else.
- `src/ragbench.ts` — the comparison. Default mode is ZERO TOKENS, because
  whether a strategy put the answer in front of the model is decidable without
  calling one. `--yes` runs it end to end against a real model.

`benchmarks/finance/` ships a synthetic 5-document corpus and 12 golden
questions. Synthetic on purpose: no licensing or PII exposure, and no chance a
model answers a real 10-K from memory instead of from the context, which would
make the benchmark measure pre-training recall rather than retrieval.

First result (`npx tsx src/ragbench.ts --sweep`, zero tokens): `section`
retrieval matches the mega-prompt's recall from **400 tokens/question — 11.2x
cheaper** than carrying all 4,474; `bm25` from 600. Recall collapses to 44% at
200, so the knee is real. The caveat ships with the number: a 5-document corpus
is small enough that the mega-prompt is a legitimate architecture, and the
saving scales with corpus size while retrieval cost does not, so 11.2x is a
FLOOR for a real document set rather than a headline.

New command `/warden-ragbench`. 1,172 tests (up from 1,034).

## v0.41.0 — 2026-07-26

The deferred shared-module extractions from v0.40.0, plus a correction to that
release's notes.

**CORRECTION to v0.40.0.** Those notes claimed the SQLITE_BUSY session-loss bug
was fixed. It was not. The machinery (`isBusyError`, `withBusyRetry`,
`openHookDb`, the DROP marker) and its tests were written, but the interrupted
agent never connected any of it: `main()` still called plain `openDb()` and
`withBusyRetry` had zero call sites. Biome's unused-variable warning on the
orphaned helpers is what surfaced it. It is wired now, and verified the way it
should have been the first time — hold a write lock in a second process,
confirm it is held, fire the Stop hook: exit 0 and the row IS recorded, where
the pre-fix reproduction lost the session permanently.

**Extractions.** Six modules, each a pure move with unchanged bodies:

- `src/rules.ts` — the rule vocabulary: what a body IS (`ruleBodySchema`,
  `hasForbiddenChar`), what it COSTS (`contextCost`), when two are the same rule
  (`trigramSimilarity`). Every path that can put a rule in the ledger now shares
  one definition, which is what stops the drift that let the compression
  rewriter accept bidi overrides the distiller rejected.
- `src/model-call.ts` — the `claude -p --output-format json` envelope.
- `src/stats.ts` — estimators and gate parameters. This removes a real hazard:
  `sessionsPerWeek()` existed as two byte-identical copies, one feeding the
  2x-rent bar and one feeding the dollar projection, which had to agree by
  construction with nothing enforcing it.
- `src/format.ts` — `fmt` was defined seven times across six modules under one
  name with TWO contracts (rounded in three, unrounded in four), so the same
  mean rendered differently depending on which file you were in. The contracts
  are named separately rather than unified, because unifying them would silently
  change published figures.
- `src/memory.ts` — the single writer of agent memory.
- `src/cli.ts` — the entry boundary; `runCli` replaces a shim copy-pasted 25
  times. The four fail-open hooks deliberately keep their own: "exit 0 whatever
  happens" is different knowledge from "report and exit 1".

**Measured effect:** `select.ts` in-degree 4 -> 1 and 1875 -> 1684 lines;
`distill.ts` in-degree 7 -> 1; CLI shims 25 -> 6. Both were hubs by accident.

**Behaviour preservation** on the calibrated path was verified, not asserted: a
differential harness fingerprinted `verdict`, `verdictWithReason`,
`effectiveRent`, `confidenceZ`, `sampleVariance`, `pooledVariance` and
`assessDelta` over 300 randomized multi-task scenarios swept across
`WARDEN_CONFIDENCE_Z` x `WARDEN_SESSIONS_PER_WEEK` — 10,960 outputs, SHA-256
identical before and after.

Tests 1023 -> 1029 (the count tracks file count, since source-hygiene generates
one assertion per source file). Coverage 96.85 lines / 89.10 branches / 97.14
functions / 96.00 statements, floor unchanged at 96/96/96/89.

Still open: `withDb` (23 hand-written open/close pairs). Written during this
pass and removed before commit rather than shipped unused — it rewrites the body
of every call site, so it needs its own verification rather than riding along.

## v0.40.0 — 2026-07-25

A hardening pass over the whole repository, run as a 21-agent audit (10 writers
with disjoint file ownership, 11 read-only cross-cutting auditors) against the
principles of *Clean Code*, *The Pragmatic Programmer*, *Functional Programming
in Scala*, and a systems-design and threat-model review. No feature work. The
tests go 684 -> 1023 and branch coverage 85.94% -> 89.24%, the axis that was
weakest; the coverage floor ratchets 94/93/96/83 -> 96/96/96/89.

**Correctness bugs fixed** (each silently produced a wrong number or a wrong
verdict; none announced itself):

- **The distiller was fed the wrong transcript** (`src/collect.ts`). On a
  `SubagentStop` the `runs` row was built from the subagent's own sidechain, but
  the distiller spawn passed `payload.transcript_path` — the *parent*
  conversation. Rules were attributed to a subagent from evidence it never
  generated, then benchmarked and potentially promoted into that subagent's
  memory.
- **A concurrent-open migration race** (`src/db.ts`). Two processes (a Stop hook
  firing while a benchmark writes) both read the same pre-migration
  `user_version` and both applied it; `ALTER TABLE ADD COLUMN` is not idempotent,
  so the loser died with `duplicate column name`. Now `BEGIN IMMEDIATE` with the
  version re-read inside the lock.
- **`busy_timeout` was set after `journal_mode = WAL`** (`src/db.ts`), so the
  brief exclusive lock WAL conversion needs could make `openDb` throw
  `SQLITE_BUSY` instead of waiting.
- **A success check that could not *run* was recorded as the task failing**
  (`src/bench.ts`). `spawnSync` returns `status === null` on a missing `bash`, a
  timeout, or an output overrun; all three entered the corpus as measurements,
  and because the run had spent real tokens the environment-failure discriminator
  could never catch them. The check spawn also had no `maxBuffer`, leaving Node's
  1 MB default.
- **`priceFor` read the prototype chain** (`src/pricing.ts`). A model named
  `constructor`/`toString`/`valueOf` resolved to a function through
  `Object.prototype`, passed the truthiness guard, and made every downstream
  dollar figure `NaN`. Reachable via a bring-your-own agent's `model:` line.
  `priceFor("")` threw outright. Both fixed with `Object.hasOwn`.
- **An empty price override priced the workload at zero** (`src/pricing.ts`).
  `Number("") === 0`, so `export TOKEN_WARDEN_PRICE_INPUT=` — the ordinary shell
  way to unset-but-export — set every rate to zero. NaN was already guarded;
  empty string was the hole.
- **`evolve` could recommend a variant it never measured** (`src/evolve.ts`).
  `wins` never consulted `comparison.environmentFailure`, so a quota death read
  as a large saving and wrote a proposals file, directly under the warning it had
  just printed. Its model call also checked only `claude.error`, never the exit
  status.
- **The A/B percentage averaged two different task sets** (`src/compare.ts`).
  Each side filtered `> 0` independently, so a task one side failed entirely was
  dropped from that mean and kept in the other — printing e.g. "+126.7% ...
  cheaper for this workload", a sentence contradicting itself and the (correct)
  delta beside it. `regressedTaskIds` also reported quota deaths as regressions,
  so the roll-up could print "REGRESSED" and "completion-safe across all suites"
  together.
- **`delta=+null` and `delta=+-500` in `/warden-status`** (`src/status.ts`): a
  hardcoded `+` on a nullable, sometimes-negative measured delta.
- **Compression was impossible for rules under 20 characters**
  (`src/compress.ts`): the prompt asked for `max(10, len/2)` while the check
  enforced `floor(len/2)`, so every reply was rejected by construction after
  paying for the model call.

**Security hardening** (authorized review of the project's own trust
boundaries):

- **`/warden-protect --add` bypassed every body check** — the only writer into
  `rules.body` with no validation, inserting `status='active', protected=1`, so a
  body containing `\n- ...` forged extra bullets into the compiled `MEMORY.md`
  permanently (protected rules are never re-audited or evicted). `--scope` had
  the same hole. Both now enforce the shared rule-body contract.
- **The compression rewriter used a weaker validator than the distiller** — its
  regex accepted bidi overrides, zero-width joiners and emoji that
  `ruleBodySchema` rejects, while `distill.ts` carried a comment claiming the two
  paths "can never drift". They now share one schema, and all three model-call
  paths share one validated envelope parser.
- **`displayText` under-covered** (`src/sanitize.ts`): it stripped the 7-bit CSI
  but not the 8-bit form (U+009B), and no bidi/zero-width class at all. Six
  report sites interpolated untrusted rule bodies and task ids raw.
- **Imported ledgers** (`src/adopt.ts`): size and rule-count caps applied before
  parsing, agent names slug-validated inside the schema, and block extraction
  anchored on the marker so a rule body ending in a fenced block can no longer
  mis-slice the ledger.
- **Golden-task fields validated at the parse chokepoint** (`src/bench.ts`): a
  prompt starting with `-` is rejected, because `-p` takes an *optional* value
  and such a prompt is read by the child CLI as a flag — enough to change the
  benchmarked agent's permission mode.
- **Hook wiring** (`hooks/hooks.json`): the `Stop` hook was the only one without
  `|| true`, so a failed `cd`/install surfaced as a hook error despite the
  documented exit-0 guarantee; its `[ -d node_modules ]` guard tested directory
  existence rather than install success, so an interrupted install wedged
  collection permanently. Now gated on a success sentinel, `npm ci`, the local
  `tsx` binary (no registry fetch inside a hook), and `|| true` everywhere. The
  `SessionStart` nudge no longer fires on `clear`/`compact`.
- **CI**: the one `${{ }}` interpolation inside a `run:` block moved to `env:`.

**Benchmarks** — every one of the 20 golden checks was executed against an
untouched copy of the frozen fixture to find checks that pass with the agent
doing nothing. Two did: `sql-01` and `backend-03`. (`sql-05` was suspected and
cleared — it correctly exits 1.) `benchmarks/sql/golden-08.md` and
`benchmarks/backend/golden-04.md` are their non-degenerate replacements. `sql-01`'s check passes on
the pristine fixture (it greps for `create index` and `user_id`, both already in
`schema.sql`), so it can never detect a regression, and a quota-dead run on it
records `completed = true`, hiding it from the environment-failure discriminator
on the very agent every burn in FINDINGS.md used. `sql-01` is left
byte-identical — its frozen `run1_tokens` and every published comparison stay
valid — and the corrected task is *added*, the same remedy v0.36.0 used for the
noisy-task splits. `backend-03`'s check was `grep -q 'quantity'
src/services/orderService.ts && npx vitest run`, and both halves hold on the
pristine fixture: `quantity` is a PARAMETER NAME of `createOrder`, and the
shipped suite passes because the seeded pricing bug has no test. `backend-04`
requires the multiplication in either operand order, a test referencing
`createOrder`, and a green suite — verified to exit 1 pristine, 1 when the bug
is fixed WITHOUT the requested regression test, and 0 only when both are done.

**Structure** — `src/select.ts` decomposed (`selectForAgent` 345 -> 65 lines) with
`MeasurementPlan`/`MeasuredSide`/`DecisionOutcome` replacing boolean-blind
parameters and a nullable-abort out-param. Verified behaviour-preserving by
differential fuzzing against a pristine `git archive HEAD` copy: 132,000
comparisons across the full verdict path and 250 randomized multi-round
orchestration scenarios, comparing resulting DB rows and compiled `MEMORY.md` —
all identical. `src/bench.ts` gained an injectable `RunOnceDeps` seam (coverage
75% -> 91%) and a signal-safe temp-dir sweep, so an interrupted burn no longer
leaks a fixture copy per run.

**Docs** — ARCHITECTURE.md corrected (9 -> 16 migrations, 10 -> 20 commands, the
bring-your-own-agent contradiction, `zod` as a second runtime dependency, rent vs
`effectiveRent`); SECURITY.md's "token counts are never converted to currency"
removed, which `/warden-cost` has falsified since v0.26.0; the superseded ~2.5%
synthetic false-positive rate annotated with the measured 8.8% everywhere it
appears; the compression A/B marked CLOSED in ROADMAP.md so a fourth ~16M-token
burn is not attempted; `docs/specs/*` given status banners (one of the four was
tested and rejected but still read as a plan); and the two release traps this
repo actually hit recorded in CONTRIBUTING.md.

**Known limitations, deliberately not fixed here** — the shared-module
extractions (`stats.ts`, `format.ts`, `rules.ts`, `memory.ts`, `cli.ts`) are
deferred to the next pass and tracked in ROADMAP.md; they are cross-cutting and
would have collided with the file ownership that kept this pass conflict-free.
`WARDEN_CONFIDENCE_Z` still *rejects* a sub-1 value and falls back to 2 rather
than clamping to 1 as CONTRIBUTING previously implied — the doc now describes the
actual behaviour rather than the gate being changed, since `z` is calibrated.

## v0.39.0 — 2026-07-11

The complete environment-failure abort. v0.38.0 shipped a first, simpler guard
(majority-zero-token check in the selector); this release replaces it with the
full implementation, built and validated live through three real quota deaths
(FINDINGS.md) — same principle, four independent layers, and it fixes a
dilution flaw in the v0.38.0 check (which ran post-merge, where a clean first
pass could dilute a contaminated top-up below any threshold — exactly how
burn 1 finalized).

- **Zero-token discriminator** (`src/bench.ts` `isEnvironmentFailure`). A
  failed run below 1,000 tokens is an environment failure (quota death, API
  error, crash) — the cheapest genuine golden run observed is ~34k, and even a
  rule-broken run burns thousands attempting the task. A failed run *with*
  real tokens stays regression signal, so the safety gate (the rule-3 class)
  is untouched.
- **Streak abort in `runSuite`** (`ENV_FAILURE_STREAK = 4`). Four consecutive
  zero-token failures abort the pass early with a typed
  `EnvironmentFailureError` instead of burning the rest of the suite producing
  no evidence (the real quota deaths ran 46 and 72 consecutive). A single
  broken run still never aborts.
- **Per-pass majority guard in the selector** (`passEnvironmentFailure`:
  >=3 env-failures and a strict majority of the pass). Checked the moment each
  pass is produced — baseline, swap reference, candidate, audit, top-up —
  never post-merge.
- **False-regression fix** (`assessDelta.environmentFailure`). A
  baseline-completed task whose with-side is missing or all zero-token
  failures no longer reads as a rule regression; it flags environment failure
  and the selector aborts before `decideRule`/`recordReceipt`/probation — an
  abort structurally cannot persist a verdict. The rule stays queued as a
  candidate; decisions made earlier in the invocation stand. `main()` prints
  `ABORTED: environment failure …` and exits non-zero. No 'aborted' receipt
  row: an abort is precisely "no decision was made".
- **Benchmark subprocess isolation** (`src/bench.ts` `benchChildEnv`). Spawned
  benchmark `claude` processes no longer inherit a parent Claude Code
  session's environment — a bug that could make a golden run "measure" the
  parent session's multi-million-token transcript and freeze it as a run1
  baseline.
- **Compare surfaces it too** (`src/compare.ts`): model/prompt A/Bs report
  "environment failure — no verdict" instead of silently mis-reading a
  quota-dead side.
- **Power planner honesty** (`src/power.ts`): warns when golden tasks have no
  active-run variance history ("this plan is under-characterized") — the blind
  spot that mis-sized both burns by ~3x.

## v0.38.0 — 2026-07-10

The environment-failure abort guard, first iteration — the direct product of
the two real compression burns (FINDINGS.md, "First compression A/B burn"),
both of which were killed by quota exhaustion mid-burn and produced verdicts
that should never have been finalized. Superseded by the complete
implementation in v0.39.0.

- **Selector abort guard** (`src/select.ts` `environmentFailure`). When at
  least half of a measurement pass's runs failed WITHOUT spending tokens, the
  pass is an environment failure (quota exhausted, claude unavailable, spawn
  timeouts) — not a measurement. The discriminator is token spend: a run the
  RULE breaks still spends tokens before failing its success check; a run the
  ENVIRONMENT kills produces zero. On trip, the decision is ABORTED: no
  verdict persisted, no receipt written, a candidate stays queued for a
  healthy invocation, an audit target stays untouched, and an all-aborted
  invocation does not recompile memory (no ruleset bump, no cache bust).
- Regression-test fixtures that modeled a rule-caused failure as a zero-token
  run were updated to spend tokens — matching reality, and the guard's
  discriminator.

## v0.37.0 — 2026-07-08

Distribution-weighted golden suites enter the gate — the feature deferred in
v0.36.0, now shipped with the effective-degrees-of-freedom correction that
closes the calibration gap.

- **Task weights in the verdict** (`src/select.ts`, `src/bench.ts`). A golden
  task may carry `weight: N` in its frontmatter (default 1); the verdict
  estimators weight the mean saving `Σwᵢsᵢ/Σwᵢ`, the within-task standard error
  `sqrt(Σwᵢ²·[·])/Σwᵢ`, the between-task fallback, and the Neyman top-up
  allocation. A rule protecting a rare but expensive production case is measured
  in proportion to its real-work value instead of being diluted by common cheap
  tasks. With every weight 1 the path is bit-identical to before (pinned).
- **Effective-DoF confidence correction** (`src/select.ts`
  `withinTaskDofInflation`/`betweenTaskDofInflation`). Concentrating weight
  lowers the effective sample size of the SE estimate, so a flat z=2 quantile
  under-covers — the calibration harness measured the weighted false-positive
  rate at ~6.5% vs ~4.2% unweighted at runs=2. The confidence multiple is now
  widened by the ratio of small-sample t-inflations (Cornish-Fisher) at the
  actual vs uniform-weight effective DoF (Welch-Satterthwaite within-task, Kish
  between-task). It is exactly 1 at uniform weights (bit-identical) and clamped
  to never loosen the gate below the unweighted z. After the correction the
  weighted FP is within ~0.7 points of unweighted at the default runs=3 and
  above (5.3/3.4/2.8 vs 4.2/2.7/2.4 gaussian); the ~1-point residual at runs=2
  is the inherent limit of estimating variance from two runs, a regime
  `/warden-power` already flags as underpowered.
- The bundled suites stay unweighted (frozen; invariant #4). Weighting is for
  new tasks and bring-your-own-agent suites, so existing baselines and verdicts
  are unchanged.

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
