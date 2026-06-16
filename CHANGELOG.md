# Changelog

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
