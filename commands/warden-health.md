---
description: Rule health — flag active rules not re-audited in a while (default 30 days) and rank golden tasks by run-to-run variance (noisy tasks bury real savings). Recommends re-audits and task splits; never auto-evicts. --gate exits non-zero for CI.
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden rule-health check (read-only; no tokens spent):

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/health.ts $ARGUMENTS
```

Argument forms (pass through verbatim as `$ARGUMENTS`):

- *(no args)* — every domain agent, 30-day staleness threshold
- `--agent sql` — one agent
- `--stale-after 60` — flag rules not re-decided in 60+ days
- `--gate` — exit non-zero if anything is stale (for CI)
- `--json` — machine-readable output

A rule's measured savings can drift as the codebase and the agent's prompt
change; this flags rules that haven't been re-audited recently so they can be
re-validated with `/warden-select`. It **flags, never auto-evicts** (the
controlled fixture stays the only authority that removes a rule), and **protected
rules are exempt** (they are deliberately never re-measured).

The report also ranks each agent's golden tasks by run-to-run variance
(coefficient of variation over recent active-set runs). A task above the 25%
warning level buries modest savings under its own noise — the fix is
splitting it into quieter tasks by **adding** task files (frozen tasks are
never edited). Informational only; it never affects `--gate`. Relay the report.
