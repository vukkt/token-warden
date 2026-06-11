# Decisions

A log of choices made where the spec was ambiguous, or where current Claude Code docs
differed from the spec's assumptions. Newest entries at the bottom of each phase.

## Phase 0 — Scaffold

- **Docs location.** `https://docs.claude.com/en/docs/claude-code/...` now 301-redirects to
  `https://code.claude.com/docs/en/...`. All doc verification was done against the new host
  (plugins reference, 2026-06-11).
- **`plugin.json` schema.** Per current plugins reference, the manifest is optional and
  `name` is the only required field. We include `name`, `displayName`, `version`,
  `description`, `author` (object form: `{name, email}`), `license`, and `keywords` — all
  documented optional metadata fields. Pinning `version` is deliberate: the docs say an
  unversioned plugin treats every git commit as a new version.
- **Empty hooks file.** `hooks/hooks.json` is `{"hooks": {}}` — the documented top-level
  shape with no event entries. Verified hook event names for later phases: `Stop`,
  `SessionStart`, and `PreToolUse` all exist in the current hooks event table, and the
  documented plugin-root substitution variable is `${CLAUDE_PLUGIN_ROOT}`.
- **Scaffold test.** Vitest fails a run with zero test files, and the spec forbids
  placeholder stubs. Instead of `--passWithNoTests`, Phase 0 ships one real test
  (`test/scaffold.test.ts`) that validates the plugin manifest and hooks config parse and
  contain the required fields — a check we want in CI permanently anyway.
- **`bench` script.** Declared in `package.json` as `tsx src/bench.ts` per spec, but the
  script lands in Phase 2; running it before then exits with a module-not-found error.
  Phase 0 acceptance only requires `typecheck`, `lint`, and `test`.
- **Biome.** Using Biome 2.x with its default ruleset plus the `biome migrate`-current
  schema; config generated via `biome init` and trimmed. No custom rule debates, per spec.

## Phase 1 — Collector

- **Stop hook payload (verified against current hooks docs).** Stdin JSON carries
  `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. Exit 0 with
  no JSON output never blocks the session; `Stop` ignores matchers. The plugin-root
  substitution variable is `${CLAUDE_PLUGIN_ROOT}` as the spec assumed.
- **Hook command resolves tsx from the plugin's own node_modules.** The spec's literal
  `npx tsx ${CLAUDE_PLUGIN_ROOT}/src/collect.ts` runs with cwd = the user's project, where
  `tsx` may not be installed (npx would then fetch it, blowing the 2s budget). The
  registered command is `cd "${CLAUDE_PLUGIN_ROOT}" && npx tsx src/collect.ts` so npx hits
  the plugin's local `node_modules/.bin/tsx` instantly. Hook `timeout: 10` (seconds) as a
  backstop; measured wall time is well under 2s.
- **Usage must be deduplicated by `message.id`.** Verified empirically: Claude Code writes
  one JSONL entry per streamed content block and repeats the identical `usage` object on
  every entry of the same API message (a real transcript had 54 assistant entries but only
  26 distinct message ids). Naive summing roughly doubles token counts. The parser sums
  usage per distinct `message.id` (falling back to `requestId`, then `uuid`). Tool_use
  blocks are deduplicated by block id for the same reason.
- **Subagent transcripts do not carry the agent name.** Verified empirically against
  `~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl`: entries have an opaque
  `agentId` and `isSidechain: true`, but `agentName`/`agentType` are null. The parser
  therefore defaults to `'main'` and exposes `isSidechain`/`agentId`; agent attribution
  comes from the caller — the hook payload's `agent_type` (collect.ts accepts it when it
  names one of the four domain agents) or the bench runner's `--agent` flag in Phase 2.
- **Completion heuristic.** `completed` = the last conversational (user/assistant) entry is
  an assistant message that (a) contains a text block and (b) is not flagged
  `isApiErrorMessage`. Rationale: user-interrupted sessions end with a user entry
  (`[Request interrupted by user]` or a dangling tool_result), API failures flag the tail
  assistant entry, and a trailing tool_use-only assistant message means the turn never got
  its result back.
- **Unique index on `runs.session_id`.** The spec's schema has no uniqueness constraint but
  requires idempotent upsert on `session_id`; a unique index is the conflict target for
  `INSERT ... ON CONFLICT`. Note `Stop` fires after *every* turn of an interactive session
  with the same session_id and a longer transcript — the upsert keeps the row at the
  session's latest cumulative totals rather than creating one row per turn.
- **`file_rereads` counts distinct files Read 2+ times** (a file read 5x contributes 1),
  matching the spec's column comment "same file Read 2+ times".
- **collect.log lives next to the DB** (`dirname(TOKEN_WARDEN_DB)/collect.log`). With the
  default DB path that is exactly the spec's `~/.token-warden/collect.log`, and it keeps
  test runs (which point `TOKEN_WARDEN_DB` at a temp dir) from writing to the real log.
- **Transcripts with zero parseable conversational entries are skipped, not inserted** —
  a fully corrupt transcript logs a skip line rather than recording a row of zeros that
  would pollute p75 waste statistics.

## Phase 2 — Agents, fixture, golden suites, bench runner

- **Subagent frontmatter (verified against current sub-agents docs).** `name` and
  `description` are required; `tools`, `model`, and `memory` are valid optional fields.
  `memory` takes `user` | `project` | `local`; `user` resolves to
  `~/.claude/agent-memory/<name>/` and the first 200 lines / 25KB of `MEMORY.md` there is
  injected into the agent's system prompt. The spec's assumed schema matches current docs.
- **Headless invocation (verified against current CLI reference).** `claude --agent <name>`
  runs the *session* as that agent (not just delegation), combinable with `-p`,
  `--permission-mode`, `--max-turns`, and `--output-format json` (whose result JSON carries
  `session_id`). There is **no flag to point at a custom MEMORY.md** — see next item.
- **Benchmark memory isolation via `memory: project`.** To bench a candidate rule without
  touching real `~/.claude/agent-memory`, bench copies each agent definition into the temp
  workdir's `.claude/agents/<name>.md` with `memory: user` rewritten to `memory: project`,
  which resolves memory to `<workdir>/.claude/agent-memory/<name>/MEMORY.md` — exactly the
  temporary compiled file bench writes. Project agents outrank plugin agents, so the temp
  definition always wins, and bench needs no `--plugin-dir` at all (which also means the
  Stop hook can't double-record bench sessions; and even if the plugin were installed
  globally, bench's upsert runs after the hook and wins on the shared `session_id`).
- **Bench agents run scoped, not with bypassPermissions.** Each temp workdir gets a
  `.claude/settings.json` allowlisting only test-running Bash commands (`npx vitest`,
  `npm test`, `npx tsc`, `ls`); the session runs `--permission-mode acceptEdits` so file
  edits inside the copy are auto-approved and everything else is denied. Initially written
  with `bypassPermissions`; tightened after Claude Code's auto-mode classifier rightly
  flagged spawning unsandboxed bypass agents.
- **`total tokens` = input + output + cache_creation + cache_read.** Baselines and savings
  math need one number; this counts everything the model processed (context volume), which
  is what memory rules actually influence. Recorded per run; `run1_tokens` freezes the first
  *completed* run's total — incomplete runs never write baselines (fitness is tokens per
  COMPLETED task, invariant #3).
- **Baselines are only written by candidate-free configurations.** When `--rule` is given,
  runs are recorded in `runs` but never touch `baselines`, so the frozen run1/best numbers
  always describe the active ruleset alone.
- **Golden-task frontmatter is single-line `key: "value"` pairs** parsed by a small
  hand-rolled parser (no YAML dependency). Prompts are one to two sentences by design.
- **`--task <id>` flag added to bench** (not in spec's CLI sketch) to allow re-running a
  single golden task — used by the freeze-verification part of acceptance and cheap
  spot-checks.
- **BUGS.md and node_modules are excluded from fixture copies**; `node_modules` is
  installed once in the committed fixture directory (gitignored) and symlinked into each
  temp copy, keeping per-run setup under a second.
- **Fixture is excluded from the plugin's own lint/test runs** (`biome` ignore +
  `vitest.config.ts` include/exclude): it has its own suite that runs inside bench copies,
  and its deliberate flaws must not fail plugin CI. Fixture totals 29 files
  (3 routes/3 services/3 repos + React components/hook/context + tests + schema).
