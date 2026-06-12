# Changelog

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
