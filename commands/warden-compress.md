---
description: Propose a compressed rewrite of a measured rule — rent is length/4, so a rule rewritten at half the characters pays half the rent. The rewrite is queued as a swap candidate (measured against the active set minus the original) and must survive the benchmark; the original is never auto-removed.
argument-hint: --agent <frontend|backend|sql|testing> --rule <id> [--dry-run]
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden compress command:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/compress.ts $ARGUMENTS
```

Argument forms (pass through verbatim as `$ARGUMENTS`):

- `--agent sql --rule 12` — rewrite rule 12's body at half the character count
  (one headless model call) and queue the rewrite as a candidate
- `--agent sql --rule 12 --dry-run` — show the proposed rewrite without inserting

Only an **active** (measured) rule can be compressed. The rewrite is a new
candidate carrying swap provenance (`replaces = N`); run
`/warden-select <agent>` afterwards and the selector measures it as a **swap**
— the active set with the variant *instead of* the original (measuring it on
top of the semantically identical original would pin its delta at ~0). The
variant must clear 2x its own rent like any rule (invariant #1). The original
is never auto-removed: once the variant is active the original is redundant
and exits through its own re-audits (two-strike). Relay the command output to
the user.
