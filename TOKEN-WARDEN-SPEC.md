# token-warden — Build Specification

**Audience:** Claude Code. This document is your complete build plan. Execute it phase by phase. Do not skip ahead: each phase has acceptance criteria, and later phases consume earlier ones. Stop at the end of each phase, run the acceptance checks, and report results before continuing.

**Owner:** Vuk. Fullstack JS/TS developer. All code must be production-grade and ship-ready: strict TypeScript, async/await (never `.then()` chaining), proper error handling, no placeholder stubs left behind. If a decision is ambiguous, pick the simpler option and document it in `DECISIONS.md` rather than asking.

**Before writing any code:** Read the current official docs for the Claude Code features this plugin depends on, because exact schemas change between versions. Verify against https://docs.claude.com/en/docs/claude-code/ :

- Plugin structure and `plugin.json` schema (plugins docs)
- Hooks: `Stop`, `SessionStart`, `PreToolUse` — exact stdin JSON payloads and the response schema for blocking a tool call (hooks docs)
- Subagent frontmatter, especially the `memory` field and `~/.claude/agent-memory/` layout (sub-agents docs)
- Headless invocation: `claude -p` with `--agent <name>` flags (CLI reference)
- Transcript JSONL location (`~/.claude/projects/**/*.jsonl`) and per-message `usage` field structure

If any assumption in this spec contradicts current docs, the docs win. Record the discrepancy in `DECISIONS.md`.

---

## 1. What this is

A Claude Code plugin that makes coding agents measurably cheaper over time. It is a **measurement and selection layer** on top of Claude Code's native subagents and agent memory:

1. **Collect** — record token cost of every agent session from transcript JSONL into SQLite.
2. **Distill** — when a session is unusually expensive, analyze why and generate *candidate* rules.
3. **Benchmark** — measure each candidate's actual token impact on a fixed golden task suite, per agent.
4. **Select** — keep rules that save more than they cost, evict the rest, compile survivors into each agent's persistent memory.

Four domain agents ship with the plugin: `frontend`, `backend`, `sql`, `testing`. Each has its own memory, its own golden suite, its own learning curve.

## 2. Non-negotiable principles

These are design invariants. Do not violate them for convenience.

1. **Candidate rules are never injected until measured.** Unverified rules do not get context space. `status: 'candidate'` rules live only in SQLite.
2. **`MEMORY.md` is a build artifact.** It is compiled from the SQLite rule ledger by the selector — overwritten wholesale, never hand-edited or agent-appended. The DB is the source of truth.
3. **Fitness = tokens per COMPLETED task.** A cheap failed run is worse than an expensive successful one. Every run records `completed` and incomplete runs are excluded from savings math.
4. **Golden tasks run against a fixture repo**, committed inside this repository — never against a live codebase. Baselines must stay comparable across months.
5. **First-run baselines are frozen forever.** `baselines.run1_tokens` is written once per (agent, task) and never updated. It is the denominator of every improvement claim.
6. **The optimizer never re-does past work.** All optimization is feed-forward: lessons are extracted from completed transcripts and applied to future sessions. No retroactive re-solving.
7. **Eviction is mandatory, not optional.** A rule's context cost is paid on every future session. Rules must earn at least 2x their rent (see selector inequality) or be evicted.

## 3. Tech stack

- TypeScript, strict mode, ESM. Node 20+.
- `better-sqlite3` for storage (synchronous API is fine here; these are CLI scripts, not servers).
- `zod` for validating transcript JSON and hook payloads.
- `vitest` for tests.
- No web framework, no ORM, no build step beyond `tsc`/`tsx`. Hooks invoke scripts via `npx tsx`.
- Lint/format: `biome` (single tool, zero config debates).

## 4. Repository layout (target state)

```
token-warden/
├── .claude-plugin/
│   └── plugin.json
├── agents/
│   ├── frontend.md
│   ├── backend.md
│   ├── sql.md
│   └── testing.md
├── hooks/
│   └── hooks.json
├── commands/
│   ├── warden-status.md
│   └── warden-bench.md
├── benchmarks/
│   ├── fixture/                 # small sample full-stack project (see Phase 2)
│   ├── frontend/golden-01.md .. golden-03.md
│   ├── backend/golden-01.md .. golden-03.md
│   ├── sql/golden-01.md .. golden-03.md
│   └── testing/golden-01.md .. golden-03.md
├── src/
│   ├── db.ts                    # schema, migrations, typed query helpers
│   ├── transcript.ts            # JSONL parser (pure, heavily tested)
│   ├── collect.ts               # Stop-hook entrypoint
│   ├── distill.ts               # waste analysis → candidate rules
│   ├── bench.ts                 # golden-suite runner (headless claude -p)
│   ├── select.ts                # keep/evict + MEMORY.md compiler
│   ├── gate.ts                  # PreToolUse approval gate
│   └── types.ts
├── test/
├── DECISIONS.md
├── README.md
├── package.json
├── tsconfig.json
└── biome.json
```

Data lives outside the repo at `~/.token-warden/warden.db` (configurable via `TOKEN_WARDEN_DB` env var) so the plugin works across projects.

---

## Phase 0 — Scaffold

1. `git init`, package.json, tsconfig (strict, ESM, `noUncheckedIndexedAccess: true`), biome, vitest.
2. `.claude-plugin/plugin.json` with name `token-warden`, description, version `0.1.0`, author. Verify required fields against current plugin docs.
3. Empty `hooks/hooks.json` (valid JSON, no hooks yet), `DECISIONS.md`, `README.md` with a one-paragraph description.
4. CI-grade scripts in package.json: `typecheck`, `lint`, `test`, `bench`.

**Acceptance:** `npm run typecheck && npm run lint && npm run test` all pass on the empty scaffold. Plugin loads in Claude Code without errors when added as a local plugin.

---

## Phase 1 — Collector (the data layer)

### 1.1 Schema (`src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,              -- 'frontend'|'backend'|'sql'|'testing'|'main'
  session_id TEXT NOT NULL,
  task_hash TEXT,                   -- golden task id, NULL for real work
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  file_rereads INTEGER NOT NULL DEFAULT 0,   -- same file Read 2+ times
  completed INTEGER NOT NULL DEFAULT 1,
  ruleset_version INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',  -- candidate|active|evicted
  measured_delta INTEGER,            -- avg tokens saved per golden run; negative = harmful
  context_cost INTEGER NOT NULL,     -- estimated tokens this rule occupies (chars/4)
  source_run INTEGER REFERENCES runs(id),
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS baselines (
  agent TEXT NOT NULL,
  task_hash TEXT NOT NULL,
  run1_tokens INTEGER NOT NULL,
  best_tokens INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent, task_hash)
);
```

Write a tiny migration runner (versioned pragma `user_version`); do not pull in a migration library.

### 1.2 Transcript parser (`src/transcript.ts`)

Pure function: `parseTranscript(jsonlText: string): ParsedRun`. Responsibilities:

- Parse line-by-line; tolerate malformed lines (skip + count, never throw on one bad line).
- Validate each entry with zod; extract per-message `usage` (input/output/cache fields), tool-call entries, and file paths from Read/Edit tool calls.
- Compute aggregates: token sums, tool_calls, file_rereads (count files read 2+ times).
- Detect the owning agent if the transcript indicates a subagent context; default `'main'`.
- Detect completion heuristically (presence of a final assistant message not interrupted by error/abort). Document the heuristic in DECISIONS.md.

This module gets the densest test coverage in the repo. Commit 2–3 small anonymized fixture transcripts under `test/fixtures/`.

### 1.3 Stop hook (`src/collect.ts` + `hooks/hooks.json`)

- Register a `Stop` hook invoking `npx tsx ${CLAUDE_PLUGIN_ROOT}/src/collect.ts` (verify the plugin-root variable name in current docs).
- Read hook payload from stdin, locate `transcript_path`, run the parser, insert one `runs` row. Idempotent on `session_id` (upsert).
- Hard requirement: total hook runtime under 2 seconds for a 5MB transcript; the hook must never block or fail the user's session — wrap everything, log errors to `~/.token-warden/collect.log`, exit 0 regardless.

**Acceptance:** unit tests green; install plugin locally, run a real session, confirm a `runs` row appears with sane token numbers; hook failure (e.g., corrupt transcript) does not surface to the user.

---

## Phase 2 — Agents, fixture repo, golden suites, benchmark runner

### 2.1 Agents (`agents/*.md`)

Four subagents with frontmatter (verify exact schema against sub-agents docs):

```markdown
---
name: backend
description: Backend specialist — Node.js, API design, services, queues.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
memory: user
---
You are the backend specialist...
[Domain-scoped system prompt. Include: prefer Grep/Glob over reading whole
files; do not re-read files already read this session; state a one-line plan
before editing. These are the seed efficiency behaviors the optimizer will
extend.]
```

Mirror for `frontend` (React/TS), `sql` (schema design, query optimization, migrations), `testing` (vitest, contract tests, coverage strategy).

### 2.2 Fixture repo (`benchmarks/fixture/`)

A deliberately small but realistic full-stack TS project, committed and FROZEN after this phase:

- Express (or Fastify) API: 3 routes, one service layer, one repository layer.
- React frontend: 2 components, one hook, one context.
- SQLite schema: 3 tables with one deliberate design flaw (missing index) for the sql agent's tasks.
- Vitest setup with partial coverage (gaps are the testing agent's material).
- Seed 2–3 subtle, documented bugs (documented in `benchmarks/fixture/BUGS.md`, which agents never see).
- Total: roughly 25–40 files. Big enough to require navigation, small enough that a golden task costs well under 50k tokens.

### 2.3 Golden tasks (`benchmarks/<agent>/golden-NN.md`)

Three per agent. Each file: YAML frontmatter (`id`, `agent`, `prompt`, `success_check`) where `success_check` is a shell command run against the fixture copy after the agent finishes (e.g., `npx vitest run --reporter=basic` or a grep for an expected change). Examples:

- frontend/golden-01: "Add loading and error states to the UserList component."
- backend/golden-02: "Add input validation to the POST /orders route using zod."
- sql/golden-01: "Find and fix the query performing a full table scan."
- testing/golden-03: "Write contract tests for the orders service."

### 2.4 Benchmark runner (`src/bench.ts`)

CLI: `npx tsx src/bench.ts --agent backend [--rule <id>] [--runs 2]`

Per golden task:
1. Copy fixture to a temp dir (never mutate the committed fixture).
2. If `--rule` given, compile a temporary MEMORY.md = current active rules + the candidate; otherwise active rules only.
3. Invoke headless: `claude -p "<task prompt>" --agent <name>` with cwd = temp dir (verify exact flags, including any flag needed to point at the temp MEMORY.md or agent config, against CLI docs; record approach in DECISIONS.md).
4. Run `success_check`; record `completed`.
5. Parse the resulting transcript with `src/transcript.ts`; insert a `runs` row with `task_hash`.
6. First-ever run per (agent, task): write frozen `baselines.run1_tokens`. Update `best_tokens` when beaten.
7. Default `--runs 2` per configuration; use the mean (LLM variance is real; note in output when the two runs differ by >25%).

**Acceptance:** `npm run bench -- --agent sql` completes all three sql tasks headlessly, rows land in `runs`, baselines are written, and a second invocation does NOT overwrite `run1_tokens`.

---

## Phase 3 — Distiller and Selector (the loop closes here)

### 3.1 Distiller (`src/distill.ts`)

Triggered from the Stop hook after collect, only when the run's total tokens exceed the agent's rolling p75 (minimum 5 prior runs; otherwise skip).

Mechanism: a single headless `claude -p` call (haiku-tier model to keep the meta-cost trivial) given (a) aggregate waste stats from the parser — re-read files, tool-call counts, exploration breadth — and (b) a capped excerpt of the transcript. Prompt it to return STRICT JSON: an array of 0–2 rules, each `{ body: string }`, where body is one imperative sentence under 200 characters, generalizable, and not task-specific. Validate with zod; on invalid JSON, log and produce nothing — never retry in a loop.

Insert as `status='candidate'` with `context_cost = ceil(body.length / 4)`. Dedupe: skip candidates with >0.85 trigram similarity to any existing rule for that agent.

### 3.2 Selector (`src/select.ts`)

CLI: `npx tsx src/select.ts --agent backend`. For each candidate (oldest first, max 3 per invocation to bound cost):

1. Bench the golden suite with and without the candidate via `bench.ts`.
2. `measured_delta` = mean(tokens without) − mean(tokens with), counting only completed runs. Any configuration where the task FAILS that previously passed → immediate eviction regardless of tokens.
3. Verdict:

```typescript
const SESSIONS_PER_WEEK = Number(process.env.WARDEN_SESSIONS_PER_WEEK ?? 20);

function verdict(rule: Rule): 'active' | 'evicted' {
  if (rule.measuredDelta === null || rule.measuredDelta <= 0) return 'evicted';
  const weeklySavings = rule.measuredDelta * SESSIONS_PER_WEEK;
  const weeklyRent = rule.contextCost * SESSIONS_PER_WEEK;
  return weeklySavings >= weeklyRent * 2 ? 'active' : 'evicted';
}
```

4. Re-audit: every selector invocation also re-benches the OLDEST active rule (one per invocation, round-robin). Active rules whose re-measured delta drops below the threshold get evicted. Memory must keep earning its place.
5. Compile: regenerate `~/.claude/agent-memory/<agent>/MEMORY.md` from active rules — header comment "GENERATED BY token-warden — do not hand-edit", one rule per line, ordered by measured_delta desc. Bump `ruleset_version`.

Evicted rules are never deleted — they are the negative dataset.

**Acceptance:** seed one obviously good candidate ("Use Grep to locate symbols before reading any file") and one junk candidate ("Always begin responses with a haiku about the codebase"); run the selector; the good one goes active, the junk one is evicted with a negative or sub-threshold delta; MEMORY.md contains exactly the active set.

---

## Phase 4 — Visibility (`commands/`)

### 4.1 `/warden-status`

Slash command whose markdown instructs the invoking Claude to run `npx tsx src/status.ts` (write this small read-only script) and render:

- Per agent: runs collected, active/candidate/evicted rule counts, current golden-suite total vs frozen run1 baseline (absolute + %).
- The learning curve per agent as a compact table of suite totals over time (text; no charting libs).
- Rule ledger: each active rule with measured_delta and context_cost; last 5 evictions with reasons.

### 4.2 `/warden-bench <agent>`

Runs the suite for one agent (or all), prints the comparison against run1 and best, warns when the meta-cost of benchmarking that session exceeded 10% of the week's collected real-work tokens (the optimizer reporting on its own overhead).

**Acceptance:** both commands work end-to-end in an interactive session against a populated DB.

---

## Phase 5 — Inter-agent approval gate (`src/gate.ts`)

Depends on Agent Teams (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Build it last; degrade gracefully if the feature/tool is absent.

1. `PreToolUse` hook matched to the inter-agent send/message tool (verify the exact tool name in current Agent Teams docs).
2. The hook inspects the payload: sender agent, recipient agent, question text.
3. Return the hook "ask/confirm" response (per current hooks docs) so the user sees: `[frontend → backend] "What does the orders service return on partial failure?" — approve?` and decides. If the hooks API supports only allow/deny, deny with a reason instructing the agent to surface the question to the main thread.
4. Log every question (approved or not) to a `questions` table: `(from_agent, to_agent, body, approved, ts)`. High question volume from an agent is a distiller signal — its memory is missing something. Wire that count into `/warden-status`.

**Acceptance:** with Agent Teams enabled and two agents in a session, a cross-agent question pauses for approval; the decision is logged; with the env flag absent, the plugin loads and all other features work untouched.

---

## Explicitly out of scope (do not build)

- Plan-quota / "tokens remaining" gauges. Anthropic's limits are dynamic; local estimates are fiction. Session-relative metrics only.
- Any retroactive re-solving of past tasks.
- Web dashboards, servers, Electron apps. CLI + slash commands only.
- Cross-agent shared memory synthesis. Per-agent isolation is a feature in v1.
- Automatic rule generation from EVERY session. Only above-p75 sessions feed the distiller.

## Definition of done (v0.1.0)

All five phases' acceptance criteria pass; `npm run typecheck && lint && test` clean; README documents install (local plugin path), the two commands, the loop, and the design invariants; one full real demonstration recorded in README: a candidate rule born from an expensive session, measured on the golden suite, and either promoted or evicted — with the numbers.
