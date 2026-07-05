---
description: Adopt rules from a shared token-warden ledger file as local candidates, to be re-measured on your own golden suite before they enter memory.
argument-hint: --from <path-to-.rules.md>
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Adopt a shared rule ledger. The flag is: $ARGUMENTS

This reads a ledger file produced by `/warden-share` and queues its rules as
**candidates** locally. It never trusts the foreign measured delta — the
claimed saving is discarded and the rule must be re-measured on this machine's
golden suite before it is injected into memory. Near-duplicates of any
existing rule (including evicted ones) are skipped.

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/adopt.ts --from <path>
```

Then tell the user how many rules were adopted as candidates vs skipped, and —
this is the important part — that adopted rules are **unverified here** and
must be measured with the selector (`/warden-select <agent>`) before any of
them earns a place in the agent's memory. A shared rule is a hypothesis, not a
fact, until it reproduces its saving on the team member's own suite. With
`TOKEN_WARDEN_AUTO_SELECT=1` set, the next session start queues that
measurement automatically (once per 24h).
