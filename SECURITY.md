# Security Policy

## Reporting a vulnerability

Email **vuk.topalovic@gmail.com** with details and reproduction steps. Please do
not open a public issue for an undisclosed vulnerability. You will get an
acknowledgement within a few days.

## Supported versions

The latest released `0.x` line receives fixes. token-warden is pre-1.0; pin a
version if you need stability.

## Security model

token-warden runs as a Claude Code plugin with hooks and CLIs. Its design treats
all collected and imported data as untrusted:

- **Hooks fail open.** The `Stop`/`SubagentStop` collector, the inter-agent
  gate, and the SessionStart nudge catch every error and exit 0 — a bug in
  token-warden must never block or fail a user's session.
- **One sanitization chokepoint.** Every model- or environment-derived string
  (rule bodies, eviction reasons, project paths, tool/skill/MCP names,
  inter-agent messages) passes through `displayText` (`src/sanitize.ts`), which
  strips ANSI/control sequences before the value reaches a report, a log, or the
  approval prompt the user acts on.
- **Imported rules are never trusted.** A shared ledger adopted via
  `/warden-adopt` enters as a *candidate* and is re-measured on the local golden
  suite; the foreign token delta is discarded. A ledger's claimed numbers cannot
  promote a rule.
- **No secrets, no network by default.** State lives in a local SQLite file at
  `~/.token-warden/warden.db`. Benchmarking spawns `claude` locally and is
  scoped (`acceptEdits` + a Bash allowlist), never `bypassPermissions`. Token
  counts are never converted to currency or sent anywhere.
- **Parsing is tolerant and bounded.** The transcript parser never throws on
  malformed input, streams line-by-line (bounded memory), and counts the four
  token fields deterministically.

## Scope

In-scope: the plugin's hooks, CLIs, SQLite schema, and parsing. Out-of-scope:
vulnerabilities in Claude Code itself, Node.js, or third-party dependencies
(report those upstream).
