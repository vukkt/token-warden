---
description: Out-of-fixture confirmation — join each agent's fixture verdicts (rule receipts) with its production cohort verdict to check whether fixture survival predicts real-work savings. Zero tokens, read-only; a contradiction recommends a re-audit, never auto-evicts.
argument-hint: "[--agent <frontend|backend|sql|testing>] [--min-n N] [--json] [--gate]"
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden confirm command:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/confirm.ts $ARGUMENTS
```

Per agent it reports one of four verdicts:

- `CORROBORATED` — the fixture says the active rules earn tokens, and real
  work got confidently cheaper across ruleset versions.
- `CONTRADICTED` — the fixture predicts savings but real work got confidently
  more expensive: re-audit the agent on the fixture (`/warden-select`). The
  cohort signal is observational; it flags, it never auto-evicts.
- `UNCONFIRMED` — the fixture predicts savings but production has not spoken
  yet (within noise, or too few sessions per cohort — see `--min-n`).
- `NOTHING-TO-CONFIRM` — no active rules with a positive measured delta.

`--gate` exits non-zero on any contradiction (CI hook for the out-of-fixture
falsification experiment). Relay the command output to the user.
