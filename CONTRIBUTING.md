# Contributing

Thanks for your interest in token-warden. This is a TypeScript (strict, ESM)
Claude Code plugin; the bar is "measured, not vibes" — claims about cost are
backed by benchmarks, and behavior is backed by tests.

## Setup

```bash
git clone https://github.com/vukkt/token-warden.git
cd token-warden
npm install
```

Requires Node.js 22+.

## Local checks (run before every commit)

```bash
npm run lint        # biome — lint + format (use `npm run format` to auto-fix)
npm run typecheck   # tsc --noEmit
npm run knip        # unused files, exports, and dependencies
npm run test        # vitest (npm run coverage adds the coverage floor)
node scripts/check-versions.mjs   # package.json and plugin.json agree
```

Judge each by its exit code, not by scrolling output — CI does the same.

## CI/CD pipeline

`.github/workflows/ci.yml` is a staged pipeline; each stage gates the next:

```
quality ──▶ test ─────┐
        ├─▶ fixture ──┤
        └─▶ coverage ─┴▶ validate ──▶ release (tags only)
```

- **quality** — lint, typecheck, `knip` dead-code, manifest version consistency.
- **test** — the suite on Node 22 and 24.
- **fixture** — the golden-suite fixture sub-package.
- **coverage** — the suite under the ratcheted coverage floor.
- **validate** — plugin-manifest validation and a CLI smoke run.
- **release** — on a `vX.Y.Z` tag only, publishes the GitHub release with notes
  taken from `CHANGELOG.md`.

A pull request must be green through `validate`.

## Cutting a release

1. Bump the version in **both** `package.json` and `.claude-plugin/plugin.json`.
2. Add a `## vX.Y.Z` section to `CHANGELOG.md`.
3. Commit and push to `main`; wait for the pipeline to go green.
4. Tag and push: `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`.

The `release` job validates the tag against the manifests and publishes the
release automatically — no manual `gh release create` needed.

## Configuration

token-warden needs no configuration for normal use. The full surface is a small
set of environment variables, read at process start; all are optional.

| Variable | Default | Effect |
|---|---|---|
| `TOKEN_WARDEN_DB` | `~/.token-warden/warden.db` | SQLite database path. Set to an isolated file to run benchmarks without touching real data (the validation harness uses this). |
| `TOKEN_WARDEN_MEMORY_DIR` | `~/.claude/agent-memory` | Where compiled `MEMORY.md` files are written, one subdirectory per agent. |
| `TOKEN_WARDEN_AGENTS_DIR` | `~/.token-warden/agents` | Bring-your-own-agent: directory of `<name>.md` agent definitions. Any valid lowercase-slug basename here becomes a known agent alongside the bundled four. Missing/empty is fine — the bundled agents stand. |
| `TOKEN_WARDEN_BENCHMARKS_DIR` | `~/.token-warden/benchmarks` | Golden suites for custom agents: `<name>/golden-*.md`, same format as the bundled `benchmarks/<agent>/`. Consulted only for agents with no bundled suite. |
| `TOKEN_WARDEN_NO_DISTILL` | unset | Set to `1` to suppress spawning the distiller from the Stop hook (collection still runs). |
| `TOKEN_WARDEN_DISTILL_MODEL` | `sonnet` | Model the distiller calls to propose rules. Defaults to `sonnet` because candidate quality is the loop's bottleneck (haiku proposed narrow, low-impact rules — see FINDINGS.md). Override with `haiku` to economize. Also used by `/warden-compress`. |
| `TOKEN_WARDEN_DISTILL_K` | `1` | Best-of-K distillation: sample the distiller K times (1–3) per expensive run and pool the distinct proposals. Each distinct candidate still costs a full benchmark to measure, so keep K small. |
| `TOKEN_WARDEN_NO_ALERTS` | unset | Set to `1` to suppress the real-time cost-anomaly message on an expensive session. |
| `TOKEN_WARDEN_AUTO_SELECT` | unset | Set to `1` to opt in to scheduled selection: the SessionStart hook spawns `/warden-select` in the background for the agent with the most pending candidates, at most once per 24h. Off by default — selection spends real benchmark tokens. |
| `WARDEN_SESSIONS_PER_WEEK` | `20` | Sessions-per-week estimate used to amortize a rule's context rent against its measured savings. |
| `WARDEN_CONFIDENCE_Z` | `2` | Standard-error multiple a candidate must clear the 2×-rent bar by to be promoted (~95% one-sided). `validation/calibration.ts` shows the old `1` gave a ~16% false-positive rate; `2` drops it to ~2.5% at the cost of power. Lower toward 1 to trade precision for power. Clamped to ≥ 1. |
| `TOKEN_WARDEN_PRICE_INPUT` / `_OUTPUT` / `_CACHE_WRITE` / `_CACHE_READ` | public Anthropic rates | Per-1M-token prices used by `/warden-cost` to translate token savings into dollars. Set any subset to apply your own rates; unset cache prices default to 1.25×/0.1× of input. |

## Design invariants (don't break these)

- Hooks fail open (exit 0 on any error).
- Candidate rules are never injected into memory until measured.
- `MEMORY.md` is a generated artifact — never hand-edit it.
- First-run benchmark baselines are frozen forever; grow the golden suite by
  *adding* task files, never editing existing ones.
- Imported rules are re-measured locally; their claimed deltas are never
  trusted.
- Route every untrusted string through `displayText` (`src/sanitize.ts`) before
  rendering, and keep source byte-clean (no literal control bytes — the
  `source-hygiene` test enforces this).

See [`DECISIONS.md`](DECISIONS.md) for the rationale behind deviations from the
original spec.
