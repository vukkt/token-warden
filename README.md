# token-warden

[![CI](https://github.com/vukkt/token-warden/actions/workflows/ci.yml/badge.svg)](https://github.com/vukkt/token-warden/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/vukkt)

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
- [What it saves](#what-it-saves)
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
- [Contributing](#contributing)

---

## How it works

A four-stage, feed-forward loop: lessons are extracted from finished sessions and applied
to future ones. Past work is never re-done, and nothing reaches an agent's memory until it
has been measured.

```mermaid
flowchart TD
    A([Agent session · any project]) -->|"Stop hook parses the transcript"| B[1 · COLLECT<br/>one row per session in SQLite]
    B -->|"only when a run exceeds the agent's p75 cost"| C[2 · DISTILL<br/>one model call → 0–2 candidate rules]
    C -->|"candidates wait — never injected until measured"| D[3 · BENCH<br/>golden suite on a frozen fixture,<br/>with vs. without the rule]
    D -->|"measured delta vs. context rent"| E[4 · SELECT<br/>keep if savings ≥ 2× rent, else evict]
    E --> F[("MEMORY.md — only rules<br/>with proven, positive return")]
    F -.->|"injected into the agent's prompt next session"| A
```

1. **Collect** — `Stop` / `SubagentStop` hooks parse each transcript into one ledger row
   (tokens, tool calls, file re-reads, completion). Hard-capped under 2s, fail-open, exits
   0 regardless — it can never break your session.
2. **Distill** — only runs above the agent's rolling p75 cost (≥ 5 prior runs) are analyzed.
   One detached model call (Sonnet by default) returns ≤ 2 one-sentence rules as strict
   JSON; invalid output is dropped, and near-duplicates of *any* past rule (even evicted
   ones) are rejected — a falsified rule can't sneak back in.
3. **Bench** — candidates run the golden suite on a frozen fixture repo, with vs. without
   the rule, in throwaway copies (see [The benchmark system](#the-benchmark-system)).
4. **Select** — a rule goes active only if it saves **≥ 2× its context rent** and breaks no
   task (failing a previously-passing task is instant eviction). Every run also re-audits
   the oldest active rule. Survivors compile into `MEMORY.md`, which Claude Code injects
   into the agent's prompt next session.

---

## What it saves

token-warden's keep/evict decision is measured in **tokens**; `/warden-cost`
prices that into **dollars** (public Anthropic rates, every rate
[overridable](CONTRIBUTING.md), savings priced at your agent's real token-type
mix). `/warden-cost --project` then scales it over a horizon — default 13 weeks
(~3 months) — and shows the cost **with vs. without** the plugin.

> **These numbers are the [positive control](FINDINGS.md)** — one curated
> "grep before reading" rule on a *deliberately naive* agent, where headroom was
> manufactured to validate the engine. On the already-optimized shipped agents the
> same rule saves ~$0 (correctly evicted). This is *"what the engine captures when
> a rule of this size survives on your workload"* — conditional on that, not a
> guarantee. The open question is whether your real agents have such a rule to
> catch; that's what dogfooding answers.

On that naive agent the rule cut a session from **67,252 → 56,553 processing
tokens (−15.9%)** — about **$0.0321/session** at Sonnet input pricing, ~500× the
rule's context rent.

```mermaid
xychart-beta
    title "Cost per session: without vs. with token-warden (naive agent, Sonnet pricing)"
    x-axis ["without rule", "with rule"]
    y-axis "US cents / session" 0 --> 22
    bar [20.2, 17.0]
```

Scaled per surviving rule (Sonnet pricing, minus the one-time ~$1.98 benchmark
discovery cost):

| Usage profile | Sessions/week | Net savings — 3 months | Net savings — 1 year |
|---|---|---|---|
| Solo dev (moderate) | 20 | **$6** | **$31** |
| Active dev | 50 | $19 | $81 |
| Power user | 250 | $102 | $415 |
| Small team (10×) | 1,000 | $415 | $1,667 |
| Enterprise (100×) | 10,000 | $4,171 | $16,690 |

The per-run win is cents; it becomes money through **volume × rule count × model
price** (Opus is ~1.7× these figures, Fable 5 ~3.3×, Haiku ~0.3×).

```mermaid
xychart-beta
    title "3-month net savings per surviving rule, by usage (Sonnet)"
    x-axis ["solo 20/wk", "active 50/wk", "power 250/wk", "team 1k/wk"]
    y-axis "US dollars" 0 --> 450
    bar [6, 19, 102, 415]
```

The operating cost is the one-time benchmark spend that *found* the rule
(~$1.98 in our run, recovered in ~67 sessions); after that it is pure savings.
For a power user over 3 months that nets out to ~16% off the agent's token bill:

```mermaid
xychart-beta
    title "3-month cost, power user (250 sessions/week): without vs. with plugin"
    x-axis ["without plugin", "with plugin (incl. discovery cost)"]
    y-axis "US dollars" 0 --> 700
    bar [656, 554]
```

Run `/warden-cost --project --sessions-per-week <n>` (or `--months <n>`) to
compute this table from **your own** surviving rules and volume instead of the
illustration above.

## Getting started

> **Quickstart** — if you have Node.js 22+ and Claude Code v2.1+, install it inside Claude
> Code and start working:
>
> ```text
> /plugin marketplace add vukkt/token-warden
> /plugin install token-warden@vukkt-plugins
> ```
>
> That's it — every session, in every project, is now measured automatically (a Stop hook
> that never blocks your work). Run `/warden-status` after a turn or two to see your token
> data. To unlock the part that *saves* tokens, do the one-time setup below: freeze the
> baselines (`npm run bench -- --agent all`), then use the `frontend` / `backend` / `sql` /
> `testing` subagents for real work — expensive sessions distill into candidate rules, and
> the ones that prove they pay for themselves land in agent memory so the next session
> starts cheaper.

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

This runs each agent's golden suite (three runs per task by default) and freezes
`run1_tokens` — the permanent denominator of every future improvement claim. Do this once,
before any rules exist. Suites grow only by *adding* tasks, so this scales with suite size.

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
| `/warden-attribute [--agent a] [--kind builtin\|mcp\|skill] [--transcript path] [--json]` | Attributes real-work token footprint to the tools, skills, and MCP servers that produced it — cross-session by default, or one transcript with `--transcript`. Decomposition only; it never changes a rule verdict |
| `/warden-receipt [--agent a] [--json]` | The per-rule verdict card: token savings vs. context rent (with variance + ROI), per-task pass/fail and the tool-call/file-reread activity profile with vs. without the rule, plus the model and golden-suite hash it was measured under. Read-only evidence behind each keep/evict decision |
| `/warden-cohort [--agent a] [--project p] [--min-n N] [--gate] [--json]` | Production-cohort validation: did rules make REAL work cheaper? Compares the agent's own completed real-work sessions before rules vs. after, with a standard error and a confidence verdict (improved/regressed/no-change) plus a governance action (a regression recommends a fixture re-audit; `--gate` exits non-zero in CI). Out-of-fixture signal; spends no tokens. See [docs/production-cohort-validation.md](docs/production-cohort-validation.md) |
| `/warden-protect --agent a (--add "<rule>" \| --protect <id> \| --unprotect <id> \| --list)` | Mark a rule as **protected** — human-authored / behavioral. Protected rules are compiled into memory and counted for rent but are **never token-evicted** (a behavioral rule's value is not measured in tokens). The boundary that stops the 2× gate from ever deleting a constraint you wrote on purpose |
| `/warden-contradict [--agent a] [--file path] [--gate]` | Zero-token falsification: flags active rules that may contradict the repo's `CLAUDE.md` conventions (shared topic + opposite polarity). Recommends review, **never auto-evicts**; `--gate` exits non-zero in CI |
| `/warden-sample-tasks --agent a --from <dir\|file> [--out path]` | Drafts candidate golden tasks from real session transcripts (opening prompt, de-duplicated, `success_check` left as TODO) to cut suite-building burden. Never auto-freezes a task; a human writes the check and moves it into the suite |
| `/warden-cost [--agent a] [--project] [--months n] [--json]` | Dollar accounting: translates each rule's token savings into money (price table, env-overridable; savings priced at your agent's real token-type mix). `--project` scales it over a horizon (default ~3 months) with a cost **with vs. without** the plugin. Read-only; the gate stays in tokens |
| `/warden-scope --agent a (--rule <id> --scope "<where>" \| --clear \| --list)` | Scope a rule to a context (a language, a service, a task type) — it compiles into memory as `(when <where>) <rule>` so the agent applies it only there. Advisory; doesn't change the measurement |
| `/warden-health [--agent a] [--stale-after <days>] [--gate]` | Flags active rules not re-audited within N days (default 30) so their savings can be re-validated. Recommends a re-audit, **never auto-evicts**; protected rules exempt; `--gate` exits non-zero in CI |

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
npx tsx src/attribute.ts --agent sql                   # attribute token footprint to tools/skills/MCP
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

For the full system overview — the loop, integration surface, data model, and
design invariants — see [ARCHITECTURE.md](ARCHITECTURE.md). The module map:

| Module | Responsibility |
|---|---|
| `src/db.ts` | SQLite schema, versioned migrations (`PRAGMA user_version`), typed query helpers |
| `src/transcript.ts` | Pure transcript JSONL parser — usage dedup, tool calls, re-reads, completion heuristic, distiller digest |
| `src/collect.ts` | Stop-hook entrypoint; p75 trigger; spawns the distiller detached |
| `src/distill.ts` | Waste analysis → 0–2 strict-JSON candidate rules; trigram dedupe |
| `src/bench.ts` | Golden-suite runner; baseline freezing; meta-cost accounting |
| `src/select.ts` | Keep/evict verdicts; round-robin re-audit; `MEMORY.md` compiler |
| `src/status.ts` | Read-only reporting behind `/warden-status` |
| `src/sanitize.ts` | `displayText` — the single presentation-security chokepoint (strips ANSI/control chars) for every untrusted string before it reaches a report, log, or approval prompt |
| `src/gate.ts` | Inter-agent `SendMessage` approval gate (Agent Teams) |
| `src/notify.ts` | SessionStart nudge when candidates await measurement |
| `src/compare.ts` | Generic A/B comparison engine (processing-token verdict, variance top-up, `runComparison` orchestration) shared by model, prompt, and prompt-evolution benchmarking |
| `src/modelbench.ts` | Model-migration benchmarking: candidate model vs. agent default |
| `src/promptbench.ts` | Prompt A/B benchmarking: variant agent definition vs. shipped |
| `src/evolve.ts` | Automated prompt evolution: propose a cheaper prompt (model call) → measure → recommend |
| `src/share.ts` | Export an agent's active rules to a committed, reviewable ledger artifact |
| `src/adopt.ts` | Import a shared ledger as local candidates (foreign delta discarded; re-measured locally) |
| `src/verify-ledger.ts` | Deterministic, offline CI gate that fails a PR corrupting a committed ledger |
| `src/attribute.ts` | Cost attribution: decompose real-work token footprint per tool, skill, and MCP server (decomposition only; orthogonal to the verdict path) |
| `src/receipt.ts` | Rule receipts behind `/warden-receipt`: render the per-rule verdict card (economics + quality axis + provenance) the selector records at each decision |
| `src/cohort.ts` | Production-cohort validation behind `/warden-cohort`: compare real-work cost before vs. after rules (per-session stats + confidence verdict); the out-of-fixture signal |

Data model (`~/.token-warden/warden.db`): `runs` (one row per session or golden run,
tagged `real`/`active`/`candidate`/`audit`), `rules` (the ledger — candidates, active
rules with measured deltas, and evicted rules kept as the negative dataset),
`baselines` (frozen `run1_tokens`, ratcheting `best_tokens`), `ruleset_versions`,
`questions` (the inter-agent ledger), `tool_costs` (per-session tool/skill/MCP
footprint behind `/warden-attribute`), and `rule_receipts` (the per-decision
verdict snapshot behind `/warden-receipt`). Every deviation from the original specification is
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
| baseline (active set) | 39,572 | 70,762 (!) | 50,304 | — |
| + rule #3 | 39,541 | 67,114 | 52,116 | **+622 saved/run** |
| + rule #4 | 39,664 | 54,244 | 49,538 | **+5,731 saved/run** |
| − rule #1 (re-audit) | 39,671 | 49,006 | 44,315 (!) | rule #1 worth **−9,215** |

(!) = the two same-configuration runs differed by >25%.

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

The unit suite — ~360 tests across every module, shown passing by the CI badge above
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

Shipped through v0.19.0 — see [CHANGELOG.md](CHANGELOG.md) for the full
history: the original spec's collect/benchmark/distill/select loop, subagent collection,
variance-aware verdicts, cross-project learning curves, model-migration and prompt A/B
benchmarking, automated prompt evolution, real-time cost-anomaly alerting, team-shared
rule ledgers, tool/skill/MCP cost attribution, per-rule verdict receipts, a staged
CI/CD pipeline (90% coverage), and a thesis-validation harness (`validation/`).

**Validated on real tokens** (see [`validation/`](validation/) and
[`FINDINGS.md`](FINDINGS.md)): the measurement engine, the safety gate (it correctly
evicted a rule that saved 38k tokens by *breaking the task* — a false economy), and the
real-work learning pipeline all work. The open problem is the one the validation burn
located precisely — **benchmark variance + candidate quality**. v0.18.0–v0.19.0 attack
both: the default run count is now **3** (from 2) for a tighter standard error, the
distiller forbids "false economy" rules (ones that trade thoroughness/completion for
tokens), and the suite gained low-variance anchor tasks to tighten the selector's error
bars (the selector's standard error is `sqrt(variance / n_tasks)`).

Near-term (where the next *surviving* rule comes from):

- **Cut benchmark variance further** — real golden-suite runs varied **>25%**, burying
  modest savings under noise. The noisiest tasks (`testing-02` ≈ 150k tokens/run,
  `sql-02`) deserve splitting/quieting (baselines stay frozen; growth means *adding* task
  files, never editing them).
- **Better candidate quality** — beyond the false-economy guard, further distiller
  prompt/model tuning so it proposes rules that can clear 2× rent.
- **Fully scheduled selection** — auto-running the selector on a cron/routine once
  variance handling has earned trust; today it deliberately stays a user decision.
- **Shipped — Transcript provenance.** Each distilled rule stores a digest of the session
  it was born from; `/warden-receipt` shows it as a "born of:" line, so you can see exactly
  the wasteful behavior that motivated each rule (memory review becomes code review).

Bigger directions — the reusable asset is the *frozen-benchmark + measured-verdict*
discipline, which generalizes well beyond efficiency rules:

- **Shipped — Team-shared rule ledgers.** `/warden-share` exports an agent's measured rules to a
  committed, reviewable artifact; `/warden-adopt` imports a shared ledger as local
  candidates that are **re-measured** on the importer's own suite (the foreign delta is
  never trusted); and `npx tsx src/verify-ledger.ts` is a deterministic, offline CI gate
  that fails a PR which corrupts or hand-edits a committed ledger. Memory review becomes
  code review. (A deeper gate that re-benchmarks each rule's delta in CI is possible but
  needs a model-token budget — a deployment choice, not shipped by default.)
- **Shipped — Skill / MCP cost attribution.** `/warden-attribute` breaks real-work tokens down
  per tool, per skill, and per MCP server ("your browser-automation MCP costs 40% of every
  frontend session"), cross-session or for a single transcript. The one direction the A/B
  comparison engine does not serve — it is decomposition, not a keep/reject verdict — so it
  is fully orthogonal to the selector/benchmark path.
- **Rule marketplaces** — measured rules are portable artifacts with provenance and
  deltas; a community repo of rules-with-receipts that others re-measure locally before
  adopting (the dedupe and verdict machinery already handle imports).

### Rule governance and falsification

A surviving rule needs both a savings proof *and* a falsification path. The
savings proof exists today (each decision writes an immutable receipt — savings
vs. rent, ROI, per-task pass/fail, the suite hash, and a dated audit trail). The
falsification path is the next layer of work:

- **Shipped — Protected (human-authored / behavioral) rules.** The 2× token gate is
  the right test for an *efficiency* rule and the wrong one for a *behavioral*
  rule (an edge-case fix, a safety constraint), whose value is not measured in
  tokens. `/warden-protect` marks a rule protected: compiled into memory and
  counted for rent, but **never token-evicted** — only a human removes it. The
  selector never re-audits a protected rule. This is the boundary that keeps the
  token gate from ever deleting a constraint a developer wrote on purpose.
- **Shipped — Contradicted-by-CLAUDE.md falsification.** `/warden-contradict` is a
  zero-token check that flags active rules contradicting the repo's `CLAUDE.md`
  conventions (shared topic + opposite polarity). It **recommends review, never
  auto-evicts** (the controlled fixture stays the only authority that removes a
  rule), with `--gate` for CI.
- **Shipped — Stale-rule flagging.** `/warden-health` flags active rules not re-audited
  within N days (default 30) so their measured savings can be re-validated — the
  measurable form of "un-revalidated for too long". Flags and recommends a re-audit,
  never auto-evicts; protected rules exempt; `--gate` for CI. (A single regression already
  evicts on re-audit, so an "N regressions" threshold would be redundant.)
- **Out-of-fixture re-audit.** Re-audit currently reuses the same frozen fixture,
  so it cannot detect a rule that the fixture happens to reward but that is harmful
  elsewhere. The real-work production signal (token cost per ruleset version) is
  already tracked but only reported; wiring it — and **friction reports** (an agent
  finding a rule false or contradicted in this repo) — into eviction makes the
  benchmark falsifiable by production reality, not just by itself.
- **Shipped — Per-rule scope.** `/warden-scope` gives a rule an "allowed where" predicate
  (a language, a service, a task type); it compiles into memory as `(when <where>) <rule>`
  so the agent applies it only there instead of globally. Advisory — the agent self-applies
  it; it does not change the measurement.
- **Representative suites and richer metrics.** The golden suite is hand-curated,
  not sampled to a production task distribution, so a rule protecting a rare,
  expensive case is only measured if that case is in the suite. `/warden-sample-tasks`
  is a first step — it drafts candidate golden tasks from real session transcripts
  (deduplicated, `success_check` left for a human, never auto-frozen) to cut the
  suite-building burden. **Shipped — latency axis:** golden runs record wall-clock
  `duration_ms` (from the claude result the bench already parses, so it is free),
  and the A/B comparison reports it per task and overall as an *advisory* line —
  never a keep/evict input, so a token-cheaper-but-slower change is visible without
  distorting the verdict. Distribution weighting and **per-category regression**
  reporting are still open.

## Contributing

Setup, the CI/CD pipeline, the release flow, and the design invariants are in
[`CONTRIBUTING.md`](CONTRIBUTING.md). To report a vulnerability, see
[`SECURITY.md`](SECURITY.md).

## License

MIT
