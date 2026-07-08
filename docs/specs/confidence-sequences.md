# Spec: anytime-valid confidence sequences as a retention-policy column

## Why
Two-strike retention is calibrated but ad hoc. The principled tool for
"repeatedly test accumulating measurements without inflating error" is an
anytime-valid confidence sequence (time-uniform bounds; Robbins, Howard et
al.). Before ever considering it for production, it must EARN its way in via
the same simulation that validated two-strike. This PR touches ONLY
validation/calibration.ts (plus its own tests if you add pure exports) —
zero production code.

## Pre-declared decision criterion (write it in the section header)
The CS policy wins only if BOTH: dead-rule expected exit <= 8 cycles AND
true-earner expected lifetime >= two-strike's at every effect size in the
table. Otherwise two-strike stays; a negative result is a valid, reportable
outcome — do not tune the policy after seeing results to force a win.

## Design (extend the existing churn section of validation/calibration.ts)
1. Model: at each re-audit cycle t the rule gets an iid measurement
   d_t ~ side-effect of the existing reAuditSubThreshold machinery — reuse the
   same simulated assessDelta point estimates. Maintain the running mean over
   ALL past re-audits (re-audit evidence accumulates across cycles under CS,
   unlike the memoryless one/two-strike policies).
2. Boundary: the normal-mixture time-uniform bound. With per-audit standard
   error SE (estimate it from the same simulation draws), after t audits the
   anytime-valid interval half-width is
     u(t) = SE * sqrt( ((t*rho^2 + 1) / (t^2 * rho^2)) * log( (t*rho^2 + 1) / alpha^2 ) )
   with alpha = 0.05 and rho = 1 (document both; cite Howard et al. 2021
   "Time-uniform, nonparametric, nonasymptotic confidence sequences" as the
   source of the mixture form). UCB_t = mean_t + u(t); LCB_t = mean_t - u(t).
3. Policy "confidence-sequence": evict when UCB_t < bar (anytime-valid
   confidence the rule does NOT earn its bar). Regressions still evict
   immediately (same as every policy).
4. Simulate expected lifetimes exactly like the existing churn table
   (analytic where possible, Monte-Carlo otherwise — MC is fine here since
   the policy is path-dependent; 2000 rule-lifetimes per cell, cap simulated
   life at 500 cycles and report ">500"). Effects {0, 3000, 6000, 12000},
   both noise models, runs=3.
5. Output: extend the churn tables with a "conf-seq life" column and print a
   verdict line applying the pre-declared criterion. EXPECTED finding (state
   it honestly if it lands): because bar (~54 tok) << SE (thousands), UCB_t
   needs t ~ (SE/bar)^2 audits to shrink below the bar, so dead rules
   essentially never exit under pure CS — the criterion fails and two-strike
   survives. If that is the outcome, the section's closing text should say
   the negative result and why (the bar/SE ratio, not the CS theory, is the
   binding constraint).

## Constraints
- validation/calibration.ts only (it executes on import — keep that shape; if
  you want unit tests, extract pure helpers into the file and test via a
  child-process run, or skip unit tests and rely on the harness run).
- No production src/ changes. No CHANGELOG/README/knip/package.json edits.
- No emojis. Deterministic seeds.

## Gate: npm run format && npm run lint && npm run typecheck && npx knip && npx vitest run
Then RUN the harness (npx tsx validation/calibration.ts) and include the full
new churn tables + the criterion verdict in your final report.
