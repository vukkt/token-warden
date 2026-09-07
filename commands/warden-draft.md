---
description: Zero-token golden-suite drafting — mine the agent's own recorded sessions for recurring, self-contained tasks and emit runnable golden task files, refusing any task the recorded data already shows is too noisy to measure. Dry-run by default; drafts are unvalidated until benchmarked.
argument-hint: "--agent <name> [--write] [--min-sessions N] [--max-spread F] [--fixture <dir>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden golden-suite drafter (read-only over the ledger and the
user's transcripts; spends no tokens):

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/draft.ts $ARGUMENTS
```

Argument forms (pass through verbatim as `$ARGUMENTS`):

- `--agent <name>` — required; any agent `/warden-status` lists, including a
  bring-your-own agent from `TOKEN_WARDEN_AGENTS_DIR`
- `--write` — actually emit the files. **Without it the command is a dry run**
  and only prints the plan
- `--min-sessions N` — recorded sessions a recurring task needs before its
  spread is trusted (default 3)
- `--max-spread F` — largest tolerated (max-min)/mean of token cost across
  those sessions (default 0.25, the same bar bench.ts warns at)
- `--fixture <dir>` / `--no-fixture` — the pristine tree each derived success
  check is probed against. Defaults to `~/.token-warden/fixtures/<agent>` when
  that exists
- `--projects <dir>` — where session transcripts live (default
  `~/.claude/projects`)
- `--out <dir>` — where drafts are written (default
  `~/.token-warden/benchmarks/<agent>/drafts/`)
- `--json` — machine-readable output

What it does, and what it deliberately does not do:

1. Groups the agent's recorded real-work sessions by near-identical opening
   prompt. A cluster is a task the user does repeatedly; its members are the
   repeated measurements everything below is computed from.
2. Runs the **repeatability pre-check** from the ledger alone: too few
   sessions, any session the agent failed to complete, or a token spread over
   the limit, and the task is REFUSED rather than offered. Surviving tasks are
   numbered steadiest-first.
3. Derives each `success_check` from the verification command those sessions
   themselves ran and passed — never a `TODO`, never invented.
4. Probes that check against the pristine fixture when one is available, and
   refuses it if it already passes there (a check that passes untouched is a
   dead sensor).

Report to the user: the drafted tasks with their repeatability numbers, and
**every refusal with its reason** — "five clusters, four too noisy" is the
useful answer when nothing is drafted. Then state plainly that drafts are
UNVALIDATED: no model has run one, the recorded spread was measured in the
user's own tree rather than in the fixture, and only `/warden-bench` on the
promoted suite — which costs tokens — can say whether the tasks are stable or
even completable under benchmark conditions. Drafts land in `drafts/`, which
`bench.ts` never loads; promoting one is a `mv` up a directory after review.
