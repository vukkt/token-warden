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
adding a rule arrives with its proof). A teammate imports it with
`/warden-adopt <file>`, which queues the rules as local candidates — foreign
deltas are evidence, never authority, so they are re-measured on the
importer's own suite before entering memory. With `TOKEN_WARDEN_AUTO_SELECT=1`
the next session start kicks off that measurement automatically.
