# Architecture

How token-warden is wired, end to end. For the *why* behind specific choices see
[DECISIONS.md](DECISIONS.md); for user-facing usage see the [README](README.md).

## Thesis in one line

Agent memory is charged "context rent" (every rule costs tokens on every future
call), so a rule earns its place only by proving, on a fixed benchmark, that it
saves more tokens than it costs. Everything below serves that single claim:
measure cost, propose rules, benchmark them, keep only the ones that pay.

## The loop

A four-stage, feed-forward pipeline. Lessons are extracted from finished
sessions and applied to future ones; past work is never redone.

```
  agent session (any project, any repo)
            |
            |  Stop / SubagentStop hook parses the transcript
            v
  [1] COLLECT  (src/collect.ts, src/transcript.ts)
            |  one row per session in SQLite; if cost > rolling p75, spawn the distiller
            v
  [2] DISTILL  (src/distill.ts)
            |  one model call (sonnet by default) over the waste trace -> 0-2 candidate rules
            v
  [3] BENCH    (src/bench.ts)
            |  golden suite on a frozen fixture, run with vs. without the candidate
            v
  [4] SELECT   (src/select.ts)
            |  keep if savings >= 2x context rent and no regression; else evict
            v
  agent memory MEMORY.md  (compiled from surviving rules, injected next session)
```

**Stages 1-2 are automatic and background.** The collector runs inside a Stop
hook under a hard sub-2-second budget and fails open (any error exits 0; a
session is never blocked). Distillation is spawned detached, so the model call
never sits on the hook budget.

**Stages 3-4 are an explicit, token-spending command** (`/warden-select`), so the
user controls when measurement spend happens. The compile step (stage 4's
output) overwrites the agent's `MEMORY.md`, which the agent reads next session.

## Integration surface

| Surface | Wiring | Purpose |
| --- | --- | --- |
| `Stop` / `SubagentStop` hooks | `hooks/hooks.json` -> `src/collect.ts` | Record session cost; trigger distillation |
| `SessionStart` hook | `src/notify.ts` | One-line nudge when candidates are pending (silent otherwise) |
| `PreToolUse` hook (`SendMessage`) | `src/gate.ts` | Inter-agent approval gate (fails open) |
| 6 slash commands | `commands/*.md` | `/warden-status`, `/warden-power`, `/warden-bench`, `/warden-select`, `/warden-receipt`, `/warden-cost` |
| 4 bundled subagents | `agents/{frontend,backend,sql,testing}.md` | The only agents with golden suites, so the only ones whose rules can be measured |

Work done on the main thread is cost-measured but never distilled: with no
golden suite, a rule for it could not be benchmarked. A bring-your-own agent
registered under `TOKEN_WARDEN_AGENTS_DIR` is a first-class agent — since
v0.36.0 the distiller gates on `knownAgents()` (`registry.ts`), not on the
bundled four, so a custom agent with a golden suite distills and benchmarks
exactly like `sql` or `backend`.

## Module map (`src/`)

| Module | Responsibility |
| --- | --- |
| `collect.ts` | Stop/SubagentStop entry; parse transcript, write a `runs` row, trigger distillation/alerts |
| `transcript.ts` | Streaming JSONL parser: usage (deduped by message id), tool/skill/MCP footprints |
| `distill.ts` | p75 trigger, one model call (sonnet default, best-of-K), strict-JSON candidate rules, trigram dedupe |
| `bench.ts` | Golden-suite runner on the frozen fixture; `runSuite`, baselines, suite hash |
| `select.ts` | Variance-aware keep/evict verdict, round-robin re-audit, compile `MEMORY.md` |
| `receipt.ts` | Per-rule evidence card from `rule_receipts` (`/warden-receipt`) |
| `power.ts` | Burn planner: how many runs a given effect needs before you spend on it |
| `cost.ts` / `pricing.ts` | The dollar lens. Advisory only — the keep/evict gate is denominated in TOKENS and never reads a price |
| `tool-cost.ts` | Classify tool/skill/MCP calls and roll up their footprint. Written by the Stop hook, read by the status dashboard |
| `status.ts` / `notify.ts` | Status dashboard and the SessionStart pending-candidate nudge |
| `gate.ts` | Inter-agent `SendMessage` approval prompt (sanitized, fails open) |
| `sanitize.ts` | Single presentation-security chokepoint (control/ANSI stripping) |
| `logfile.ts` | Single log sink: rotate at 1 MiB, sanitize, append. Every `*.log` next to the ledger goes through it |
| `db.ts` / `types.ts` | SQLite access, versioned migrations, shared types |
| `rules.ts` / `stats.ts` / `format.ts` / `model-call.ts` / `memory.ts` / `cli.ts` | Shared vocabulary: what a rule is, the estimators and gate constants, output formatting, the `claude -p` envelope, memory-file IO, the CLI entry convention |

### The four theorems (v1.0.0)

Pure, dependency-free modules holding the mathematics the gate depends on. Each
carries its guarantee as a test rather than as a claim, and none of them touches
IO, the database, or a model.

| Module | Responsibility |
| --- | --- |
| `fdr.ts` | False-discovery control: Benjamini-Hochberg over a fixed pool, LORD++ over the unbounded decision stream, plus the gate's one-sided p-value. Behind `WARDEN_ONLINE_FDR`, default OFF — measured and rejected, see FINDINGS.md |
| `halving.ts` | Successive Halving: a budget schedule across competing candidates, and the elimination rule. Pure — the caller drives the async benchmark |
| `knapsack.ts` | The kept SET under a context budget. Facility-location objective (monotone submodular by construction) with density-greedy plus the best-single-item guard |
| `moderate.ts` | Empirical-Bayes variance moderation (Smyth 2004) with digamma/trigamma. Behind `WARDEN_MODERATE_VARIANCE`, default OFF — measured and rejected |

Two of these are default-off because calibration rejected them. They stay in the
tree because a negative result is only trustworthy if the implementation was
correct, and both are tested to the same standard as the shipped code.

## Data model (`~/.token-warden/warden.db`, SQLite)

Seven tables, managed by an append-only `MIGRATIONS` array keyed on
`PRAGMA user_version` (currently 16 migrations; `MIGRATION_COUNT` in `src/db.ts` is
the authoritative count); migrations are never edited or
reordered, only appended.

| Table | Holds |
| --- | --- |
| `runs` | One row per session: token counters, tool calls, file re-reads, completion, ruleset version, project, model |
| `rules` | Candidate / active / evicted rules: body, status, `context_cost` (rent), `measured_delta`, source run |
| `baselines` | The frozen `run1_tokens` per task: the permanent denominator of every savings claim |
| `ruleset_versions` | Per-agent ruleset version counter (bumped on each compile) |
| `questions` | Cross-agent questions, fed to the distiller as a memory-gap signal |
| `tool_costs` | Per-session tool/skill/MCP footprint (real-work sessions only) |
| `rule_receipts` | Immutable evidence snapshot at every keep/evict decision (the audit trail) |

Everything is local. There is no server, no network call except the model
invocations the distiller and benchmark make, and no telemetry.

## Where the numbers come from

- **Token counts are measured, not estimated.** A session's cost is the sum of
  Claude's own `usage` counters (`input + output + cache_creation + cache_read`)
  read from the transcript, deduplicated by API message id so streamed blocks of
  one message are counted once (`transcript.ts`).
- **Context rent** starts as `Math.ceil(body.length / 4)` (`distill.ts`) — a
  rough characters-per-token estimate of a rule's prompt cost. The gate compares
  against `effectiveRent` (`select.ts`), which is cache-aware: it prices in the
  one-time cache re-prefill a ruleset change forces, so the 2x bar gets harder,
  never easier. Promotion needs the saving to clear that bar by `z` standard
  errors (`WARDEN_CONFIDENCE_Z`, default 2).
- **Design constants** (chosen, not derived): the `2x` keep threshold, the `p75`
  distill trigger with a 5-run minimum, the default `3` runs per task, the `0.85`
  trigram dedupe cutoff, the `>25%` high-variance flag, and the `10%`
  meta-cost overhead warning.

## Design invariants

1. **Measured, not claimed.** A rule enters memory only after the local selector
   measures it; imported/shared rules are re-measured, never trusted.
2. **`MEMORY.md` is generated.** It is compiled wholesale from surviving rules
   and never hand-edited.
3. **Baselines are frozen forever.** `run1_tokens` is captured once per task and
   never overwritten; the suite grows only by *adding* task files with fresh ids,
   never by editing existing ones.
4. **Hooks fail open.** Any collector/gate error exits 0; a user session is never
   blocked or broken.
5. **Same-result savings only.** The distiller proposes efficiency rules, never
   correctness rules; any rule that drops a task from pass to fail is evicted
   regardless of token savings.

## Testing and CI

The hot path carries no runtime dependencies beyond `better-sqlite3` and `zod`; inputs
from models and transcripts are schema-validated (`zod`) and sanitized at the
boundary. The suite (`vitest`) holds the line at a ratcheted coverage floor, and
a staged GitHub pipeline gates every change: `quality` (lint, typecheck, `knip`
dead-code, version consistency) -> `test` (Node 22/24), `fixture`, `coverage` ->
`validate` (plugin-manifest + CLI smoke) -> `release` (tag-only, publishes from
`CHANGELOG.md`). See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow.
