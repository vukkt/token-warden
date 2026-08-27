# Four specs, and what became of them

Build specs written for the v0.36.0/v0.37.0 worktree agents. They were four
separate files; the work is finished, so they are one. Each keeps its original
status banner — two shipped, one shipped after a correction, one was measured
and rejected. The rejection is the reason this file still exists.

---

## Spec: bring-your-own-agent (BYOA)

**Status: SHIPPED in v0.36.0** (`src/registry.ts`).

## Why
The four domain agents (frontend/backend/sql/testing) are a hardcoded tuple
(`DOMAIN_AGENTS`, src/types.ts) validated in ~76 call sites. An outside user
cannot point token-warden at their own agents or workload — the productization
wall. This PR makes the agent set discoverable while keeping the bundled four
as defaults, with zero behavior change when no custom agents exist.

## Design
1. New module `src/registry.ts`:
   - `export function userAgentsDir(): string` — `process.env.TOKEN_WARDEN_AGENTS_DIR ?? join(homedir(), ".token-warden", "agents")`.
   - `export function userBenchmarksDir(): string` — `process.env.TOKEN_WARDEN_BENCHMARKS_DIR ?? join(homedir(), ".token-warden", "benchmarks")`.
   - `export function knownAgents(): string[]` — DOMAIN_AGENTS plus the basenames of `<userAgentsDir()>/<name>.md` files (name pattern `^[a-z][a-z0-9-]{1,31}$`; ignore others), deduped, bundled order first then custom sorted. Never throws: a missing/unreadable dir contributes nothing.
   - `export function assertKnownAgent(agent: string): void` — throws `--agent must be one of: <list> (got "...")` matching the existing error style.
2. `src/bench.ts`:
   - `loadAgentDefinition(agent)`: bundled `agents/<agent>.md` first, else `<userAgentsDir()>/<agent>.md`, else the existing error.
   - `loadGoldenTasks(agent)`: bundled `benchmarks/<agent>/` first; if the bundled dir is absent, read `<userBenchmarksDir()>/<agent>/` with the same `golden-\d+.md` pattern; error message must mention BOTH paths when neither exists.
3. Replace every `(DOMAIN_AGENTS as readonly string[]).includes(...)` validation with `assertKnownAgent(...)` (or `knownAgents().includes(...)` where a boolean is needed), and every `[...DOMAIN_AGENTS]` "all agents" iteration with `knownAgents()`. Grep for `DOMAIN_AGENTS` and convert ALL call sites outside types.ts; the constant itself stays exported as the bundled default set.
4. `collect.ts` / `notify.ts` / `distill.ts` agent filtering follows automatically via knownAgents(); main-thread ("main") still never distills — that guard is by agent name "main", keep it.

## Constraints
- No DB migration. No CHANGELOG/README/knip/package.json edits (integrator owns those).
- Behavior with no user dirs set and none existing must be byte-identical to today (all existing tests pass unchanged).
- No emojis anywhere. Tabs, biome, repo JSDoc idiom.

## Tests (test/registry.test.ts + minimal edits elsewhere)
- knownAgents(): defaults only when user dir absent; includes valid custom names; rejects bad basenames (uppercase, dots, >32 chars); dedupes an override of a bundled name.
- assertKnownAgent throws with the full discovered list in the message.
- loadAgentDefinition + loadGoldenTasks resolve from a temp user dir via the env overrides (write a real agent .md and a golden-01.md in tmp); bundled agents unaffected.
- One CLI-level test: parseSelectArgs (or select main validation) accepts a custom agent when TOKEN_WARDEN_AGENTS_DIR provides it. NOTE: parseSelectArgs is pure argv parsing — put the agent check wherever it lives after your refactor and test THAT.
- Env cleanup in afterEach (delete the env vars).

## Gate (all by exit code, before you finish)
npm run format && npm run lint && npm run typecheck && npx knip && npx vitest run

---

## Spec: split the noisy golden tasks (sql-02, testing-02)

**Status: SHIPPED in v0.36.0** (sql-06/07, testing-05/06; frozen originals
untouched).

## Why
/warden-health's variance ranking and the empirical calibration both show the
suites' noisiest tasks bury real savings: sql's minimum detectable saving is
~12,300 tok/run at default runs because run-to-run variance is huge, and
sql-02 / testing-02 are the named offenders (>25% CV; testing-02 ~150k
tok/run). Narrower tasks = lower per-task variance = lower SE = cheaper,
sharper verdicts for every future burn.

## Hard invariant
Frozen tasks are NEVER edited (invariant #4). benchmarks/sql/golden-02.md and
benchmarks/testing/golden-02.md stay byte-identical. New tasks are ADDED as
the next numbers: benchmarks/sql/golden-04.md + golden-05.md and
benchmarks/testing/golden-05.md + golden-06.md (existing: sql 01-03,
testing 01-04). New tasks have no run1 baselines until first benched — that is
fine and expected (baselines freeze on first bench).

## Design
Read the two originals and the fixture repo (benchmarks/fixture — a real
npm package with tests and typecheck). Split each original's *scope* into two
narrower, independent sub-tasks:
- sql-04 / sql-05: split sql-02's coordinated schema+repository change into
  (a) a schema-layer-only task and (b) a repository-layer-only task, each with
  its own deterministic success_check. The checks must be runnable inside a
  COPY of the fixture (same style as existing: grep + npx vitest run), must
  FAIL on the pristine fixture, and PASS once the described work is done. Use
  DIFFERENT concrete columns/functions than sql-02 so the tasks are not
  literal subsets of an existing frozen task (avoid cross-task contamination
  via memory rules).
- testing-05 / testing-06: read testing-02; identify why it costs ~150k
  (breadth). Split into two tasks each covering roughly half its surface,
  same rules as above.

## Verification you must perform (zero model tokens)
For EACH new task: in a scratch copy of benchmarks/fixture (cp -R to a temp
dir), (1) run the success_check and prove it FAILS (exit non-zero); (2) apply
the described change by hand (you edit the files as the task asks); (3) run
the success_check and prove it PASSES; (4) run the fixture's own npm test +
typecheck to prove your reference solution does not break the package. Record
the four exit codes for each task in your final report. Delete scratch dirs.

## Frontmatter format (exact)
---
id: sql-04
agent: sql
prompt: "..."
success_check: "..."
---
Followed by 1-3 lines of prose stating what the task verifies (see existing
files). id must match filename number. Prompt and success_check on ONE line
each, double-quoted.

## Tests
Extend the existing suite minimally: find any test pinning golden task counts
or suite hashes (grep tests for loadGoldenTasks / goldenSuiteHash / task
counts) and update expectations; add one test asserting the four new files
parse via parseGoldenTask and carry unique ids within their agent.

## Constraints
No emojis. No CHANGELOG/README/knip/package.json edits. Do not touch any
frozen golden-*.md. Gate before finishing (all by exit code):
npm run format && npm run lint && npm run typecheck && npx knip && npx vitest run

---

## Spec: distribution-weighted golden suites

**Status: SHIPPED in v0.37.0**, with the effective-DoF correction added after
calibration rejected the first cut.

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

---

## Spec: anytime-valid confidence sequences as a retention-policy column

**Status: TESTED AND REJECTED in v0.36.0** — the bar/SE ratio is binding, so a
dead rule never exits (~492 cycles vs two-strike's 5.9). Two-strike retention
stays. Kept for provenance; do not implement.

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

---

