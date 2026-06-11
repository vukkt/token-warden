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
