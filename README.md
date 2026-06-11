# token-warden

A Claude Code plugin that makes coding agents measurably cheaper over time. It records the
token cost of every agent session into SQLite, distills candidate efficiency rules from
unusually expensive sessions, benchmarks each candidate's real token impact on a frozen
golden task suite, and compiles only the rules that save at least 2× their context cost
into each agent's persistent memory — evicting the rest. Four domain agents ship with the
plugin (`frontend`, `backend`, `sql`, `testing`), each with its own memory, golden suite,
and learning curve.

## The loop

```
           ┌────────────────────────────────────────────────────────┐
           │                                                        │
  Stop hook▼                p75 trigger              golden suite   │
┌────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌──────────┐
│ session │──▶│ COLLECT │──▶│ DISTILL │──▶│  BENCH  │──▶│  SELECT  │
└────────┘    │ runs db │    │ haiku → │    │ measure │    │ keep/    │
              └─────────┘    │ 0–2     │    │ with vs │    │ evict +  │
                             │ rules   │    │ without │    │ compile  │
                             └─────────┘    └─────────┘    │ MEMORY.md│
                                                           └──────────┘
```

1. **Collect** — a `Stop` hook parses the session transcript (token usage deduplicated by
   message id, tool calls, file re-reads, completion) into `~/.token-warden/warden.db`.
   It never blocks or fails your session; errors go to `collect.log`.
2. **Distill** — when a run's total tokens exceed the agent's rolling p75 (min 5 prior
   runs), a detached haiku call analyzes the waste and proposes 0–2 one-sentence candidate
   rules. Candidates live only in SQLite — they never get context space unmeasured.
3. **Benchmark** — `src/bench.ts` runs each agent's three golden tasks against a frozen
   fixture repo in a temp dir, headlessly and with scoped permissions, recording tokens
   per run and freezing first-run baselines forever.
4. **Select** — `src/select.ts` benches the suite with and without each candidate. A rule
   goes active only if it saves ≥ 2× its context rent on completed tasks; everything else
   is evicted (and kept as the negative dataset). Active rules are compiled wholesale into
   `~/.claude/agent-memory/<agent>/MEMORY.md`, which Claude Code injects into that agent's
   system prompt. Every selector run also re-audits the oldest active rule — memory must
   keep earning its place.

## Install (local plugin)

```bash
git clone <this-repo> token-warden
cd token-warden && npm install            # hooks run via the plugin's own tsx
claude --plugin-dir /path/to/token-warden # loads for this session
```

For every session, add the plugin through a marketplace or alias the flag. Requires
Node 20+ and Claude Code v2.1+.

Data lives outside the repo at `~/.token-warden/warden.db` (override with the
`TOKEN_WARDEN_DB` env var). Logs sit next to it: `collect.log`, `distill.log`, `gate.log`.

## Commands

- **`/warden-status`** — read-only report: per-agent run and rule counts, current
  golden-suite total vs the frozen run1 baseline (absolute + %), the learning curve over
  time, active rules with measured deltas, the last evictions with reasons, and
  cross-agent question volume.
- **`/warden-bench <agent|all> [--runs N] [--task id]`** — runs the golden suite,
  compares against `run1` and `best`, and reports the meta-cost: when benchmarking
  exceeds 10% of the week's collected real-work tokens, it warns you to bench less.

(Headless or when names collide, use the namespaced forms `/token-warden:warden-status`
and `/token-warden:warden-bench`.)

CLI equivalents: `npm run bench -- --agent sql`, `npx tsx src/select.ts --agent sql`,
`npx tsx src/status.ts`.

## The agents

`frontend`, `backend`, `sql`, and `testing` are standard subagents (`agents/*.md`) with
`memory: user` and seed efficiency behaviors (Grep before Read, no re-reads, one-line plan
before editing). Use them like any subagent; the optimizer extends their memory over time.
Benchmarks run them with memory scoped to the temp working copy, so your real agent
memory is never touched by measurement runs.

## Inter-agent approval gate (experimental)

With `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, a `PreToolUse` hook gates every
`SendMessage` between agents: you see
`[frontend → backend] "…question…" — approve?` and decide. Every question is logged to
the `questions` table (approved or not) and surfaces in `/warden-status` — an agent that
asks a lot is an agent whose memory is missing something. Without the flag, the gate is
inert and everything else works untouched.

## Design invariants

1. Candidate rules are never injected until measured.
2. `MEMORY.md` is a build artifact — compiled from the SQLite rule ledger, overwritten
   wholesale, never hand-edited.
3. Fitness = tokens per **completed** task; incomplete runs are excluded from savings math.
4. Golden tasks run against a frozen fixture repo committed in this repository, never a
   live codebase.
5. First-run baselines (`run1_tokens`) are written once and never updated.
6. The optimizer never re-does past work; lessons feed forward only.
7. Eviction is mandatory: a rule must save at least 2× its context rent or it is evicted,
   and active rules are re-audited round-robin.

## A real demonstration (recorded 2026-06-12)

Every number below is from real headless runs on this machine — nothing simulated.

**1. A candidate is born from an expensive session.** Run #13, an `sql` golden run on
`sql-03`, cost **61,003 tokens** — above the agent's rolling p75. The distiller (one haiku
call over the run's waste stats and an 8KB action trace) produced two candidates:

| rule | body | context rent |
|---|---|---|
| #3 | "Consolidate file discovery into single queries instead of multiple find/ls operations across related paths." | 27 |
| #4 | "Parse task descriptions for technical direction; verify schema/dependencies only if code doesn't clarify them." | 28 |

**2. The selector measures them** (`npx tsx src/select.ts --agent sql`; 24 headless runs:
one shared baseline, one config per candidate, one re-audit). Mean completed tokens per
task:

| config | sql-01 | sql-02 | sql-03 | delta vs baseline |
|---|---|---|---|---|
| baseline (active set) | 39,572 | 70,762 ⚠ | 50,304 | — |
| + rule #3 | 39,541 | 67,114 | 52,116 | **+622 saved/run** |
| + rule #4 | 39,664 | 54,244 | 49,538 | **+5,731 saved/run** |
| − rule #1 (re-audit) | 39,671 | 49,006 | 44,315 ⚠ | rule #1 worth **−9,215** |

(⚠ = the two same-config runs differed by >25% — sql-02 is consistently the noisy task.)

**3. Verdicts.** The keep threshold is savings ≥ 2× context rent:

- rule #3 → **ACTIVE** (622 ≥ 54)
- rule #4 → **ACTIVE** (5,731 ≥ 56)
- rule #1 ("Use Grep to locate symbols before reading any file."), active since the
  previous selector run at +3,673, was re-audited and **EVICTED** at −9,215: with the two
  new rules present, removing it made the suite *cheaper*. Memory must keep earning its
  place, and this is what that looks like — including the fact that run-to-run variance
  (see the ⚠ flags) is the dominant error source at these effect sizes. Evicted rules are
  never deleted; the trigram dedupe ensures a falsified rule can't be re-proposed.

**4. Compiled memory** (`~/.claude/agent-memory/sql/MEMORY.md`, ruleset v2 — regenerated
wholesale, never hand-edited):

```markdown
<!-- GENERATED BY token-warden — do not hand-edit -->
# Efficiency rules

- Parse task descriptions for technical direction; verify schema/dependencies only if code doesn't clarify them.
- Consolidate file discovery into single queries instead of multiple find/ls operations across related paths.
```

Net effect: starting from frozen run1 baselines of 39,991 / 59,322 / 37,931, the sql
agent's memory now carries two measured rules worth ~6.4k tokens per golden run between
them, and the ledger holds two falsified rules as the negative dataset.

## Development

```bash
npm run typecheck && npm run lint && npm run test   # 86 tests
npm run bench -- --agent sql                        # full sql golden suite
```

Schema migrations are versioned via `PRAGMA user_version` in `src/db.ts`. Design
decisions and every deviation from the original spec are recorded in `DECISIONS.md`.
