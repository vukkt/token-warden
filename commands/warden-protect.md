---
description: Mark a rule as protected (human-authored / behavioral) so token-warden compiles it into memory but never token-evicts it. Add a new protected rule, protect/unprotect an existing one, or list rules. The boundary that stops the token gate from ever deleting a constraint you wrote on purpose.
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden protect command:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/protect.ts $ARGUMENTS
```

Argument forms (pass through verbatim as `$ARGUMENTS`):

- `--agent sql --add "Never DROP a table without an explicit confirmation step."` —
  add a human-authored, protected rule (compiled into memory immediately, exempt
  from token eviction)
- `--agent sql --protect 12` — protect an existing rule by id (reactivates it if
  it was token-evicted)
- `--agent sql --unprotect 12` — return a rule to the token-gated pool
- `--agent sql --list` — list the agent's rules with their protected/status flags

Why this exists: the 2× token gate is the right test for an *efficiency* rule, and
the wrong test for a *behavioral* one (an edge-case fix, a safety constraint). A
behavioral rule's value is not measured in tokens, so protected rules are never
auto-evicted — only a human removes them. Relay the command output to the user.
