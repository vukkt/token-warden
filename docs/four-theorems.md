# Four theorems

The spec for v1.0.0. What the plugin should be, why the current version is not
that, and which four proven results replace the accreted machinery.

## 1. The binding constraint

Everything below follows from one measured number, recorded in DECISIONS.md at
v0.36.0 when anytime-valid confidence sequences were tested and lost:

> `u(t)` needs ~(SE/bar)^2 audits to cross a ~54-token bar against a ~5,500-token SE.

The bar is around 54 tokens. The standard error is around 5,500. The
signal-to-noise ratio of this instrument is about **1:100**.

That entry is the most valuable thing in the repository, and its lesson was
recorded too narrowly. It concluded "two-strike stays" — a statement about
retention policy. The general statement is stronger:

**No decision rule can fix this. The estimator is the bottleneck.**

Confidence sequences did not fail because the theory was wrong. They failed
because `bar/SE` is the binding term, and swapping one stopping rule for another
leaves that term untouched. Any future proposal that changes *how we decide*
while leaving *how we estimate* alone will fail the same way, for the same
reason. The repo has now spent four such attempts:

| Attempt | Version | Outcome | What it changed |
| --- | --- | --- | --- |
| Robust SE in the gate | v0.30.0 | Vetoed, FP 3% -> 7% | Decision rule |
| Two-strike retention | v0.32.0 | Kept | Decision rule |
| Confidence sequences | v0.36.0 | Rejected | Decision rule |
| Weighted suites | v0.37.0 | Shipped after a t-correction | Decision rule |

Three of four touched the decision. None touched the estimator. The one clear
win — Neyman allocation in v0.24.0 — is the exception that proves it: it moved
runs to where the variance was, and it worked.

The economics say the same thing in dollars. The README now records $5.34 saved
per developer per year against a $19.13 one-time discovery cost: **the
instrument costs more than the thing it measures is worth.** Runs needed to
resolve an effect scale as `(SE/effect)^2`, so halving SE quarters the discovery
cost. That is the only lever with a big enough exponent to flip the sign.

So the design rule for v1.0.0:

> Spend the budget on the estimator and the allocator. Touch the decision rule
> only where multiplicity makes the current one provably wrong.

## 2. What the plugin actually is

Stripped of five versions of instrumentation, the loop is four steps:

```
  collect  ->  distill  ->  bench  ->  select
  (hook)       (1 model    (golden   (keep if it
               call)        suite)    pays rent)
```

That is the whole idea, and it is a good one. The problem is not the thesis. The
problem is that 45 modules, 16,512 lines of source, 23,172 lines of test and 22
slash commands have grown around it, and roughly half of that mass serves a
different product than the thesis states.

### Measured surface

| Group | Modules | Lines | Verdict |
| --- | --- | --- | --- |
| Core loop | collect, transcript, distill, bench, select, db, rules, memory, stats | ~7,000 | Keep |
| RAG sub-product | retrieve, corpus, extract, interrogate, ragbench | 2,404 | **Cut** |
| A/B benchmarking suite | modelbench, promptbench, evolve, compare | 1,350 | **Cut** |
| Team ledger | share, adopt, verify-ledger | 554 | **Cut** |
| Advisory diagnostics | attribute, cohort, contradict, sample-tasks, health, dogfood, scope, protect, compress, confirm | ~2,300 | **Cut** (see below) |
| Support | cli, format, sanitize, logfile, pricing, model-call, registry, types, status, notify, cost, power, receipt | ~2,900 | Keep the load-bearing half |

The RAG sub-product is the clearest case. BM25 retrieval, a chunking corpus, a
fact extractor and a grounded-answer benchmark are a *complete second product*
living inside a token-accounting plugin. It is 2,404 lines and it does not
appear anywhere in the thesis sentence. It should be its own repository or
nothing.

The A/B benchmarking suite (`modelbench`, `promptbench`, `evolve`) is a third
product: comparing models and prompts is useful, but it is not "does this memory
rule earn its context rent." It shares `bench.ts` and that is the whole
relationship.

The advisory diagnostics are the subtlest and the most instructive. Each was
individually justified — most were written to answer a specific critique — and
each is genuinely harmless because none of them can evict a rule. But ten
commands that produce advice nobody acts on are ten commands of surface area,
ten sets of tests, and ten things to explain. They are the accumulated residue
of answering critics one at a time.

**22 commands -> 6** (as executed): `/warden-status` to see state,
`/warden-power` to plan a burn, `/warden-bench` to measure, `/warden-select` to
decide, plus `/warden-receipt` for the evidence behind a verdict and
`/warden-cost` for the dollar lens.

An earlier draft of this section proposed keeping `attribute`, `cohort` and
`contradict` as "the three with real signal", and also proposed 4 commands —
two claims that cannot both hold. The cull resolved it toward the smaller
surface: all three are advisory, none can evict a rule, and a diagnostic nobody
acts on is indistinguishable from one that does not exist. `attribute` was the
one genuine exception and it was **split** rather than deleted — its
classification half feeds the Stop hook and `status.ts` reads the result, so
that half survives as `tool-cost.ts` while the report command goes.

## 3. The four theorems

Each attacks a measured, documented weakness. Each is a named published result
with a proof I did not invent. They compose into the same four-stage loop, one
theorem per stage.

```
  estimate            decide             spend             pack
  variance      ->    Benjamini-   ->    Successive  ->    submodular
  moderation          Hochberg           Halving           knapsack
  (stabilises SE)     (controls FDR)     (cuts burn)       (cuts redundancy)
```

### I. Empirical-Bayes variance moderation — the estimator

**This section originally specified James-Stein shrinkage. That was wrong, and
the correction is more interesting than the original plan.**

James-Stein shrinks the per-task savings toward their pooled mean:
`theta_JS = xbar + c*(x - xbar)`. Take the mean of both sides — `mean(theta_JS)
= xbar`. Shrinkage toward the grand mean *preserves the grand mean exactly*.
The verdict reads the suite mean, and `withinTaskSE` reads per-task
**variances**, so shrinking the per-task means changes neither number. Shipped
as specified, it would have been a no-op with a famous name on it.

The defect it was reaching for is real, but it is one level down. At the default
`runs=3`, each task's variance is a sample variance on **2 degrees of freedom**
— an estimate whose own relative standard deviation is around 100%. That
instability flows straight into `z * SE`: a task that happens to look quiet
makes the band too narrow and promotes on noise; one that happens to look loud
makes it too wide and misses a real rule. It is a plausible mechanism for the
gap between the ~2-3% synthetic false-positive rate and the 8.8% measured on
recorded runs.

**Theorem** (Smyth, *Statistical Applications in Genetics and Molecular
Biology*, 2004 — the moderated t behind limma). Model
`s_i^2 | sigma_i^2 ~ sigma_i^2 chisq(d_i)/d_i` with a scaled-inverse-chi-square
prior `1/sigma_i^2 ~ chisq(d_0)/(d_0 s_0^2)`. The posterior mean is closed form:

```
  s~_i^2 = (d_0 * s_0^2 + d_i * s_i^2) / (d_0 + d_i)
```

carrying `d_i + d_0` degrees of freedom instead of `d_i`. The hyperparameters
`d_0` and `s_0^2` are estimated from the data by matching the first two moments
of `log s_i^2`, so nothing is hand-tuned.

**Why it fits.** Many tasks, few replicates each, unstable per-task variances —
this is precisely the setting the moderated t was designed for. And it
*generalises what the code already does*: `select.ts` borrows the pooled
variance when a side cannot estimate its own (`sampleVariance(...) ?? pooled`),
an all-or-nothing switch between total trust and total dismissal. Moderation is
the principled continuum between those two, with the blend weight fitted rather
than assumed.

**What it replaces.** `taskSavingVariance`'s raw `sampleVariance(...) ?? pooled`.

**Honest limits, and a correction to section 1's framing.** Nothing here makes
the *true* standard error smaller. The `SE ~5,500` against a `bar ~54` is a
property of the benchmark, and only more runs or quieter golden tasks move it.
What moderation buys is a **correctly calibrated decision at the same run
count** — a stabler variance estimate, hence a band that is the width it claims
to be. Expect it to show up as a lower false-positive rate, not as more
promotions. Section 1's claim that this theorem "attacks SE, the term nothing
has attacked yet" is therefore too strong: it attacks the *estimate* of SE, not
SE itself. That is still the first change in the project's history aimed at the
estimator rather than the threshold, which was the real point.

The moderated variance is also *biased* by construction, and a biased estimator
inside a calibrated gate must be re-calibrated rather than assumed safe. If it
raises the false-positive rate the way robust-SE did in v0.30.0, it does not
ship. The theorem earns it a trial, not a slot.

> **MEASURED, AND REJECTED.** It took the trial and lost. On the recorded `sql`
> pool the false-positive rate did not fall (8.9% -> 9.2%) and power fell at
> every effect size, by 5.4 points at a 20% saving with non-overlapping
> intervals. Full numbers in [FINDINGS.md](../FINDINGS.md).
>
> The reason is not the one to guess. Moderation IS a better variance estimator
> here — it more than halves log-MSE even at 3 tasks — but it is fitted on
> `log s^2` and is therefore biased on the natural scale, running 1.84x high at
> df=1. The gate compares `delta - bar` to `z * SE`, so a 1.84x variance is a
> 1.35x wider band and directly fewer promotions.
>
> The general lesson, which outlives this feature: **minimising estimation error
> and maximising decision quality are different objectives.** Moderation
> minimises squared error in log space, which is right if you want to *know*
> sigma^2. The gate does not want to know sigma^2; it wants a band that is the
> width it claims to be, which needs unbiasedness on the natural scale.
>
> `src/moderate.ts` stays, behind `WARDEN_MODERATE_VARIANCE=1`, default off. The
> negative result is only trustworthy because the implementation is correct.

### II. Benjamini-Hochberg — the decision

**Theorem** (Benjamini & Hochberg 1995). Order p-values `p_(1) <= ... <= p_(m)`,
let `k = max{ i : p_(i) <= (i/m) q }`, reject `H_(1)..H_(k)`. Then
`FDR <= (m_0/m) q <= q` under independence. Benjamini & Yekutieli (2001) extend
this to positive-regression-dependent statistics, and to arbitrary dependence at
`q / sum(1/i)`.

**Why it fits.** This is not a new idea in this repo — it is an *overdue* one.
`docs/audit-2026-07.md` already says:

> if `MAX_CANDIDATES_PER_INVOCATION` ever grows, a per-invocation Bonferroni
> z-adjustment is the first knob.

Bonferroni is the wrong knob. It controls family-wise error, which is the
probability of *even one* false rule — needlessly strict for a system that
tolerates a few bad rules as long as most kept rules are real. FDR is the error
rate this project actually cares about: "what fraction of my MEMORY.md is
noise?" BH is uniformly more powerful than Bonferroni at the same q, and the
gap widens as the pool grows.

**Why it compounds.** Carefully, because the loose version of this claim is
false and I wrote it that way first. The BH threshold is `(i/m)q`, which rises
with RANK but is **capped at `q`** (reached only at `i = m`). So a candidate
whose p-value exceeds `q` is unreachable at any pool size — the procedure does
not get unboundedly more generous as `m` grows, and `test/fdr.test.ts` pins
that cap precisely so nobody re-derives the wrong intuition.

Two true statements survive, and they are the ones that matter:

1. **FDR stays bounded at `q` as the pool grows.** A fixed per-rule `z = 2` has
   no such bound: the expected number of false rules in memory grows linearly in
   the number of candidates ever tested. The current gate degrades with use; BH
   does not. That asymmetry is the whole argument.
2. **BH's advantage over an FWER correction widens with `m`.** Bonferroni's
   threshold is `q/m`, which shrinks as the pool grows, while BH's does not. At
   `m = 20` the two agree on evidence at `p = 0.002`; at `m = 500` Bonferroni
   finds none of it and BH finds all of it. The measured gaps are `[0, 20, 100]`
   at `m = [20, 100, 500]`, pinned in the test.

Within a pool, a borderline candidate's fate depends on how its peers measured
— strong peers push the step-up out far enough to reach it, weak peers do not.
That is not a defect; it is what controlling a pool-level error rate means.

**What it replaces.** The bare `z=2` promotion margin, which becomes the
per-candidate p-value input rather than the decision itself.

### III. Successive Halving — the allocator

**Theorem** (Karnin, Koren & Somekh 2013; Jamieson & Talwalkar 2016). Given a
budget `B` over `n` arms, halving the surviving set each round and splitting the
budget evenly within a round identifies the best arm with budget
`O(H_2 log n)`, where `H_2 = max_i i * Delta_i^-2` — against `O(n H_1)` for
uniform allocation.

**Why it fits.** The distiller emits up to 3 candidates per invocation, and the
suite is run for all of them at the same depth. Most candidates are obviously
dead after one pass. Uniform allocation spends the same tokens confirming a
clear loser as resolving a close call.

**Relationship to Neyman.** v0.24.0 already allocates *within* a candidate,
across tasks, by variance. Successive Halving allocates *across* candidates.
They compose cleanly.

**Correction to an earlier draft of this document.** I first wrote that Halving
"cannot change what a rule's verdict is, only how many tokens were spent
reaching it." That is false, and worth stating plainly because it was the
argument for shipping it first. A candidate eliminated in round 1 is measured
at shallower depth than uniform allocation would have given it, so its verdict
genuinely can differ.

The accurate claim is directional, and it is still the reason this ships first:

- Halving can never **promote** something uniform allocation would not have.
  Survivors finish with strictly more runs than uniform buys them, so the
  winner's evidence is better and the promotion gate is untouched.
- It can produce a **false negative** — a good rule unlucky in round 1 gets cut
  before it can prove itself. `test/halving.test.ts` pins this rather than
  hiding it: under heavy noise the true best arm is demonstrably eliminated.

That asymmetry never loosens the gate, and the false-negative case already has
machinery waiting. An early-eliminated candidate is exactly the `underpowered`
eviction class from migration #16 — evidence never reached the bar, as opposed
to the rule being measured and falsified — and those keep their `recovers`
lineage for a second, deeper look.

**Why not SPRT.** A sequential probability ratio test is the obvious alternative
and it is the wrong one here, for the reason in section 1: Wald optimality is
about `E[N]` at fixed error rates, and it delivers its gains when the effect is
far from the boundary. At `bar/SE ~ 1:100` nearly everything is near the
boundary. The v0.36.0 confidence-sequence result is the empirical version of
this argument, already paid for. Not re-proposing it.

### IV. Submodular greedy under a knapsack — the packer

**Theorem** (Nemhauser, Wolsey & Fisher 1978). For monotone submodular `f`,
greedy maximisation under a cardinality constraint achieves `(1 - 1/e) ~ 0.632`
of the optimum. Sviridenko (2004) attains the same `(1 - 1/e)` under a general
knapsack constraint via partial enumeration plus density-greedy; plain
density-greedy with the best-single-item guard gives `1/2` (Khuller, Moss &
Naor 1999).

**Why it fits.** The current gate asks each rule, independently, whether it
clears twice its own rent. That is a per-item test, and it is wrong in a
specific way: **two rules that say nearly the same thing each pass, and together
save far less than the sum of their measured savings.** "Grep before reading a
file" and "search before opening files" both clear the bar alone; the second
adds almost nothing once the first is in memory. The current design has no way
to express this and no way to detect it.

Joint saving is monotone (adding a rule never reduces total saving) and exhibits
diminishing returns (a rule's marginal saving falls as related rules join). That
is the definition of submodular, and it makes the kept-set choice a knapsack
over a submodular objective, with the context window as the budget.

**Honest limits.** Submodularity here is a *modelling assumption*, not a measured
fact — I have not verified diminishing returns on real rule pairs, and the
`(1-1/e)` guarantee holds only if it is true. It is very likely true directionally
(overlapping rules cannot save twice) but the constant is unearned until
measured. Two consequences: the packer must degrade to the current per-rule
behaviour when marginal savings are unmeasured, and measuring pairwise marginals
is the first token burn v1.0.0 should fund.

**What it replaces.** The per-rule `keepBar` as the *final* authority. The bar
stays as an admission filter — a rule that cannot clear its own rent alone never
enters the knapsack — but the kept set is chosen jointly.

## 4. What this buys

| Weakness (measured, documented) | Theorem | Mechanism |
| --- | --- | --- |
| Per-task variance on 2 df is unstable (runs=3) | Variance moderation | Lower variance MSE -> honestly-sized band |
| FP 8.8% empirical, no multiplicity control (v0.35.0) | Benjamini-Hochberg | FDR bounded at q as the pool grows |
| $19.13 discovery vs $5.34/yr savings | Successive Halving | Budget concentrates on live candidates |
| Redundant rules each pass a per-item bar | Submodular knapsack | Kept set chosen jointly under budget |

And the property the project is selling — *it gets better the more you use it* —
stops being a slogan and becomes four specific claims:

1. More golden tasks -> a better-fitted prior -> stabler variances. (I)
2. More candidates -> FDR still bounded at q, where a fixed z accumulates false
   rules linearly; and BH's margin over Bonferroni widens with the pool. (II)
3. More candidates -> larger Successive Halving advantage over uniform. (III)
4. More surviving rules -> better set under the same context budget. (IV)

Each is a consequence of a theorem rather than a hope.

## 5. What must be true for this to ship

The repo's own discipline, which has vetoed two of its own features
(robust-SE v0.30.0, weighted suites v0.37.0), applies here without exception:

- **Calibration is the gate.** Every one of these runs through
  `validation/empirical-calibration.ts` against recorded runs before it enters
  the verdict path. If the false-positive rate rises, the feature is held on its
  branch regardless of how good the theorem is. The moderated variance is biased and
  submodularity is assumed; both are exactly the kind of thing that looks
  correct and calibrates badly.
- **Successive Halving ships first** — it cannot change a verdict, so it is
  provably safe to land ahead of calibration.
- **The deletions are reversible** and land as their own commits, so a cut can be
  undone without unpicking the algorithm work.
- `benchmarks/` stays frozen. Migrations stay append-only.

## 6. The haiku

If this works, the pitch is one paragraph:

> Agent memory is charged rent. A rule stays only if it provably saves more
> tokens than it costs. Empirical-Bayes moderation makes the measurement
> trustworthy at an affordable run count, Benjamini-Hochberg keeps the surviving set honest as it grows,
> Successive Halving spends the measurement budget where the uncertainty is, and
> a submodular knapsack picks the set that fits the context window. Four
> theorems, one loop, and the loop gets cheaper every time you run it.
