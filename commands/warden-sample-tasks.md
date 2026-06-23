---
description: Draft candidate golden tasks from real session transcripts — pulls each session's opening prompt, de-duplicates, and writes review stubs (success_check left as TODO). Cuts the suite-building burden; never auto-freezes a task. No tokens spent.
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden task sampler (read-only over transcripts; no tokens spent):

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/sample-tasks.ts $ARGUMENTS
```

Argument forms (pass through verbatim as `$ARGUMENTS`):

- `--agent sql --from ~/.claude/projects/<project>` — draft from a directory of
  `.jsonl` session transcripts
- `--agent sql --from path/to/session.jsonl` — draft from a single transcript
- `--out path/` — where to write drafts (default `benchmarks/<agent>/drafts/`)

Each draft is a golden-task file with the prompt filled in and `success_check`
left as `TODO`. It is deliberately **not** added to the frozen suite: a human
writes the deterministic success check and moves it into `benchmarks/<agent>/` to
freeze it (baselines are immutable). Relay the command output to the user.
