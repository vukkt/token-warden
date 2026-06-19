## What and why

A short description of the change and the problem it solves. Link any issue.

## Checklist

- [ ] `npm run format && npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] `npm run knip` clean (no unused files/exports/deps)
- [ ] `npm test` green (and `npm run coverage` does not drop below the floor)
- [ ] `node scripts/check-versions.mjs` passes (manifests agree)
- [ ] CHANGELOG.md updated, and the version bumped in `package.json` +
      `.claude-plugin/plugin.json` if this is a release

## Design invariants

Confirm the change preserves them (see [ARCHITECTURE.md](../ARCHITECTURE.md)):

- [ ] Rules stay measured-not-claimed (no rule enters memory unbenchmarked)
- [ ] Golden baselines remain frozen (suites grow by *adding* tasks, never editing)
- [ ] `MEMORY.md` stays generated (never hand-edited)
- [ ] Hooks still fail open (a session is never blocked)
- [ ] No new untrusted input path bypasses `zod`/sanitization

## Notes

Anything reviewers should know: trade-offs, follow-ups, or measurement impact.
