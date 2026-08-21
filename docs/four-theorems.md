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
of answering critics one at a time. `attribute`, `cohort` and `contradict` are
the three with real signal; the rest go.

**22 commands -> 4.** `/warden-status`, `/warden-select`, `/warden-receipt`,
`/warden-power`. That is enough to see state, spend measurement, read the
evidence for a verdict, and plan a burn.

## 3. The four theorems

Each attacks a measured, documented weakness. Each is a named published result
with a proof I did not invent. They compose into the same four-stage loop, one
theorem per stage.

```
  estimate            decide            spend             pack
  James-Stein   ->    Benjamini-   ->   Successive   ->   submodular
  shrinkage           Hochberg         Halving           greedy / knapsack
  (cuts SE)           (controls FDR)   (cuts burn)       (cuts redundancy)
```

### I. James-Stein shrinkage — the estimator

**Theorem** (Stein 1956; James & Stein 1961). For `X ~ N(theta, sigma^2 I_p)`
with `p >= 3`, the estimator

```
  theta_JS = xbar + (1 - (p-3) sigma^2 / ||x - xbar||^2)_+ (x - xbar)
```

has strictly lower total mean squared error than the MLE `x`, **for every
theta**. The MLE is inadmissible.

**Why it fits.** The gate estimates a per-task saving for each of N golden tasks
from 3 runs a side. These are exactly `p` noisy estimates of `p` related means
with few samples each — the textbook Stein setting. Tasks in a suite are not
independent draws from nowhere; they share an agent, a fixture and a difficulty
scale, so the pooled mean is a genuinely informative shrinkage target.

**What it replaces.** `weightedMean` over raw per-task savings. The suite mean
is unchanged in expectation; what shrinks is the *variance* of the per-task
components that feed `withinTaskSE`. This is the first change in the project's
history that attacks SE rather than the threshold.

**Honest limits.** JS dominates in *total* MSE across the p tasks, not
necessarily for any single task. The gate aggregates across tasks, which is the
case where the guarantee applies — but the positive-part estimator is biased,
and a biased estimator inside a calibrated gate must be re-calibrated, not
assumed safe. That is what stage 4 of the plan is for. If shrinkage raises the
false-positive rate the way robust-SE did in v0.30.0, it does not ship. The
theorem earns it a trial, not a slot.

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
across tasks, by variance. Successive Halving allocates *across* candidates. They
compose cleanly and neither touches the verdict — which is exactly why this is
the safest of the four to ship. It cannot change what a rule's verdict is, only
how many tokens were spent reaching it.

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
| SE ~5,500 vs bar ~54 (v0.36.0) | James-Stein | Lower per-task MSE -> lower SE |
| FP 8.8% empirical, no multiplicity control (v0.35.0) | Benjamini-Hochberg | FDR bounded at q as the pool grows |
| $19.13 discovery vs $5.34/yr savings | Successive Halving | Budget concentrates on live candidates |
| Redundant rules each pass a per-item bar | Submodular knapsack | Kept set chosen jointly under budget |

And the property the project is selling — *it gets better the more you use it* —
stops being a slogan and becomes four specific claims:

1. More recorded runs -> better shrinkage target -> lower SE. (I)
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
  branch regardless of how good the theorem is. James-Stein is biased and
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
> tokens than it costs. Stein shrinkage makes the measurement precise enough to
> be affordable, Benjamini-Hochberg keeps the surviving set honest as it grows,
> Successive Halving spends the measurement budget where the uncertainty is, and
> a submodular knapsack picks the set that fits the context window. Four
> theorems, one loop, and the loop gets cheaper every time you run it.
