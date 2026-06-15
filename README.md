# token-warden

[![CI](https://github.com/vukkt/token-warden/actions/workflows/ci.yml/badge.svg)](https://github.com/vukkt/token-warden/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A Claude Code plugin that makes coding agents measurably cheaper over time.**

Most "agent memory" accumulates advice nobody ever verifies. token-warden treats agent
memory as an engineering problem: every rule that wants space in an agent's context must
**prove, on a fixed benchmark, that it saves more tokens than it costs** — or it gets
evicted. The result is a per-agent memory file containing only rules with measured,
positive return.

- **Measured, not vibes** — every rule carries a token delta from real benchmark runs
- **Self-funding** — rules must save ≥ 2× their own context rent to stay
- **Self-auditing** — active rules are re-benchmarked round-robin and evicted when they
  stop earning
- **Zero session overhead** — collection runs in a Stop hook that never blocks or fails
  your work

---

## Table of contents

- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Commands](#commands)
- [The benchmark system](#the-benchmark-system)
- [Architecture](#architecture)
- [The agents](#the-agents)
- [Inter-agent approval gate](#inter-agent-approval-gate-experimental)
- [Design invariants](#design-invariants)
- [A recorded demonstration](#a-recorded-demonstration)
- [Testing](#testing)
- [Data layout](#data-layout)
- [Security notes](#security-notes)
- [Roadmap](#roadmap)

---

## How it works

The optimizer is a four-stage, feed-forward loop. Lessons are extracted from finished
sessions and applied to future ones — past work is never re-done.

```
                  agent session (any project, any repo)
                                  │
                                  │  Stop hook · parses the transcript:
                                  │  tokens, tool calls, file re-reads, completion
                                  ▼
                ┌─────────────────────────────────────┐
                │  1 · COLLECT                        │
                │  one row per session in SQLite      │
                └─────────────────────────────────────┘
                                  │
                                  │  fires only when a run exceeds the
                                  │  agent's rolling p75 token cost
                                  ▼
                ┌─────────────────────────────────────┐
                │  2 · DISTILL                        │
                │  one haiku call over the waste      │
                │  stats → 0–2 candidate rules        │
                └─────────────────────────────────────┘
                                  │
                                  │  candidates wait in SQLite —
                                  │  never injected until measured
                                  ▼
                ┌─────────────────────────────────────┐
                │  3 · BENCH                          │
                │  golden suite on a frozen fixture,  │
                │  run with vs. without the candidate │
                └─────────────────────────────────────┘
                                  │
                                  │  measured delta vs. context rent
                                  ▼
                ┌─────────────────────────────────────┐
                │  4 · SELECT                         │
                │  keep if savings ≥ 2× rent, else    │
                │  evict · re-audit the oldest rule   │
                └─────────────────────────────────────┘
                                  │
                                  ▼
              ~/.claude/agent-memory/<agent>/MEMORY.md
        compiled wholesale from surviving rules and injected
            into the agent's system prompt next session
```

**1 · Collect.** `Stop` and `SubagentStop` hooks fire after every turn (main session and
subagent work respectively) and parse the session transcript
into one ledger row: input/output/cache tokens (deduplicated by API message id — the
transcript repeats usage per streamed block), tool-call count, files read more than once,
and whether the session completed. The hook is hard-capped under the 2-second budget,
wraps every failure, and exits 0 regardless — it can never break your session.

**2 · Distill.** Collection is cheap, analysis is not, so analysis is rationed: only runs
above the agent's rolling 75th-percentile cost (minimum 5 prior runs) are distilled. A
single detached haiku-tier call receives the waste statistics plus an 8 KB action trace
and must return strict JSON: at most two one-sentence, generalizable rules. Invalid output
is dropped, never retried. Near-duplicates of *any* existing rule — including evicted
ones — are rejected by trigram similarity, so a falsified rule cannot be re-proposed.

**3 · Bench.** Candidates are measured on a golden task suite against a frozen fixture
repository (see [The benchmark system](#the-benchmark-system)). Each configuration runs
the suite headlessly in a throwaway copy with the candidate compiled into a temporary,
fully isolated agent memory.

**4 · Select.** A rule's verdict is the spec inequality: with `delta` = mean tokens saved
per completed golden run and `rent` = the rule's own size in tokens, the rule goes active
iff `delta × sessions/week ≥ 2 × rent × sessions/week`. Failing a previously-passing task
is instant eviction regardless of tokens. Every selector run also re-benchmarks the
least-recently-audited active rule — memory must keep earning its place. Survivors are
compiled into `MEMORY.md`, which Claude Code injects into the agent's system prompt.

---

## Getting started

### Prerequisites

- Node.js 22+
- Claude Code v2.1+ (`claude --version`)
- macOS or Linux (Windows via WSL — benchmarks need a POSIX shell)

### 1 · Clone and install

```bash
git clone https://github.com/vukkt/token-warden.git
cd token-warden
npm install        # the hooks run via the plugin's own tsx + better-sqlite3
```

### 2 · Load the plugin

For the current session:

```bash
claude --plugin-dir /path/to/token-warden
```

Or install persistently — this repository is also its own marketplace:

```text
/plugin marketplace add vukkt/token-warden
/plugin install token-warden@vukkt-plugins
```

> Marketplace installs are copied to `~/.claude/plugins/cache` without `node_modules`.
> The Stop hook bootstraps its own dependencies on first run (one-time `npm install`,
> silent); collection begins from the second session at the latest.

### 3 · Verify collection

Work normally for a turn or two, then:

```text
/warden-status
```

You should see a `runs` count for `main`. Every session in every project is now being
measured into `~/.token-warden/warden.db`.

### 4 · Freeze the baselines (one-time, ~20 min per agent)

```bash
npm run bench -- --agent all      # or one agent at a time
```

This runs each agent's three golden tasks twice and freezes `run1_tokens` — the permanent
denominator of every future improvement claim. Do this once, before any rules exist.

### 5 · Let the loop run

Use the four subagents (`frontend`, `backend`, `sql`, `testing`) for real work.
Expensive sessions distill into candidates automatically. When `/warden-status` shows
candidates pending, measure them:

```bash
npx tsx src/select.ts --agent sql
```

Active rules land in the agent's memory; the next session starts cheaper.

---

## Commands

| Command | What it does |
|---|---|
| `/warden-status` | Read-only report: per-agent run/rule counts, suite total vs. frozen baseline (absolute + %), learning curve over time, active rules with measured deltas and provenance, recent evictions with reasons, real-work tokens by project, cross-agent question volume |
| `/warden-bench <agent\|all> [--runs N] [--task id]` | Runs the golden suite, compares against `run1` and `best`, and reports benchmarking meta-cost (warns above 10% of the week's real-work tokens) |
| `/warden-select <agent> [--runs N] [--top-up N]` | Measures pending candidates, evicts or activates them, re-audits the oldest active rule, and recompiles the agent's memory |
| `/warden-modelbench <agent> --model <id> [--baseline <id>] [--runs N]` | Runs the agent's golden suite under two models (candidate vs. the agent's current model, rules held constant) and reports which uses fewer tokens for that workload |
| `/warden-promptbench <agent> --variant <file.md> [--runs N]` | Runs the agent's golden suite under two prompts (a variant agent definition vs. the shipped one, rules and model held constant) and reports which uses fewer tokens |
| `/warden-evolve <agent> [--runs N]` | Proposes a token-cheaper rewrite of the agent's prompt (model call), benchmarks it, and recommends it only if it provably wins — never auto-applied |
| `/warden-share <agent> [--out path]` | Exports the agent's active rules (with measured deltas + provenance) to a committed, reviewable file so a team can version and review agent memory like code |
| `/warden-adopt --from <path>` | Imports a shared rule ledger as local *candidates* — the foreign delta is discarded and each rule must be re-measured on your own golden suite before it enters memory |

When candidate rules are waiting, a lightweight `SessionStart` hook injects a one-line
nudge into new sessions — selection itself always stays a user decision, because it
spends real benchmark tokens.

When a session ends unusually expensive for its agent (≥ 2× the agent's recent median,
given ≥ 5 prior sessions), the `Stop` hook surfaces a one-line cost-anomaly heads-up to
*you* via `systemMessage` — it informs, it does not feed the model (no behavioral loop).
Opt out with `TOKEN_WARDEN_NO_ALERTS=1`.

Headless or when names collide, use the namespaced forms
(`/token-warden:warden-status`). CLI equivalents:

```bash
npx tsx src/status.ts                              # status report
npm run bench -- --agent sql [--rule N]            # benchmark runner
npx tsx src/select.ts --agent sql                  # selector (measure + evict + compile)
npx tsx src/modelbench.ts --agent sql --model haiku  # compare a model against the agent's default
npx tsx src/promptbench.ts --agent sql --variant v.md  # compare a prompt variant against the shipped one
npx tsx src/evolve.ts --agent sql                      # propose + measure a cheaper prompt variant
```

---

## The benchmark system

Measurement is only as good as its control variables. token-warden controls them
aggressively:

**The fixture** (`benchmarks/fixture/`) is a small but realistic full-stack TypeScript
project — Express routes → services → repositories over SQLite, a React admin UI, a
partial vitest suite — **frozen at Phase 2 and never modified**, so baselines stay
comparable across months. It ships with documented, deliberate flaws (`BUGS.md`, which
agents never see: the benchmark runner excludes it from every copy) that the golden tasks
target.

**Golden tasks** (`benchmarks/<agent>/golden-NN.md`) — three per agent, each a frontmatter
file with a one-sentence `prompt` and a shell `success_check` (greps and/or a full
`vitest run`). A run only counts as *completed* if its check passes: a cheap failed run
is worse than an expensive successful one, and incomplete runs are excluded from all
savings math.

**A benchmark run**, end to end:

1. Copy the fixture to a temp dir (`node_modules` symlinked; `BUGS.md` excluded).
2. Install the agent definition into the copy with its memory scope rewritten to
   `project`, so the compiled `MEMORY.md` under test resolves *inside the temp dir* —
   real agent memory is never read or written by benchmarks.
3. Compile the rule set under test (active rules ± one candidate) into that memory.
4. Run `claude -p --agent <name>` headlessly with **scoped permissions**: `acceptEdits`
   plus a Bash allowlist of test commands only — never `bypassPermissions`.
5. Run the `success_check`; parse the transcript; record one `runs` row.
6. First-ever completed run per (agent, task) freezes `baselines.run1_tokens` forever;
   later completed runs only ratchet `best_tokens` downward.

**Variance and honesty.** Each configuration runs twice and pairs of runs differing by
more than 25% are flagged in the output. LLM variance is the dominant error source at
small effect sizes — the recorded demonstration below shows it evicting a rule. The
selector is variance-aware: it computes the standard error of the per-task savings, and
when a verdict sits within one standard error of the keep/evict threshold it spends one
bounded **top-up pass** (extra suite runs of the measured configuration, budget
configurable via `--top-up`, default 1) before deciding; verdicts that remain within
noise are recorded with an explicit low-confidence annotation. The benchmark also
reports its own **meta-cost** after every invocation: when benchmarking exceeds 10% of
the week's collected real-work tokens, it tells you to bench less.

---

## Architecture

| Module | Responsibility |
|---|---|
| `src/db.ts` | SQLite schema, versioned migrations (`PRAGMA user_version`), typed query helpers |
| `src/transcript.ts` | Pure transcript JSONL parser — usage dedup, tool calls, re-reads, completion heuristic, distiller digest |
| `src/collect.ts` | Stop-hook entrypoint; p75 trigger; spawns the distiller detached |
| `src/distill.ts` | Waste analysis → 0–2 strict-JSON candidate rules; trigram dedupe |
| `src/bench.ts` | Golden-suite runner; baseline freezing; meta-cost accounting |
| `src/select.ts` | Keep/evict verdicts; round-robin re-audit; `MEMORY.md` compiler |
| `src/status.ts` | Read-only reporting behind `/warden-status` |
| `src/gate.ts` | Inter-agent `SendMessage` approval gate (Agent Teams) |
| `src/notify.ts` | SessionStart nudge when candidates await measurement |
| `src/compare.ts` | Generic A/B comparison engine (processing-token verdict, variance top-up, `runComparison` orchestration) shared by model, prompt, and prompt-evolution benchmarking |
| `src/modelbench.ts` | Model-migration benchmarking: candidate model vs. agent default |
| `src/promptbench.ts` | Prompt A/B benchmarking: variant agent definition vs. shipped |
| `src/evolve.ts` | Automated prompt evolution: propose a cheaper prompt (model call) → measure → recommend |
| `src/share.ts` | Export an agent's active rules to a committed, reviewable ledger artifact |
| `src/adopt.ts` | Import a shared ledger as local candidates (foreign delta discarded; re-measured locally) |

Data model (`~/.token-warden/warden.db`): `runs` (one row per session or golden run,
tagged `real`/`active`/`candidate`/`audit`), `rules` (the ledger — candidates, active
rules with measured deltas, and evicted rules kept as the negative dataset),
`baselines` (frozen `run1_tokens`, ratcheting `best_tokens`), `ruleset_versions`, and
`questions` (the inter-agent ledger). Every deviation from the original specification is
documented in [`DECISIONS.md`](DECISIONS.md).

---

## The agents

`frontend`, `backend`, `sql`, and `testing` (`agents/*.md`) are standard Claude Code
subagents with `memory: user` and domain-scoped prompts seeded with efficiency behaviors
(Grep before Read, never re-read a file, one-line plan before editing). Use them like any
subagent — the optimizer extends each one's memory independently. Per-agent isolation is
deliberate: a rule that pays rent for the sql agent is never charged to the frontend
agent's context.

---

## Inter-agent approval gate (experimental)

With `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, a `PreToolUse` hook intercepts every
`SendMessage` between agents and escalates to you:

```
[frontend → backend] "What does the orders service return on partial failure?" — approve?
```

Every question is logged to the `questions` table — approved sends are confirmed by a
`PostToolUse` hook; denied ones stay pending — and per-agent question volume surfaces in
`/warden-status`. An agent that asks a lot is an agent whose memory is missing something.
Without the env flag the gate is structurally inert and everything else works untouched.
The gate fails open: an internal error defers to the normal permission flow rather than
blocking team messaging.

---

## Design invariants

1. **Candidate rules are never injected until measured.** Unverified rules get no
   context space; candidates live only in SQLite.
2. **`MEMORY.md` is a build artifact** — compiled from the rule ledger, overwritten
   wholesale, never hand-edited or agent-appended.
3. **Fitness = tokens per completed task.** Incomplete runs are excluded from savings
   math.
4. **Golden tasks run against the frozen fixture**, never a live codebase.
5. **First-run baselines are frozen forever.** `run1_tokens` is the permanent
   denominator of every improvement claim.
6. **The optimizer never re-does past work** — all learning is feed-forward.
7. **Eviction is mandatory.** Rules must earn at least 2× their context rent, and active
   rules are re-audited round-robin.

---

## A recorded demonstration

Recorded 2026-06-12; every number is from real headless runs.

**A candidate is born.** Run #13, an `sql` golden run, cost **61,003 tokens** — above the
agent's rolling p75. The distiller proposed two candidates:

| rule | body | rent |
|---|---|---|
| #3 | "Consolidate file discovery into single queries instead of multiple find/ls operations across related paths." | 27 |
| #4 | "Parse task descriptions for technical direction; verify schema/dependencies only if code doesn't clarify them." | 28 |

**The selector measures them** (24 headless runs: shared baseline, one configuration per
candidate, one re-audit). Mean completed tokens per task:

| configuration | sql-01 | sql-02 | sql-03 | delta |
|---|---|---|---|---|
| baseline (active set) | 39,572 | 70,762 ⚠ | 50,304 | — |
| + rule #3 | 39,541 | 67,114 | 52,116 | **+622 saved/run** |
| + rule #4 | 39,664 | 54,244 | 49,538 | **+5,731 saved/run** |
| − rule #1 (re-audit) | 39,671 | 49,006 | 44,315 ⚠ | rule #1 worth **−9,215** |

⚠ = the two same-configuration runs differed by >25%.

**Verdicts** (threshold: savings ≥ 2× rent):

- rule #3 → **ACTIVE** (622 ≥ 54)
- rule #4 → **ACTIVE** (5,731 ≥ 56)
- rule #1 ("Use Grep to locate symbols before reading any file."), active since the
  previous selector run at +3,673, was **EVICTED** on re-audit at −9,215: with the two
  new rules present, removing it made the suite cheaper. This is mandatory eviction
  working as designed — and an honest illustration that run-to-run variance dominates at
  small effect sizes. Evicted rules are retained as the negative dataset, and trigram
  dedupe prevents a falsified rule from being re-proposed.

**The compiled memory** (`~/.claude/agent-memory/sql/MEMORY.md`, ruleset v2):

```markdown
<!-- GENERATED BY token-warden — do not hand-edit -->
# Efficiency rules

- Parse task descriptions for technical direction; verify schema/dependencies only if code doesn't clarify them.
- Consolidate file discovery into single queries instead of multiple find/ls operations across related paths.
```

---

## Testing

```bash
npm run typecheck && npm run lint && npm run test
```

The unit suite — ~160 tests across every module, shown passing by the CI badge above
(an exact count is left out of prose because it rots between releases) — covers the lot.
The transcript parser carries the densest coverage
(usage dedup, completion heuristics, malformed-line tolerance, a 5 MB / 2 s performance
budget) against committed anonymized fixtures. The hook entrypoints (`collect.ts`,
`gate.ts`) are tested as real child processes against temp databases, including
corrupt-input and fail-open paths. The selector core is tested with an injected fake
suite-runner, so verdict logic, regression eviction, re-audit, and memory compilation
are verified without spending model tokens. Strict TypeScript (`noUncheckedIndexedAccess`),
Biome for lint/format, vitest for tests.

The fixture has its own independent suite (`cd benchmarks/fixture && npm test`) and is
excluded from plugin CI — its deliberate flaws are benchmark material, not bugs.

---

## Data layout

| Path | Contents |
|---|---|
| `~/.token-warden/warden.db` | The ledger (override with `TOKEN_WARDEN_DB`) |
| `~/.token-warden/{collect,distill,gate}.log` | Component logs — hooks never surface errors into sessions |
| `~/.claude/agent-memory/<agent>/MEMORY.md` | Compiled rules (generated; do not hand-edit) |
| `benchmarks/fixture/` | The frozen benchmark codebase |

---

## Security notes

The ledger contains untrusted text: rule bodies and eviction reasons are
model-generated, project paths and question senders come from the environment.
Defenses, in order:

1. The distiller rejects rule bodies containing control characters or
   newlines at the source.
2. `renderStatus` sanitizes every untrusted string it displays (ANSI/control
   characters stripped, newlines collapsed, length clamped), so collected data
   cannot forge report sections.
3. The `/warden-status` command instructs the relaying Claude to treat report
   contents as data, never as instructions.

The inter-agent gate is an observability and approval layer, not a security
boundary — it fails open by design so a broken gate can never block team
messaging.

## Roadmap

Shipped through v0.9.0 (10 releases) — see [CHANGELOG.md](CHANGELOG.md) for the full
history: the original spec's collect/benchmark/distill/select loop, subagent collection,
variance-aware verdicts, cross-project learning curves, model-migration and prompt A/B
benchmarking, automated prompt evolution, and real-time cost-anomaly alerting.

Near-term:

- **Golden suite growth** — heavy tasks (`testing-02` ≈ 150k tokens/run) deserve
  splitting into new tasks (existing baselines stay frozen; replacing a task would
  invalidate its denominator, so growth means *adding* task files, never editing them).
- **Fully scheduled selection** — auto-running the selector on a cron/routine once
  variance handling has earned trust; today it deliberately stays a user decision.
- **Transcript provenance** — link a rule's `born-of` run to its archived transcript
  digest for post-hoc review.

Bigger directions — the reusable asset is the *frozen-benchmark + measured-verdict*
discipline, which generalizes well beyond efficiency rules:

- **Team-shared rule ledgers** *(in progress)* — `/warden-share` exports an agent's
  measured rules to a committed, reviewable artifact (increment 1) and `/warden-adopt`
  imports a shared ledger as local candidates that are **re-measured** on the importer's
  own suite before they count (increment 2 — the foreign delta is never trusted). Still to
  come: a CI gate so a PR adding a rule must reproduce its claimed saving in the pipeline.
  Memory review becomes code review.
- **Skill / MCP cost attribution** — break a session's tokens down per tool and per MCP
  server ("your browser-automation MCP costs 40% of every frontend session"). The one
  remaining direction the A/B comparison engine does not serve — it is decomposition, not
  a keep/reject verdict.
- **Rule marketplaces** — measured rules are portable artifacts with provenance and
  deltas; a community repo of rules-with-receipts that others re-measure locally before
  adopting (the dedupe and verdict machinery already handle imports).

## License

MIT
