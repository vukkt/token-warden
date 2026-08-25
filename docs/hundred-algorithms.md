# One hundred algorithms, and the ten that could matter here

A survey done properly means most entries are rejections, and the rejections
have to be specific. This one is scored against three facts this repository has
already measured, not against what an algorithm promises in general.

## The three facts that decide almost every entry

**FACT 1 — the signal-to-noise ratio is about 1:100.** The suite standard error
is ~5,500 tokens against a keep bar of ~54 (twice a rule's rent). Anything that
shaves a few percent off an estimator is decoration at that ratio.

**FACT 2 — one integer explains 94.6% of within-task variance: the number of
tool calls.** Within-task-centred regression over 115 recorded runs, `total`
metric: one extra tool call costs **14,018 tokens**, R^2 **94.6%**. Turn-count
CV is 22-42% across tasks whose mean turn counts span 3.8 to 13.3 — a 3.5x size
range with no trend. The noise belongs to the AGENT, not to any task.

**FACT 3 — signal and noise share one channel, so reweighting the metric moves
both.** The effect of a good rule is 0.77 of one tool call. Switching the gate
to processing tokens shrinks the error bar 28-fold and makes detectability
*worse*, because the saving lives in cache-read, which is simultaneously the
noisiest and the cheapest component. This is the fact that kills the entire
variance-reduction family, and it kills it structurally rather than
quantitatively.

A fourth fact is about economics rather than noise, and it turned out to be the
one with room left in it:

**FACT 4 — the loss function is wildly asymmetric, and one side of it has never
been measured.** A worthless rule costs its rent (~25 tok/run). A missed real
rule forfeits its whole saving (~4,769 tok/run). Every calibration sweep this
project has run priced a false positive at *exactly* its rent and nothing more.

---

## The hundred

Verdicts: **SHIPPED** (in the tree, running) · **CLOSED** (measured here, does
not work, with the measurement named) · **STRUCTURAL** (killed by Fact 3 — no
amount of tuning reaches it) · **NO MECHANISM** (the input it needs does not
exist in this environment) · **THIN** (sound, but the pool is six rules in ten
weeks) · **TOP-10** (survives, ranked below).

### A. Variance reduction and experimental design (1-18)

1. **Neyman optimal allocation** (1934) — variance-proportional top-up runs. **SHIPPED**, `select.ts#allocateTopUpRuns`.
2. **Randomised block design** — block on task. **SHIPPED**; per-task pairing is the estimator's spine.
3. **Common random numbers** — pair the two arms on a shared stream. **NO MECHANISM**: the sampler exposes no seed, so the arms cannot be coupled.
4. **CUPED / pre-period regression adjustment** (Deng 2013) — 30-50% variance cuts in web A/B. **STRUCTURAL**: the only pre-treatment covariate is task identity, which blocking already absorbs; a task's history cannot predict a specific run's deviation.
5. **Control variates on tool calls** — R^2 94.6% suggests a 4.3x SE cut. **STRUCTURAL, and a trap**: tool calls are POST-treatment. A turn-reducing rule works *through* them, so adjusting removes the effect with the noise. Textbook mediator bias.
6. **Antithetic variates** — negatively correlated pairs. **NO MECHANISM** (no seed control).
7. **Stratified sampling** — strata by task. **SHIPPED** in effect, via blocking.
8. **Post-stratification** — reweight after the fact. **STRUCTURAL**: no pre-treatment stratifier exists.
9. **Importance sampling** — reweight toward informative draws. **NO MECHANISM**: runs cannot be drawn from a chosen proposal.
10. **Latin hypercube sampling** — **NO MECHANISM**: nothing to stratify over.
11. **Rao-Blackwellisation** — condition on a sufficient statistic. **STRUCTURAL**: the conditioning statistic is the mediator again.
12. **Paired t-test on matched runs** — **CLOSED**: runs are exchangeable within a side but not matchable across sides.
13. **Split-plot / repeated measures** — **STRUCTURAL**: same channel problem.
14. **Response-surface / factorial design** — **THIN**: needs many factors; there is one.
15. **Sequential Bonferroni-corrected blocking** — **CLOSED**, see family C.
16. **Regression discontinuity on rent** — **NO MECHANISM**: rent has no cutoff anyone is assigned around.
17. **Difference-in-differences** — **NO MECHANISM**: no parallel untreated period.
18. **Bootstrap variance estimation** — **SHIPPED** in `variance-decomposition.ts` (percentile CIs on variance shares).

### B. Sequential analysis and optimal stopping (19-30)

19. **Wald SPRT** (1945) — stop as soon as a likelihood ratio crosses. **TOP-10 (#4)**.
20. **mSPRT / always-valid p-values** (Johari 2015) — **TOP-10 (#5)**.
21. **Confidence sequences** (Howard 2021) — **CLOSED**, tested at v0.36.0: the bar/SE ratio binds and dead rules never exit.
22. **Group sequential / O'Brien-Fleming** — **CLOSED**: same binding constraint; interim looks at n=2-3 buy nothing.
23. **Alpha spending functions** (Lan-DeMets) — **CLOSED** with 22.
24. **Optimal stopping / secretary problem** — **WRONG SHAPE**: candidates are not ranked draws from a known order.
25. **Gittins index** — **THIN**: needs a discounted infinite horizon and a stable arm set.
26. **Bayesian optimal experimental design** — **TOP-10 (#7)**.
27. **Chernoff's sequential design** — **THIN**.
28. **Two-strike retention** — **SHIPPED**, `select.ts#twoStrikeRetention`.
29. **Curtailed sampling** — **CLOSED**: run counts are 2-3; nothing to curtail.
30. **Successive Halving** (Karnin 2013) — **CLOSED**, measured and deleted at v1.1.0: gives the winner *exactly* uniform's depth at n=3.

### C. Multiple testing and selective inference (31-40)

31. **Benjamini-Hochberg FDR** (1995) — **CLOSED**, implemented then deleted: cut FDR 4x and lost 14,218 -> 5,588 net tokens.
32. **LORD++ online FDR** (Ramdas 2017) — **CLOSED**, deleted with 31.
33. **Bonferroni** — **CLOSED**: strictly worse than 31 on the same objective.
34. **Holm-Bonferroni** — **CLOSED** with 33.
35. **Storey's q-value** — **CLOSED**: FDR is the wrong objective here (Fact 4).
36. **Knockoff filters** (Barber-Candes 2015) — **NO MECHANISM**: no design matrix to knock off.
37. **Selective inference / post-selection CIs** (Lee 2016) — **TOP-10 (#9)**.
38. **e-values and e-processes** (Vovk-Wang) — **TOP-10 (#8)**.
39. **Family-wise error under dependence** — **THIN**: candidates per pass rarely exceed 3.
40. **Closed testing procedures** — **CLOSED** with 33.

### D. Bandits and pure exploration (41-52)

41. **UCB1** (Auer 2002) — **WRONG SHAPE**: the objective is identification, not cumulative regret.
42. **Thompson sampling** — **WRONG SHAPE** with 41.
43. **Successive Rejects** (Audibert 2010) — **TOP-10 (#6)**.
44. **LUCB / best-arm identification** (Kalyanakrishnan 2012) — **TOP-10 (#3)**.
45. **Racing algorithms** (Maron-Moore 1994) — folded into 44.
46. **Sequential Halving** — **CLOSED** with 30.
47. **Lil'UCB** (Jamieson 2014) — **THIN**: the LIL regime needs run counts this project cannot buy.
48. **Exponential-gap elimination** — **CLOSED** with 30.
49. **Top-k identification** — **TOP-10 (#3)**, same mechanism as 44.
50. **Contextual bandits** — **NO MECHANISM**: no per-decision context vector.
51. **Best-arm with a fixed budget** — merged into 43.
52. **Bandits with knapsacks** (Badanidiyuru 2013) — **THIN**, but the closest match to the real problem shape; revisit when candidate volume rises.

### E. Bayesian methods and decision theory (53-63)

53. **Bayes decision rule under asymmetric loss** — **TOP-10 (#1). IMPLEMENTED TONIGHT.**
54. **Expected value of information** — **TOP-10 (#7)**, with 26.
55. **Empirical Bayes / James-Stein shrinkage of means** — **TOP-10 (#10)**, but **THIN** today: six rules in ten weeks.
56. **Smyth variance moderation** (2004) — **CLOSED**, implemented and deleted: halves log-MSE and still makes the gate worse, because it is biased 1.84x high on the natural scale at df=1.
57. **Hierarchical / partial pooling** — **THIN** with 55.
58. **Bayesian model averaging** — **THIN**.
59. **Conjugate normal-normal updating** — the machinery under 53.
60. **Posterior predictive checks** — **TOP-10 (#9)** adjacent; cheap and diagnostic.
61. **Bayes factors** — **CLOSED**: sensitive to a prior nobody can defend at this pool size.
62. **Loss-calibrated inference** — the formal name for what 53 does.
63. **Minimax decision rules** — **WRONG SHAPE**: minimax over an unbounded harm is degenerate.

### F. Robust statistics (64-72)

64. **Hampel filter** — **SHIPPED**, `select.ts#filterOutliers`.
65. **Median absolute deviation** — **SHIPPED**, inside 64.
66. **Trimmed means** — **CLOSED** at v0.30.0: robust SE raised the false-positive rate ~3% -> ~7%, so it ships as a tail-risk FLAG only, never in the gate.
67. **Winsorisation** — **CLOSED** with 66.
68. **Huber M-estimation** — **CLOSED** with 66.
69. **Theil-Sen estimator** — **STRUCTURAL**: robustness is not the binding constraint.
70. **Rank-based / Wilcoxon tests** — **TOP-10 (#9)** adjacent; discards magnitude, which is the thing being gated.
71. **Permutation tests** — **SHIPPED**, `empirical-calibration.ts` A/A permutation.
72. **Bootstrap CIs** — **SHIPPED** with 18.

### G. Submodular and combinatorial optimisation (73-82)

73. **Facility-location maximisation** — **SHIPPED**, `knapsack.ts`.
74. **Khuller-Moss-Naor density greedy + best-single guard** (1999) — **SHIPPED**, the `(1-1/e)/2` bound.
75. **Nemhauser-Wolsey-Fisher greedy** (1978) — the cardinality-constrained parent of 74.
76. **Sviridenko (1-1/e) enumeration** (2004) — **deliberately not implemented**: O(n^5) for a constant factor on a set of tens.
77. **Lazy greedy / CELF** (Leskovec 2007) — **THIN**: worthwhile above ~10^3 candidates; there are tens.
78. **Continuous greedy / multilinear extension** — **THIN** with 77.
79. **0/1 knapsack DP** — what 73 degrades to under the independent default.
80. **Matroid-constrained submodular maximisation** — **WRONG SHAPE**: the constraint is a budget, not a matroid.
81. **Set cover / maximum coverage** — the unweighted special case of 73.
82. **Determinantal point processes** — **THIN**: a principled diversity prior, but needs a kernel nobody has measured.

### H. Online learning and regret (83-89)

83. **Multiplicative weights / Hedge** — **WRONG SHAPE**: no per-round loss is observed.
84. **Follow the regularised leader** — **WRONG SHAPE** with 83.
85. **Online gradient descent** — **WRONG SHAPE** with 83.
86. **Exp3 (adversarial bandits)** — **WRONG SHAPE**: the environment is stochastic, not adversarial.
87. **Online convex optimisation** — **WRONG SHAPE** with 83.
88. **Regret matching** — **WRONG SHAPE** with 83.
89. **Doubling trick** — **THIN**: horizon is not the binding resource; quota is.

### I. Causal inference (90-96)

90. **Randomised controlled trial** — **SHIPPED**: this is what the A/B gate is.
91. **Propensity score matching** — **NO MECHANISM**: assignment is already randomised.
92. **Instrumental variables** — **NO MECHANISM**: no instrument.
93. **Mediation analysis** — diagnostic only; it is what identifies 5 as a trap.
94. **Synthetic control** — **TOP-10 (#2)** adjacent, via the production cohort.
95. **Doubly robust estimation** — **STRUCTURAL**: needs the covariates 4 and 5 do not have.
96. **Front-door adjustment** — **NO MECHANISM**.

### J. Sketching, streaming, compression (97-100)

97. **Count-min sketch** — **WRONG SHAPE**: the ledger is small and exact.
98. **HyperLogLog** — **WRONG SHAPE** with 97.
99. **Reservoir sampling** — **WRONG SHAPE**: nothing needs subsampling.
100. **Minimum description length** — **THIN**: an elegant framing for rule-body compression, whose A/B is already closed as unconfirmable in this environment.

---

## The ten that could matter, ranked

| # | Algorithm | Why it survives | Status |
|---|---|---|---|
| 1 | **Bayes decision rule under asymmetric loss** | Fact 4 is unexamined, and it is the only lever the noise does not veto | **implemented tonight** |
| 2 | **Synthetic control via production cohort** | measures on the user's own workload, escaping the frozen suite entirely | blocked on reinstall |
| 3 | **LUCB best-arm identification** | allocates across CANDIDATES, an axis nothing currently optimises | next, when candidate volume rises |
| 4 | **Wald SPRT** | the asymmetry means most decisions are obvious; only the middle needs runs | needs 3 |
| 5 | **mSPRT always-valid p-values** | removes the fixed-n commitment without alpha inflation | needs 3 |
| 6 | **Successive Rejects** | fixed-budget sibling of 3, better suited to a quota | needs 3 |
| 7 | **Expected value of information** | prices a run before spending it — the honest form of "is this worth measuring" | after 1 |
| 8 | **e-values / e-processes** | anytime-valid evidence that composes across re-audits | after 4 |
| 9 | **Post-selection inference** | the re-audit regression-to-the-mean problem is exactly selection bias | partially handled by two-strike |
| 10 | **James-Stein shrinkage across rules** | correct once the pool is deep enough to borrow strength | THIN: 6 rules |

Ranks 3-10 all share one precondition: **more candidate rules than the ledger
has ever held.** They optimise allocation across candidates, and this project
has measured six rules in ten weeks. Building them now would be building for a
workload that does not exist — the same error that put four theorems in the tree
and then took three back out.

Rank 1 is different. It needs no new data, no new runs, and no new commands.

---

## What #1 found

The gate keeps a rule when `delta >= bar + z*SE`, with `z = 1.5`. That constant
was set by a net-token sweep, and the sweep priced a false positive at exactly
its rent. Nothing else. Reading the net-token column as `z` falls:

| z | stream FDR | kept | real kept | real missed | NET tok/run |
|---|---|---|---|---|---|
| 2.0 | 58.0% | 4.8 | 2.0 | 6.1 | 9,047 |
| **1.5 (shipped)** | 50.1% | 5.6 | 2.8 | 5.3 | **12,492** |
| 1.0 | 56.1% | 9.5 | 4.2 | 3.9 | 18,188 |
| 0.5 | 67.4% | 17.6 | 5.7 | 2.4 | 23,795 |
| 0.0 | 70.1% | 22.8 | 6.8 | 1.3 | 27,533 |

Monotone. Read naively it says the gate should be abolished — keep everything,
z = 0. That conclusion survives every overlap decay this project can defend, and
it is **an artifact of the missing term**, not a finding about the noise.

So `harm` is now a parameter: what one kept worthless rule costs per run BEYOND
its rent. Net tokens are linear in it, so the arms cross at exactly one point
and it is solved rather than searched:

```
h* = (netBeforeHarm_a - netBeforeHarm_b) / (falseKept_a - falseKept_b)
```

**Break-even harm, shipped z=1.5 against each alternative**, expressed against
the 14,018 tokens that Fact 2 says one extra tool call costs:

| overlap | vs z=0 | vs z=0.5 | vs z=1.0 | vs z=2.0 |
|---|---|---|---|---|
| 1.0 (additive) | 1,435 (10.2%) | 1,530 (10.9%) | 2,704 (19.3%) | 126,482 (902%) |
| 0.85 | 711 (5.1%) | 825 (5.9%) | 1,653 (11.8%) | 93,116 (664%) |
| 0.7 | 312 (2.2%) | 395 (2.8%) | 914 (6.5%) | 64,457 (460%) |

Read the two ends against each other, because that is the result:

- **Against every LOOSER gate**, break-even is 2.2%-19.3% of one tool call. The
  shipped `z=1.5` wins as long as a worthless rule provokes one extra tool call
  in more than roughly one session in twenty. For an unearned instruction
  sitting in the prompt every session, that is a low bar to clear.
- **Against the TIGHTER gate**, break-even is 460%-902% of a tool call. Going
  back to `z=2.0` needs a worthless rule to cost four to nine extra tool calls
  every session, which nothing supports.

**`z = 1.5` sits in a defensible interior, bracketed on one side by a plausible
harm and on the other by an absurd one.** It was already the shipped value; what
changed is that it is now defended by a falsifiable statement — *the gate is
correct iff a worthless rule provokes an extra tool call in more than ~5% of
sessions* — instead of by the output of a sweep with a hidden zero in it.

Nothing shipped in `src/`. No default moved. The whole of #1 is one parameter
and one division in a harness that spends no tokens, and the reason it is worth
having is that it converts an arbitrary constant into a measurable claim.

## How much of that number is real

Two of the three inputs were checked rather than asserted.

**Seed** — six seed families, `z=1.5` vs `z=0` at overlap 0.85:

| seed | 7 | 13 | 42 | 101 | 999 | 2026 |
|---|---|---|---|---|---|---|
| break-even | 711 | 725 | 686 | 752 | 705 | 662 |

Spread ±6% around ~707. The headline is not a seed artifact.

**Arrival rate** — the fraction of candidates carrying a genuine saving is a
modelling choice, and unlike the seed it moves the number a lot:

| true-rate | 5% | 10% | 20% | 40% |
|---|---|---|---|---|
| break-even | 258 | 404 | 711 | 885 |
| as one tool call | 1.8% | 2.9% | **5.1%** | 6.3% |

A 3.4x swing — but every value points the same way, and the low end points
*harder*. Fewer genuine candidates means the loose gate's extra keeps are more
often worthless, so the shipped gate wins at a lower harm. Across the whole
plausible range the claim is therefore **1.8%-6.3% of one tool call**, which is
a tighter statement than the single 5.1% figure it replaces.

## Honest limits

- `harm` is still not measured. This work makes it *nameable and falsifiable*,
  which is strictly less than measuring it. Measuring it means benchmarking
  agents carrying deliberately worthless rules — affordable, and the natural
  next burn.
- **One agent, and not by choice.** `backend`, `frontend` and `testing` each
  refuse the harness outright — *insufficient replicate history at runs=2/side*.
  They hold two runs per task, so there is no replicate pool to permute. Every
  number here is `sql`, and so is the 14,018-token tool call it is measured
  against.
- `overlap` remains a modelling choice, not a measurement — the same gap the
  packer's trigram proxy has.
- Ranks 3-10 are unbuilt on purpose. That is a judgement about workload volume,
  and it should be revisited if a real dogfood stream ever produces candidates
  faster than the gate can measure them.
