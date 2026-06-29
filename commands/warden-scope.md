---
description: Scope a rule to a context — set an "allowed where" predicate (repo / language / task category) so it compiles into memory as "(when <scope>) <rule>" and the agent applies it only there. Advisory; does not change the measurement.
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden scope command:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/scope.ts $ARGUMENTS
```

Argument forms (pass through verbatim as `$ARGUMENTS`):

- `--agent sql --rule 12 --scope "migration tasks"` — apply rule 12 only in that
  context (compiled as `(when migration tasks) <rule>`)
- `--agent sql --rule 12 --clear` — make the rule global again
- `--agent sql --list` — list the agent's rules with their scope

A rule is global by default. Scope is **advisory**: the agent self-applies it
from the annotated memory line; it does not change the keep/evict measurement.
Use it when a rule is a genuine win in one context (a language, a service, a task
type) but noise elsewhere. Relay the command output to the user.
