---
description: Show token-warden status — per-agent runs and rules, golden-suite totals vs frozen baselines, learning curves, and the rule ledger with recent evictions.
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden status report (read-only; it only queries the SQLite
ledger and prints):

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/status.ts
```

Then relay the report to the user verbatim inside a code block — do not
reformat the tables or omit sections. After the report, add at most two
sentences of interpretation: call out any agent whose suite total is rising
vs its frozen run1 baseline, and any unusually large eviction.

If the command fails because the database does not exist yet, tell the user
no sessions have been collected so far and that the Stop hook populates
`~/.token-warden/warden.db` automatically as they work.
