---
description: Zero-token falsification — flag active rules that may contradict the repo's CLAUDE.md conventions. Best-effort lexical check (shared topic + opposite polarity); it recommends review and never auto-evicts. --gate exits non-zero for CI.
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden contradiction check (read-only; no tokens spent):

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/contradict.ts $ARGUMENTS
```

Argument forms (pass through verbatim as `$ARGUMENTS`):

- *(no args)* — check every domain agent's active rules against `./CLAUDE.md`
- `--agent sql` — one agent
- `--file path/to/CLAUDE.md` — check a specific conventions file
- `--gate` — exit non-zero if any contradiction is found (for CI)

Relay the report to the user. This is a **best-effort lexical heuristic**: it
catches a rule that shares a topic with a CLAUDE.md directive but states the
opposite, and it **flags for human review — it never removes a rule** (the
controlled `/warden-select` fixture stays the only authority that evicts). A flag
means "look at this", not "this rule is wrong".
