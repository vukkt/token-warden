# Changelog

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
