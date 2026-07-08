# Spec: bring-your-own-agent (BYOA)

## Why
The four domain agents (frontend/backend/sql/testing) are a hardcoded tuple
(`DOMAIN_AGENTS`, src/types.ts) validated in ~76 call sites. An outside user
cannot point token-warden at their own agents or workload — the productization
wall. This PR makes the agent set discoverable while keeping the bundled four
as defaults, with zero behavior change when no custom agents exist.

## Design
1. New module `src/registry.ts`:
   - `export function userAgentsDir(): string` — `process.env.TOKEN_WARDEN_AGENTS_DIR ?? join(homedir(), ".token-warden", "agents")`.
   - `export function userBenchmarksDir(): string` — `process.env.TOKEN_WARDEN_BENCHMARKS_DIR ?? join(homedir(), ".token-warden", "benchmarks")`.
   - `export function knownAgents(): string[]` — DOMAIN_AGENTS plus the basenames of `<userAgentsDir()>/<name>.md` files (name pattern `^[a-z][a-z0-9-]{1,31}$`; ignore others), deduped, bundled order first then custom sorted. Never throws: a missing/unreadable dir contributes nothing.
   - `export function assertKnownAgent(agent: string): void` — throws `--agent must be one of: <list> (got "...")` matching the existing error style.
2. `src/bench.ts`:
   - `loadAgentDefinition(agent)`: bundled `agents/<agent>.md` first, else `<userAgentsDir()>/<agent>.md`, else the existing error.
   - `loadGoldenTasks(agent)`: bundled `benchmarks/<agent>/` first; if the bundled dir is absent, read `<userBenchmarksDir()>/<agent>/` with the same `golden-\d+.md` pattern; error message must mention BOTH paths when neither exists.
3. Replace every `(DOMAIN_AGENTS as readonly string[]).includes(...)` validation with `assertKnownAgent(...)` (or `knownAgents().includes(...)` where a boolean is needed), and every `[...DOMAIN_AGENTS]` "all agents" iteration with `knownAgents()`. Grep for `DOMAIN_AGENTS` and convert ALL call sites outside types.ts; the constant itself stays exported as the bundled default set.
4. `collect.ts` / `notify.ts` / `distill.ts` agent filtering follows automatically via knownAgents(); main-thread ("main") still never distills — that guard is by agent name "main", keep it.

## Constraints
- No DB migration. No CHANGELOG/README/knip/package.json edits (integrator owns those).
- Behavior with no user dirs set and none existing must be byte-identical to today (all existing tests pass unchanged).
- No emojis anywhere. Tabs, biome, repo JSDoc idiom.

## Tests (test/registry.test.ts + minimal edits elsewhere)
- knownAgents(): defaults only when user dir absent; includes valid custom names; rejects bad basenames (uppercase, dots, >32 chars); dedupes an override of a bundled name.
- assertKnownAgent throws with the full discovered list in the message.
- loadAgentDefinition + loadGoldenTasks resolve from a temp user dir via the env overrides (write a real agent .md and a golden-01.md in tmp); bundled agents unaffected.
- One CLI-level test: parseSelectArgs (or select main validation) accepts a custom agent when TOKEN_WARDEN_AGENTS_DIR provides it. NOTE: parseSelectArgs is pure argv parsing — put the agent check wherever it lives after your refactor and test THAT.
- Env cleanup in afterEach (delete the env vars).

## Gate (all by exit code, before you finish)
npm run format && npm run lint && npm run typecheck && npx knip && npx vitest run
