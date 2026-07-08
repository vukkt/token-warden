# Spec: split the noisy golden tasks (sql-02, testing-02)

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
