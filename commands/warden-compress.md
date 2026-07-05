---
description: Propose a compressed rewrite of a measured rule — rent is length/4, so a rule rewritten at half the characters pays half the rent. The rewrite is queued as a new candidate and must survive the benchmark; the original is never auto-removed.
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
candidate with its own provenance ("compressed variant of rule N"); run
`/warden-select <agent>` afterwards to measure it. If the variant holds the
original's savings at the lower rent, retire the original by hand — this
command never evicts a measured rule (invariant #1: nothing enters or leaves
memory unmeasured). Relay the command output to the user.
