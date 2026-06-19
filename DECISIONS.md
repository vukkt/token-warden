# Decisions

A log of choices made where the spec was ambiguous, or where current Claude Code docs
differed from the spec's assumptions. Newest entries at the bottom of each phase.

## Phase 0 — Scaffold

- **Docs location.** `https://docs.claude.com/en/docs/claude-code/...` now 301-redirects to
  `https://code.claude.com/docs/en/...`. All doc verification was done against the new host
  (plugins reference, 2026-06-11).
- **`plugin.json` schema.** Per current plugins reference, the manifest is optional and
  `name` is the only required field. We include `name`, `displayName`, `version`,
  `description`, `author` (object form: `{name, email}`), `license`, and `keywords` — all
  documented optional metadata fields. Pinning `version` is deliberate: the docs say an
  unversioned plugin treats every git commit as a new version.
- **Empty hooks file.** `hooks/hooks.json` is `{"hooks": {}}` — the documented top-level
  shape with no event entries. Verified hook event names for later phases: `Stop`,
  `SessionStart`, and `PreToolUse` all exist in the current hooks event table, and the
  documented plugin-root substitution variable is `${CLAUDE_PLUGIN_ROOT}`.
- **Scaffold test.** Vitest fails a run with zero test files, and the spec forbids
  placeholder stubs. Instead of `--passWithNoTests`, Phase 0 ships one real test
  (`test/scaffold.test.ts`) that validates the plugin manifest and hooks config parse and
  contain the required fields — a check we want in CI permanently anyway.
- **`bench` script.** Declared in `package.json` as `tsx src/bench.ts` per spec, but the
  script lands in Phase 2; running it before then exits with a module-not-found error.
  Phase 0 acceptance only requires `typecheck`, `lint`, and `test`.
- **Biome.** Using Biome 2.x with its default ruleset plus the `biome migrate`-current
  schema; config generated via `biome init` and trimmed. No custom rule debates, per spec.

## Phase 1 — Collector

- **Stop hook payload (verified against current hooks docs).** Stdin JSON carries
  `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. Exit 0 with
  no JSON output never blocks the session; `Stop` ignores matchers. The plugin-root
  substitution variable is `${CLAUDE_PLUGIN_ROOT}` as the spec assumed.
- **Hook command resolves tsx from the plugin's own node_modules.** The spec's literal
  `npx tsx ${CLAUDE_PLUGIN_ROOT}/src/collect.ts` runs with cwd = the user's project, where
  `tsx` may not be installed (npx would then fetch it, blowing the 2s budget). The
  registered command is `cd "${CLAUDE_PLUGIN_ROOT}" && npx tsx src/collect.ts` so npx hits
  the plugin's local `node_modules/.bin/tsx` instantly. Hook `timeout: 10` (seconds) as a
  backstop; measured wall time is well under 2s.
- **Usage must be deduplicated by `message.id`.** Verified empirically: Claude Code writes
  one JSONL entry per streamed content block and repeats the identical `usage` object on
  every entry of the same API message (a real transcript had 54 assistant entries but only
  26 distinct message ids). Naive summing roughly doubles token counts. The parser sums
  usage per distinct `message.id` (falling back to `requestId`, then `uuid`). Tool_use
  blocks are deduplicated by block id for the same reason.
- **Subagent transcripts do not carry the agent name.** Verified empirically against
  `~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl`: entries have an opaque
  `agentId` and `isSidechain: true`, but `agentName`/`agentType` are null. The parser
  therefore defaults to `'main'` and exposes `isSidechain`/`agentId`; agent attribution
  comes from the caller — the hook payload's `agent_type` (collect.ts accepts it when it
  names one of the four domain agents) or the bench runner's `--agent` flag in Phase 2.
- **Completion heuristic.** `completed` = the last conversational (user/assistant) entry is
  an assistant message that (a) contains a text block and (b) is not flagged
  `isApiErrorMessage`. Rationale: user-interrupted sessions end with a user entry
  (`[Request interrupted by user]` or a dangling tool_result), API failures flag the tail
  assistant entry, and a trailing tool_use-only assistant message means the turn never got
  its result back.
- **Unique index on `runs.session_id`.** The spec's schema has no uniqueness constraint but
  requires idempotent upsert on `session_id`; a unique index is the conflict target for
  `INSERT ... ON CONFLICT`. Note `Stop` fires after *every* turn of an interactive session
  with the same session_id and a longer transcript — the upsert keeps the row at the
  session's latest cumulative totals rather than creating one row per turn.
- **`file_rereads` counts distinct files Read 2+ times** (a file read 5x contributes 1),
  matching the spec's column comment "same file Read 2+ times".
- **collect.log lives next to the DB** (`dirname(TOKEN_WARDEN_DB)/collect.log`). With the
  default DB path that is exactly the spec's `~/.token-warden/collect.log`, and it keeps
  test runs (which point `TOKEN_WARDEN_DB` at a temp dir) from writing to the real log.
- **Transcripts with zero parseable conversational entries are skipped, not inserted** —
  a fully corrupt transcript logs a skip line rather than recording a row of zeros that
  would pollute p75 waste statistics.

## Phase 2 — Agents, fixture, golden suites, bench runner

- **Subagent frontmatter (verified against current sub-agents docs).** `name` and
  `description` are required; `tools`, `model`, and `memory` are valid optional fields.
  `memory` takes `user` | `project` | `local`; `user` resolves to
  `~/.claude/agent-memory/<name>/` and the first 200 lines / 25KB of `MEMORY.md` there is
  injected into the agent's system prompt. The spec's assumed schema matches current docs.
- **Headless invocation (verified against current CLI reference).** `claude --agent <name>`
  runs the *session* as that agent (not just delegation), combinable with `-p`,
  `--permission-mode`, `--max-turns`, and `--output-format json` (whose result JSON carries
  `session_id`). There is **no flag to point at a custom MEMORY.md** — see next item.
- **Benchmark memory isolation via `memory: project`.** To bench a candidate rule without
  touching real `~/.claude/agent-memory`, bench copies each agent definition into the temp
  workdir's `.claude/agents/<name>.md` with `memory: user` rewritten to `memory: project`,
  which resolves memory to `<workdir>/.claude/agent-memory/<name>/MEMORY.md` — exactly the
  temporary compiled file bench writes. Project agents outrank plugin agents, so the temp
  definition always wins, and bench needs no `--plugin-dir` at all (which also means the
  Stop hook can't double-record bench sessions; and even if the plugin were installed
  globally, bench's upsert runs after the hook and wins on the shared `session_id`).
- **Bench agents run scoped, not with bypassPermissions.** Each temp workdir gets a
  `.claude/settings.json` allowlisting only test-running Bash commands (`npx vitest`,
  `npm test`, `npx tsc`, `ls`); the session runs `--permission-mode acceptEdits` so file
  edits inside the copy are auto-approved and everything else is denied. Initially written
  with `bypassPermissions`; tightened after Claude Code's auto-mode classifier rightly
  flagged spawning unsandboxed bypass agents.
- **`total tokens` = input + output + cache_creation + cache_read.** Baselines and savings
  math need one number; this counts everything the model processed (context volume), which
  is what memory rules actually influence. Recorded per run; `run1_tokens` freezes the first
  *completed* run's total — incomplete runs never write baselines (fitness is tokens per
  COMPLETED task, invariant #3).
- **Baselines are only written by candidate-free configurations.** When `--rule` is given,
  runs are recorded in `runs` but never touch `baselines`, so the frozen run1/best numbers
  always describe the active ruleset alone.
- **Golden-task frontmatter is single-line `key: "value"` pairs** parsed by a small
  hand-rolled parser (no YAML dependency). Prompts are one to two sentences by design.
- **`--task <id>` flag added to bench** (not in spec's CLI sketch) to allow re-running a
  single golden task — used by the freeze-verification part of acceptance and cheap
  spot-checks.
- **BUGS.md and node_modules are excluded from fixture copies**; `node_modules` is
  installed once in the committed fixture directory (gitignored) and symlinked into each
  temp copy, keeping per-run setup under a second.
- **Fixture is excluded from the plugin's own lint/test runs** (`biome` ignore +
  `vitest.config.ts` include/exclude): it has its own suite that runs inside bench copies,
  and its deliberate flaws must not fail plugin CI. Fixture totals 29 files
  (3 routes/3 services/3 repos + React components/hook/context + tests + schema).

## Phase 3 — Distiller and Selector

- **Distillation runs detached, not inside the hook.** The Stop hook must finish in <2s
  but distillation makes a model call (10–30s). `collect.ts` does the cheap p75 trigger
  check in-process (SQL over the last 50 runs) and, when it fires, spawns
  `tsx src/distill.ts --run <id> --transcript <path>` detached with stdio ignored, then
  exits. `TOKEN_WARDEN_NO_DISTILL=1` disables the spawn (used by tests).
- **Rolling p75** = nearest-rank 75th percentile over the agent's most recent 50 runs
  (excluding the current one), requiring ≥5 priors per spec. The distiller re-checks the
  trigger itself so a stale spawn can't distill a cheap run.
- **Distiller transcript excerpt** is a compact action trace (`digestTranscript`): user and
  assistant text truncated to 200 chars, tool calls as `TOOL <name> <input>` lines, capped
  at 8KB keeping head (the task) and tail (where the session bogged down). Raw JSONL would
  waste the haiku call's context on framing.
- **Trigram similarity** = Jaccard over character trigrams of the lowercased,
  punctuation-stripped body. Dedupe compares against ALL existing rules for the agent
  (including evicted ones) so the distiller cannot resurrect an already-falsified rule.
- **`ruleset_versions` table added (migration 2).** The spec's `runs.ruleset_version`
  column needs a counter to reference; per-agent versions bump on every selector compile.
  `collect.ts` and `bench.ts` stamp rows with the agent's current version.
- **Selector cost bounding:** the active-set baseline suite is run ONCE per invocation and
  shared by all candidates (max 3, oldest first); each candidate adds one suite run, and
  the re-audit adds one more (active set minus the audited rule). Worst case per
  invocation: 5 suite configurations.
- **`measured_delta` is paired per task** — mean over tasks completed in both
  configurations of (mean without − mean with) — rather than a pooled mean over all runs,
  so a task mix change can't masquerade as savings. A task that completed in the baseline
  but has zero completed candidate runs → immediate eviction regardless of tokens (spec
  §3.2.2); tasks failing in *both* configs are excluded from the math.
- **Re-audit target is chosen before any candidate is decided**, ordered by `decided_at`
  ascending (round-robin: each audit refreshes `decided_at`). A rule activated in the
  current invocation is therefore never instantly re-audited.
- **Re-audit delta direction:** the rule's worth = mean(suite WITHOUT it) − mean(baseline
  WITH it). The baseline summaries are reused as the "with" side — no extra suite run.
- **`TOKEN_WARDEN_MEMORY_DIR` env override** for the compiled-memory root (default
  `~/.claude/agent-memory`) so unit tests never write real agent memory.
- **`ruleset_version` bumps only when the selector made at least one decision**; a no-op
  invocation (no candidates, nothing to audit) does not recompile MEMORY.md or bump.

## Phase 4 — Visibility

- **Command bodies use `${CLAUDE_SKILL_DIR}/..`, not `${CLAUDE_PLUGIN_ROOT}`.** Per current
  skills docs, the substitution available inside command/skill markdown is
  `${CLAUDE_SKILL_DIR}` (the directory containing the command file — `commands/` for us);
  `${CLAUDE_PLUGIN_ROOT}` is only substituted in hooks/MCP/monitor configs. Headless
  invocation uses the namespaced form `/token-warden:warden-status`; interactive sessions
  surface the short `/warden-status` when unambiguous.
- **`rules.decided_reason` added (migration 3).** The spec's status output requires
  evictions "with reasons", which post-hoc delta inspection cannot reconstruct (regression
  vs sub-threshold are indistinguishable). The selector now stores a human-readable reason
  with every verdict.
- **`runs.config` added (migration 4): 'real' | 'active' | 'candidate' | 'audit'.** The
  first live status report showed the suite "current" total inflated +25% because the
  latest completed golden runs happened to be candidate-configuration runs (including the
  deliberately wasteful haiku rule). Status comparisons and learning curves now count only
  `config='active'` runs; existing rows were backfilled from the selector's logged session
  ids. This extends the spec's fixed `runs` schema — additive, default `'active'`.
- **"Current suite total"** = per baselined task, the latest completed active-config golden
  run's total, summed; compared against the frozen `run1_tokens` sum and the ratcheted
  `best_tokens` sum.
- **Learning curve granularity is per day** (avg completed active-config golden-run tokens,
  with run counts), labeled with the agent's current ruleset version. Text only, no
  charting, per spec.
- **Meta-cost accounting lives in `bench.ts`**, not the command markdown: after every CLI
  invocation it prints tokens spent benchmarking vs real-work tokens collected in the last
  7 days (`task_hash IS NULL`), warning above the 10% threshold; with zero collected
  real-work tokens any benchmarking warns. `--agent all` loops the four domain agents and
  reports one combined meta-cost.
- **`MIGRATION_COUNT` exported** so the schema-version test tracks new migrations without
  hand-editing.

## Phase 5 — Inter-agent approval gate

- **Verified against current Agent Teams + hooks docs:** the flag is
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (env or settings.json `env`); the inter-agent
  message tool is **`SendMessage`** (always available to teammates even under `tools`
  restrictions); and PreToolUse supports a genuine **`"ask"`** decision
  (`hookSpecificOutput.permissionDecision: "ask"` + `permissionDecisionReason` shown to the
  user) — the spec's deny-fallback was not needed.
- **Approval state is observed, not asked.** An `ask` hook cannot learn the user's
  decision. The gate logs the question with `approved = NULL` at PreToolUse; a PostToolUse
  hook on the same matcher (`gate.ts --post`) marks the newest matching pending row
  `approved = 1`, since PostToolUse only fires when the send actually executed. Rows that
  stay NULL were denied or aborted.
- **The SendMessage input schema is experimental**, so the gate extracts the recipient
  from the first present of `recipient|to|agent|agent_name|name` and the body from
  `message|content|body|text|prompt`. Sender comes from the hook payload's
  `agent_type`/`agent_id` (subagent-defined teammates) and defaults to `"lead"` — the
  lead's outbound messages are gated too.
- **The gate fails OPEN**: any internal error logs to `gate.log` (next to the DB) and
  exits 0 with no output, deferring to the normal permission flow. A broken gate must
  never block team messaging; the gate is an observability/approval layer, not a security
  boundary.
- **Graceful degradation is structural**: without the env flag the SendMessage tool never
  exists, so the matcher never fires — verified by running a plugin-loaded session with
  the flag unset (works, zero question rows).
- **`questions` table added (migration 5)** per spec, with per-sender asked/approved
  counts wired into `/warden-status` (high outbound volume = that agent's memory is
  missing something — a future distiller signal).

## v0.4.0 — full-repo audit (two parallel review agents + live verification)

- **SubagentStop registered — the audit's biggest catch.** Only `Stop` was wired, which
  fires for the main session; domain-agent real work was never collected, so real-work
  learning curves and real-work distillation could structurally never happen. Verified
  live: the SubagentStop payload carries the PARENT transcript path; the subagent's own
  transcript is derived as `<parent minus .jsonl>/subagents/agent-<agent_id>.jsonl` and
  recorded under a `session_id#agent_id` key (idempotent per subagent, never colliding
  with the parent row). If no sidechain transcript exists, the event is skipped — never
  double-counted. Subagent events trust the harness's `agent_type` verbatim (it names the
  agent definition); plain Stop keeps the domain-allowlist fallback.
- **Distillation is now gated to domain agents** (others' rules could never be measured —
  candidates would queue forever and the SessionStart nudge would point at a command that
  errors; notify filters likewise), **p75 priors count real-work runs only**
  (`task_hash IS NULL` — golden runs have a different cost profile), and **a run is
  distilled at most once** (`alreadyDistilled`: any rule with `source_run = run.id` is the
  persistent marker; Stop fires every turn and would otherwise spawn a haiku call per turn
  of a long expensive session).
- **Bench hardening:** the headless claude spawn sets `TOKEN_WARDEN_NO_DISTILL=1` (a
  globally installed plugin's own Stop hook would otherwise distill golden runs);
  `--agent all --task` is rejected up front instead of failing after spending tokens;
  the >25% variance warning now works for any n≥2 runs (was: exactly 2).
- **Correctness sweep:** `WARDEN_SESSIONS_PER_WEEK` is validated (0/negative/NaN would
  invert or trivialize the keep inequality); `realWorkCurveByProject` COALESCEs NULL
  projects (SQL `IN` drops NULLs silently); status CLI errors print a message instead of
  a raw stack; dead exports removed (`computeDelta`, `AgentName`, `RuleStatus`).
- **Infra:** vitest 4 (clears 5 high npm-audit findings), Biome pinned exactly,
  engines `>=22` + CI matrix [22, 24] (Node 20 is EOL), CI concurrency group +
  job timeouts, Dependabot (npm + actions; fixture deliberately excluded — frozen).
- **Declined (judgment):** shared CLI flag-parser refactor (three small hand-rolled
  loops are tested and readable; consolidation risk > duplication cost); lone-`\r` line
  endings in `iterateLines` (doc claim softened instead — Claude Code never writes them);
  merging gate's `truncateBody` with transcript's `truncate` (cross-module util for two
  one-liners isn't worth the coupling).

## v0.5.0 — model-migration benchmarking (roadmap #1)

Built with an independent design-critique agent before implementation; its findings are
baked in below.

- **Reuses the existing machinery, adds almost no new concepts.** A new `model?` field on
  `SuiteOptions` threads a model override through `runSuite` → `runOnce` (defaulting to the
  agent's frontmatter model). `src/modelbench.ts` mirrors `select.ts`: a pure, DB-free
  `compareRuns(...)` core plus a thin CLI that wires the real `runSuite`. The verdict reuses
  `assessDelta(baseline, candidate, 0)` — at contextCost 0 its `uncertain` flag becomes
  exactly "|Δ| < standard error", i.e. indistinguishable from zero, which is precisely the
  model-comparison question.
- **Verdict metric is PROCESSING tokens (input + output + cache_creation), not the raw
  four-component total.** The critique's key catch: across two *different* models the
  `cache_read` component (billed ~10%, dominant in these runs, and partly a
  turn-count/scheduling artifact) distorts a 1:1 token sum. Comparing on processing tokens
  removes that distortion; cache-read is reported per task so nothing is hidden. Token
  counts are never converted to dollars (spec forbids that fiction; models are priced
  differently per token, so the report states the caveat explicitly).
- **Isolation:** modelbench rows carry `task_hash` (excluded from real-work queries) AND
  `config='modelbench'` (excluded from the `config='active'` baseline/curve queries) and
  pass `recordBaselines: false`. The one query filtering on neither — `status.runCounts`,
  which counts `task_hash IS NOT NULL` as "golden" — was patched to exclude `modelbench`
  so the comparison doesn't inflate an agent's golden-run count.
- **Variance discipline preserved:** like the selector, modelbench tops up (re-runs *both*
  models and pools via the same `mergeSummaries`/`assessDelta` path) when the verdict lands
  within noise; `--top-up` defaults to 1. A single-task comparison (`--task`, n<2 tasks)
  can't compute a standard error, so the verdict is labelled "indicative only" rather than
  implying confidence.
- **`runs.model` column added (migration 7), nullable.** Justification (the critique asked
  whether it earns its place): nothing *queries* it today, but it makes every benchmark row
  self-describing about which model produced it — forensic provenance for "which model was
  this comparison?", and a guard rail since baselines are implicitly model-specific. Bench
  populates it for all golden runs going forward; real-work collection leaves it NULL.
- **Naming:** `RunConfig` value is `"modelbench"` (compound, unlike the other single-word
  values) chosen for clarity over consistency — it unambiguously says what the rows are.

## v0.6.0 — prompt/agent-definition A/B testing (roadmap #2)

Implementing #1 (model-bench) de-risked #2 to a thin consumer of the same engine, exactly
as the post-#1 reflection predicted.

- **Extracted the generic A/B core into `src/compare.ts`** rather than copy it. `compareRuns`
  was already configuration-agnostic; it became `compareConfigs(subject, dimension,
  baselineLabel, candidateLabel, …)` with the report/verdict parameterized by a `dimension`
  word ("model"/"prompt"). `modelbench.ts` is now a thin runner over `compare.ts`; its
  core-logic tests moved to `compare.test.ts`. Behaviour preserved (tests green across the
  refactor), no duplication — the "tight, no copy-paste" bar the project holds.
- **The prompt is varied via a `definitionOverride` on `SuiteOptions`**, the symmetric seam
  to the model override added in v0.5.0. `runSuite` uses
  `options.definitionOverride ?? loadAgentDefinition(agent)`. `loadAgentDefinition` was split
  into `parseAgentDefinition(raw, source)` (exported, reused for variant files) + a thin
  file loader; the same `memory: user → project` rewrite applies to variants so they never
  touch real agent memory.
- **Model held constant in prompt-bench.** Both passes run under the agent's current model
  (`model: baseModel`) even if the variant file's frontmatter names a different one — the
  prompt must be the only variable. The candidate's variant `model:` is therefore ignored
  by design.
- **`config='promptbench'` added; the golden-run count switched from a blacklist to a
  whitelist.** `status.runCounts` now counts `config IN ('active','candidate','audit')` as
  golden instead of `config != 'modelbench'`, so every current and future A/B comparison
  config is excluded from an agent's golden history automatically (more robust than chasing
  each new config with a `!=`).
- **Same processing-token metric for both tools.** Prompt-bench runs are same-model (caching
  is comparable, like the selector), so the cross-model cache distortion is milder here —
  but using one metric across all comparison tools keeps a single mental model, and turn-count
  differences from a prompt change still inflate cache-read, so the cache-neutral measure
  remains the cleaner primary.
- **Winning variants are not auto-applied.** `agents/<name>.md` is committed source; the user
  edits it themselves if they accept a variant. (Automated prompt evolution — proposing the
  variant and applying winners — is the natural follow-up, noted in the roadmap.)

## v0.7.0 — automated prompt evolution

- **The third comparison consumer is a thin module over the shared engine**, as predicted.
  The duplicated "run both sides + variance top-up loop" in modelbench/promptbench was
  consolidated into `runComparison(db, spec)` in `compare.ts` (taking `runBaseline`/
  `runCandidate` closures), and `reportMetaCost` moved there too. `evolve.ts` reuses both;
  model/prompt-bench shrank to wiring. Behaviour preserved (the refactor kept all tests
  green and added a `runComparison` test with DB-backed fake runners).
- **Proposals are validated before a single benchmark token is spent.** `checkProposal`
  rejects a proposed variant that doesn't parse as an agent definition, changes any
  protected frontmatter field (name/tools/model/memory — identity and permissions), or has
  a trivially short body. The model call (`proposeVariant`, haiku, one turn, strict output)
  fails open: any error/invalid output logs to evolve.log and yields null — never throws,
  never retries (same discipline as the rule distiller).
- **Winners are recommended, never auto-applied — a deliberate departure from the rule
  selector.** The selector overwrites `MEMORY.md` (a generated build artifact, invariant
  #2); `agents/<name>.md` is hand-authored committed source. Auto-rewriting it on a haiku
  proposal gated only by three golden tasks would be reckless: the benchmark measures token
  cost + task completion, not the long tail of judgment the prompt encodes. So a measurable
  winner is written to `~/.token-warden/proposals/<agent>-<ts>.md` with a `diff` hint, and
  the human applies it. Acceptance gate: no regression, not within noise, ≥2 comparable
  tasks, positive delta.
- **The acceptance bar reuses `Comparison` flags verbatim** (`regression`, `uncertain`,
  `comparableTasks`, `delta`) — the same verdict logic that scores model and prompt
  benchmarks, so "is this prompt change worth it" is decided identically to "is this rule
  worth it." The discipline-as-asset thesis, fully closed: rules, models, and prompts all
  pass through one measured keep/reject gate.

## v0.8.0 — pen-test hardening + variance-conservative promotion

A defensive-security pass on the v0.6/v0.7 surface found three holes (empirically probed,
all fixed) and motivated one algorithm change.

- **`checkProposal` now protects `description` and rejects control characters.** The
  evolve proposal validator guarded name/tools/model/memory but not `description` — which
  steers Claude's delegation, so changing it is scope drift, not a token edit. And a
  proposal body carrying ANSI/control characters was accepted and written to the proposals
  file; it is now rejected (terminal-escape hygiene). Identity/permission drift and
  non-agent files (e.g. `/etc/passwd`) were already correctly rejected.
- **Comparison-report labels are sanitized at the engine boundary.** `compareConfigs`
  runs both labels (model ids from `--model`, variant filenames) through `displayText`
  (the status sanitizer) before they enter `Comparison`, so the report the slash commands
  relay into the model's context cannot carry injected newlines/ANSI — the same
  report-injection class the v0.4.0 audit closed for `/warden-status`. Confirmed: no shell
  injection (array-form `spawnSync`), and the proposal write path is safe (agent validated
  against DOMAIN_AGENTS, timestamped filename).
- **Variance-conservative rule promotion (the algorithm change).** Previously a candidate
  whose point-estimate savings cleared 2× rent was *activated even when the result was
  statistically uncertain* (within one standard error of the threshold) — it just got a
  "low confidence" note. But an active rule pays context rent in every future session, so
  promotion should require confidence, not a coin-flip. `finalizeVerdict(..., evictWhenUncertain)`
  now evicts a candidate that stays uncertain after the top-up budget. Re-audit passes
  `evictWhenUncertain=false`: an already-earning rule is de-activated only on evidence it
  has *stopped* earning (point estimate ≤ threshold), so one noisy re-audit can't churn out
  a good rule — an asymmetric "prove yourself to get in, but innocent until proven guilty
  once established" policy. Calibration check (live): a clear low-variance win still
  activates; only borderline candidates are newly rejected.

## v0.9.0 — real-time cost anomaly alerting (roadmap #4)

- **`systemMessage`, not `additionalContext`.** The Stop hook can inject context the model
  reacts to, but a "you just spent a lot" message fed back to the model would make it keep
  going (the turn ended) and risk a loop. Anomaly alerting is observability *for the human*,
  so it uses `systemMessage` (shown to the user, not the model). This is also why it does
  not auto-trigger any corrective action — it informs.
- **A higher bar than distillation.** The distiller triggers above the rolling p75 (catch
  enough expensive runs to learn from); an alert is rarer and louder — ≥ 2× the recent
  *median* with ≥ 5 priors — so it means "this was genuinely unusual," not "slightly above
  typical." `detectAnomaly` is a pure, tested function; the median/window query lives in db.
- **Main session only.** Subagent (`SubagentStop`) runs are mid-conversation; a popped
  systemMessage there would be noise. Subagent costs are still collected and feed
  distillation — they just don't raise a real-time alert.
- **Deliberately breaks the "collect is always silent" property — narrowly.** Until now the
  Stop hook emitted nothing (errors went only to collect.log). An anomaly alert is an
  intentional, rare, user-facing signal (not an error leak), gated behind a genuine 2×
  anomaly and an opt-out (`TOKEN_WARDEN_NO_ALERTS=1`). Same fail-safe contract: any error in
  the anomaly path is caught and emits nothing.

## Post-release — distribution

- **The repo is its own marketplace.** `.claude-plugin/marketplace.json` (marketplace
  name `vukkt-plugins`, plugin source `./`) lets users install via
  `/plugin marketplace add vukkt/token-warden` + `/plugin install token-warden@vukkt-plugins`.
  Official Anthropic marketplace names are reserved; community distribution is
  self-hosted by design.
## v0.2.0 — roadmap implementation

- **Variance-aware verdicts.** `assessDelta` reports the standard error of the per-task
  savings (sample SD / √n over tasks completed in both configs). When a verdict lies
  within one SE of the 2×rent threshold, the selector spends one bounded top-up pass
  (re-running the *measured* configuration only — the shared baseline is not topped up,
  an accepted asymmetry to keep cost bounded) and re-decides on the pooled results.
  Budget via `--top-up` (default 1; 0 disables). Verdicts still within noise are recorded
  with an explicit "low confidence" annotation in `decided_reason` rather than deferred —
  a candidate left pending would block the queue (max 3 per invocation, oldest first).
- **Selection stays manual by design.** The roadmap's "scheduled selection" shipped as a
  `SessionStart` nudge (`src/notify.ts`: one `additionalContext` line when candidates are
  pending, silent otherwise, fails open) plus a `/warden-select` command — NOT an
  auto-run, because selection spends real benchmark tokens and that remains a user
  decision. The SessionStart hook skips the npm bootstrap (`[ -d node_modules ] || true`):
  session startup must never wait on an install; the Stop hook handles bootstrapping.
- **Question-driven distillation** feeds the agent's 5 most recent outbound cross-agent
  questions into the distiller prompt as a memory-gap signal.
- **`runs.project` added (migration 6)** from the Stop payload's `cwd`; status shows
  real-work token volume per project. Pre-existing rows have NULL project ("(unknown)").
- **Golden suite changes deliberately deferred.** Replacing or editing a task would
  orphan its frozen baseline; legitimate growth means adding new task files with fresh
  task ids. Not done now to keep measurement continuity while the system accrues data.
- **The Stop hook self-bootstraps dependencies.** Marketplace installs copy the plugin to
  `~/.claude/plugins/cache` without `node_modules`, which would make collect.ts a silent
  no-op. The hook command now runs `npm install` once when `node_modules` is missing
  (timeout raised to 120s to cover that first run; steady-state runtime is unchanged,
  well under 2s). The gate hooks deliberately do NOT bootstrap — a PreToolUse hook
  blocking a SendMessage for a minute would be terrible UX, and the gate fails open
  by design until deps exist.

## v0.10.0–v0.12.0 — team-shared rule ledgers (roadmap #3)

- **Export shipped before import, deliberately.** v0.10 ships `/warden-share` as
  read-only: it writes an agent's active rules to a committed `.warden/<agent>.rules.md`
  (human bullets + round-tripping JSON, with proof and provenance) and cannot touch the
  collect/distill/select loop. The risky half — import — was held back precisely because
  a shared delta must be re-measured on the importer's own suite, never trusted.
- **Adopted rules get no new trust path.** v0.11 `/warden-adopt` queues a foreign
  ledger's rules as *candidates only*: the foreign delta is discarded, the context rent
  is recomputed locally, and by invariant #1 nothing enters memory until the local
  selector re-measures it. Near-duplicates of any existing rule (active/candidate/**evicted**)
  are skipped, so a rule already falsified locally can't be re-adopted; re-adoption is
  idempotent. The existing variance-conservative selector decides — unchanged.
- **The CI gate is deterministic and offline.** v0.12 `verify-ledger.ts` validates
  committed ledgers and exits non-zero on corruption/hand-editing — no model tokens, no
  secrets. A deeper gate that re-benchmarks each claimed delta in CI was left a documented
  *deployment choice*, not a default, because it needs a token budget and credentials.

## v0.14.0–v0.14.1 — security & simplification hardening

- **One presentation-security chokepoint.** `src/sanitize.ts` (`displayText`) centralizes
  control/ANSI stripping, now used by `status`/`compare`/`attribute`/`gate`. It closes the
  forged-newline / escape-sequence vector in the inter-agent `SendMessage` approval prompt
  (a hostile teammate message could otherwise obscure the line the user approves).
- **No invisible bytes in source.** The NUL-delimited map key in `attribute.ts` was
  replaced with a `JSON.stringify` key; `test/source-hygiene.test.ts` now fails the build
  on any NUL/disallowed control byte in `src/` or `test/`.
- **Verdict math is NaN-proof.** `assessDelta`'s degenerate-input boundaries are locked: a
  single comparable task yields a finite point estimate with null standard error; zero
  comparable tasks yield a null delta, never `NaN`.

## v0.15.0 — staged CI/CD pipeline

- **Releasing is one reviewable action that can't ship inconsistent versions.** `ci.yml`
  became dependent stages — `quality` → {`test` (Node 22/24), `fixture`} → `validate` →
  `release` — where `release` runs *only* on a `vX.Y.Z` tag, verifies the tag matches the
  manifests, and publishes the GitHub release from the `CHANGELOG.md` section. Tag-push is
  the entire deploy step; `scripts/check-versions.mjs` guards version drift locally and in CI.
- Added `CONTRIBUTING.md` and `SECURITY.md` as the standard project front matter.

## v0.16.0 — rule receipts

- **Receipts are additive capture; the verdict logic is unchanged.** A snapshot is written
  to `rule_receipts` (migration #9) at every decision — initial and each re-audit — so each
  rule carries an audit trail (savings vs. rent, ROI, model, golden-suite hash, per-task
  pass/fail).
- **The activity axis is surfaced, not auto-judged.** A large drop in tool calls / file
  re-reads is usually the *point* of an efficiency rule, so the receipt shows the signed-%
  numbers and leaves the call to a human; the binding safety gate remains the per-task
  pass/fail regression, which evicts on its own.

## v0.17.0 — coverage & dead-code gates

- **90% line coverage from real orchestration tests, not padding.** The subprocess/stdin
  CLIs (`collect`/`gate`/`distill`/`evolve`/`modelbench`/`promptbench`) are tested through
  mocked `child_process`/stdin boundaries (fail-open contracts, verdict decisions, anomaly
  alerts). A ratchet-floor threshold fails the build on any regression; the untestable
  `invokedDirectly` entry shims are honestly excluded via `v8 ignore`.
- **`knip` dead-code gate in CI**; 8 internal-only exports un-exported to tighten the API
  surface.

## v0.18.0 — strategic fixes from the real-token validation burn

- **The thesis was tested on real tokens (~9.3M), and the result drove the release.** The
  burn (see `FINDINGS.md`) validated measurement, the safety gate (it evicted a rule that
  saved 38k tokens by failing every task), and the learning pipeline — but **0 rules
  survived**, with the bottleneck located as benchmark variance (>25% run-to-run) plus
  candidate quality.
- **Two fixes, both aimed at the diagnosis.** Default `bench`/`select` run count 2 → 3 for
  a tighter standard error so a genuine small saving is distinguishable from noise; and the
  distiller's `buildPrompt` now forbids "false economy" rules (skip steps, retry less, cut
  verification, trade thoroughness for tokens).
- The v0.1.0 build spec was archived to `docs/original-spec.md` (historical), and a
  `validation/` harness made the burn reproducible (`run.sh`, `selftest.ts`,
  `dress-rehearsal.ts`).
