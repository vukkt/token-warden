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
