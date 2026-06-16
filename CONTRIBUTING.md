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
npm run test        # vitest
node scripts/check-versions.mjs   # package.json and plugin.json agree
```

Judge each by its exit code, not by scrolling output — CI does the same.

## CI/CD pipeline

`.github/workflows/ci.yml` is a staged pipeline; each stage gates the next:

```
quality ──▶ test ────┐
        └─▶ fixture ─┴▶ validate ──▶ release (tags only)
```

- **quality** — lint, typecheck, manifest version consistency.
- **test** — the suite on Node 22 and 24.
- **fixture** — the golden-suite fixture sub-package.
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
