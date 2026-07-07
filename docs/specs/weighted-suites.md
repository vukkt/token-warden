# Spec: distribution-weighted golden suites

## Why
Every task currently counts equally in a verdict, so a rule protecting a rare
but expensive production case is diluted by common cheap tasks. Weighting the
suite to the production task distribution makes the measured delta reflect
what the rule is actually worth in real work. This CHANGES THE GATE, so the
statistics must be exact and calibration-proven before it ships.

## Design
1. `parseGoldenTask` (src/bench.ts): optional frontmatter `weight: N` — a
   positive finite number, default 1. Invalid values (0, negative, NaN,
   non-numeric) throw with the file path. `GoldenTask.weight: number`.
2. `TaskSummary` (src/bench.ts) gains `weight: number` (default 1).
   `summarizeTask` gains an optional weight param defaulting to 1; `runSuite`
   passes the task's weight through. All existing constructors/tests default
   to 1 and stay numerically identical.
3. Weighted estimators in src/select.ts (this is the core — be exact):
   - In `perTaskComparisons`, carry the BASELINE side's weight per comparison
     (`TaskComparison.weight`, from the without-summary; document why: the
     reference defines the suite composition).
   - Weighted mean saving: sum(w_i * s_i) / sum(w_i).
   - Within-task SE with weights: Var(weighted mean) =
     sum(w_i^2 * (s2_without_i/n_wo_i + s2_with_i/n_w_i)) / (sum(w_i))^2 —
     the exact propagation of independent per-task noise through the weighted
     mean. The K^2 in the current code IS this formula for w_i = 1; refactor
     `withinTaskSE` to take weights and keep the unweighted path identical.
   - Between-task fallback (runs=1): weighted sample variance of savings with
     reliability weights: var_w = sum(w_i*(s_i - mean_w)^2)/(sum(w_i) - sum(w_i^2)/sum(w_i)),
     SE = sqrt(var_w * sum(w_i^2)) / sum(w_i). Document the estimator choice.
   - Neyman top-up (`allocateTopUpRuns`): the marginal SE reduction of one
     extra run on task i scales by w_i^2: marginal = w_i^2 * s2_i/(n_i(n_i+1)).
     Weight the greedy accordingly (weights from the reference summaries).
   - Robust/tail-risk path: weight robustSavingsMean identically to the mean.
4. `assessDelta` signature unchanged (weights ride on TaskSummary). When every
   weight is 1 all outputs are bit-identical to today (pin with a test).
5. Selector output: when any task weight != 1, append ", WEIGHTED" to the
   decision line in select.ts main() so a weighted verdict is visible.
6. Calibration proof (validation/calibration.ts): add a weighted scenario —
   same synthetic model, weights [4,1,1,1,1] — reporting FP at z=2 for
   runs {2,3,5} alongside the unweighted numbers. The PR is correct only if
   weighted FP stays within ~1 point of unweighted (state the numbers in your
   report; if FP inflates, your estimator is wrong — fix it, do not ship the
   inflation).

## Constraints
- No DB migration. No CHANGELOG/README/knip/package.json edits. No emojis.
- Do not change verdict(), effectiveRent(), or the 2x-rent bar.
- Do not edit any frozen benchmarks/*/golden-*.md (weights are for FUTURE
  tasks and user suites; defaults keep old suites unweighted).

## Tests (extend test/select.test.ts + test/variance.test.ts + test/bench units)
- parseGoldenTask weight parsing: absent -> 1; "2.5" -> 2.5; "0"/"x" throw.
- Bit-identical regression: a fixed unweighted scenario produces the same
  delta/SE/uncertain before and after (hardcode expected numbers).
- Weighted mean: two tasks, savings {100, 400}, weights {3, 1} -> delta 175.
- Weighted SE: hand-compute a two-task case and assert to 1e-6.
- Neyman with weights: high-weight noisy task receives the runs.
- An end-to-end selectForAgent case with weighted summaries where the verdict
  FLIPS relative to unweighted (rule saves on the heavy task only) — proving
  the plumbing reaches the gate — and the decision line carries ", WEIGHTED".

## Gate (exit codes): npm run format && npm run lint && npm run typecheck && npx knip && npx vitest run
Also RUN the extended calibration (npx tsx validation/calibration.ts) and put
the weighted-vs-unweighted FP table in your final report.
