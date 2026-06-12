# Changelog

## v0.2.3 — 2026-06-12

Residual-risk hardening (see README "Security notes").

- **Prompt-injection defense in depth**: the distiller rejects rule bodies
  containing control characters or newlines; `renderStatus` sanitizes every
  untrusted string it displays (ANSI/control stripped, newlines collapsed,
  length clamped) so collected data cannot forge report sections; the
  `/warden-status` command instructs the relaying model to treat report
  contents as data, never instructions.
- **Bench suites survive broken runs**: a crashed `claude` invocation,
  vanished transcript, or timeout is recorded as a failed result
  (`RUN-ERROR`) and the suite continues instead of aborting.
- **Explicit POSIX guard**: `bench` and `select` fail fast on Windows with a
  WSL pointer instead of cryptic downstream errors; requirement documented.

## v0.2.2 — 2026-06-12

Hardening fixes from an adversarial test pass.

- **Gate: stored question bodies are capped at 2,000 chars.** A single huge
  `SendMessage` body (tested at 5 MB) was persisted whole into the questions
  ledger; insert and approve now truncate identically so pending-row matching
  still works.
- **Parser: UTF-8 BOM tolerated** — a BOM-prefixed transcript no longer counts
  its first line as malformed.
- Verified under attack and unchanged: corrupt/garbage DB file, read-only data
  dir, directory-as-transcript, future-schema DB (plugin downgrade), 10
  concurrent Stop hooks on one DB, SQL/shell/path-traversal strings in payload
  fields, CRLF+emoji transcripts, 8 MB transcript in 0.25 s, missing `claude`
  binary (distiller fails open), corrupt DB at session start (notifier stays
  silent).

## v0.2.1 — 2026-06-12

Repo hygiene and CI release.

- MIT `LICENSE` file, `CHANGELOG.md`, and full package metadata
  (license/author/repository); GitHub description and topics set.
- GitHub Actions CI: typecheck, lint, and tests on Node 20 and 24, plus the
  fixture's own suite; `actions/checkout@v5` and `actions/setup-node@v5`.
- Lint fix surfaced by CI's clean install: replaced a value-returning
  `forEach` callback in a test with `for…of`.
- README badges (CI, license).

## v0.2.0 — 2026-06-12

- **Variance-aware verdicts**: the selector computes the standard error of per-task
  savings and spends a bounded top-up measurement pass (`--top-up`, default 1) when a
  verdict is within one SE of the keep/evict threshold; verdicts still within noise are
  recorded with a low-confidence annotation.
- **`/warden-select` command** and a `SessionStart` nudge that surfaces pending
  candidates without auto-spending benchmark tokens.
- **Question-driven distillation**: an agent's recent cross-agent questions are fed to
  the distiller as a memory-gap signal.
- **Per-project tracking** (`runs.project`, migration 6) with a per-project token
  breakdown in `/warden-status`.
- **Rule provenance**: active rules show the run they were distilled from.
- Self-hosted marketplace (`/plugin marketplace add vukkt/token-warden`) and a
  dependency-bootstrapping Stop hook for cache installs.

## v0.1.0 — 2026-06-12

Initial release. All five build phases of the original specification:

- **Collector**: Stop-hook transcript ingestion into SQLite (usage deduplicated by
  message id; never blocks a session).
- **Agents + benchmark system**: four domain subagents (`frontend`, `backend`, `sql`,
  `testing`), a frozen full-stack fixture repo, three golden tasks per agent, and a
  headless benchmark runner with permanently frozen first-run baselines.
- **Distiller + selector**: p75-triggered candidate generation (haiku, strict JSON,
  trigram dedupe) and measured keep/evict decisions (savings ≥ 2× context rent) with
  round-robin re-audit and wholesale `MEMORY.md` compilation.
- **Visibility**: `/warden-status` and `/warden-bench` with meta-cost reporting.
- **Inter-agent approval gate** on `SendMessage` (Agent Teams, experimental) with a
  logged question ledger.
