---
description: Export an agent's active, measured rules to a committed, reviewable file so a team can version and review agent memory like code.
argument-hint: <frontend|backend|sql|testing> [--out <path>]
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Export the agent's active rule ledger. The agent and flags are: $ARGUMENTS

This reads the agent's currently-active rules (each kept because it measurably
earned ≥ 2× its context rent) and writes them — with their token deltas and
provenance — to a committed, reviewable artifact (default
`.warden/<agent>.rules.md`). It is read-only on the ledger and changes no
running behavior.

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/share.ts --agent <agent> <extra flags as given>
```

Then tell the user the file path and that committing it shares measured memory
with their team (the artifact carries each rule's measured saving, so a PR
adding a rule arrives with its proof). Note that importing and re-verifying a
shared ledger against the team's own golden suite is a later increment — the
file is currently an export for review, not yet auto-applied on import.
