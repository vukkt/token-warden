# Validation harness — does the loop actually make sessions cheaper?

token-warden's entire thesis is one falsifiable claim:

> A rule that passes the benchmark (saves ≥ 2× its context rent) makes the
> agent's real work measurably cheaper, and stays cheaper as rules accumulate.

This harness runs that experiment end-to-end against an **isolated** database so
your real `~/.token-warden/warden.db` is never touched, and reports the verdict.

## The experiment

Controlled before/after on one agent's golden suite (a fixed, repeatable
workload on the frozen fixture repo — far fewer confounds than ad-hoc real work):

1. **Freeze baselines** — run the suite with no rules. `run1_tokens` is the
   permanent denominator for every later claim (design invariant #5).
2. **Introduce a candidate** — either a curated, plausible efficiency rule
   (default, deterministic) or let real distillation produce one from collected
   sessions (more faithful, slower).
3. **Select** — the selector benchmarks the candidate *with vs. without* on the
   real suite and keeps it only if it clears 2× rent with confidence; it also
   re-audits the oldest active rule.
4. **Re-measure** — run the suite again with the surviving rules compiled in.
5. **Report** — golden-suite cost now vs. frozen `run1` (per `/warden-status`),
   the per-rule receipts (`/warden-receipt`), and the real-work learning curve
   if any real sessions were collected.

## Controls

- Same model both sides (the candidate measurement holds the model constant).
- Same tasks, frozen fixture (`benchmarks/fixture`), frozen `run1` denominator.
- Isolated DB via `TOKEN_WARDEN_DB` — no contamination, fully reproducible.
- Variance handled by the selector's standard-error top-up; a rule within noise
  of the threshold is evicted, not kept.

## Success criterion

The loop is validated for this agent if, after `run.sh`:

- at least one candidate **survives** selection (delta ≥ 2× rent, no regression), and
- the suite total **now** is below the frozen `run1` total (a negative `% vs run1`
  in `/warden-status`), driven by the surviving rule(s).

It is **falsified** (valuable to know!) if good-looking candidates are all
evicted as within-noise, or the suite cost does not drop — that means the effect
size is below the measurement floor on this workload, and the approach needs a
bigger/cheaper-to-measure signal before chasing users.

## Run it

```bash
# one agent (default sql); spends real `claude` tokens against an isolated DB
./validation/run.sh sql
```

**Cost/time:** scales with suite size × runs (default 3 per task). Roughly
freeze = tasks × 3, selection = baseline + candidate + optional top-up +
re-audit, re-measure = tasks × 3 — so budget ~30–60 headless `claude` sessions
for one agent (the `sql` suite is 5 tasks, `testing` 4, `frontend`/`backend` 3).
`sql` is the cheapest per task; `testing`/`backend` have heavier tasks. Requires
`claude` logged in.

## Prove the harness works *without* spending tokens

```bash
npx tsx validation/selftest.ts
```

Seeds the isolated DB with a synthetic before/after (expensive v0 sessions, then
cheaper v1 sessions after a rule) and prints the report, confirming the
measurement + learning-curve machinery correctly detects and surfaces savings
when they exist. This validates the *harness*, not the *thesis* — only `run.sh`
with real `claude` runs can validate the thesis.

## Reading the result

After `run.sh`, the report prints:
- `suite now vs run1 (frozen)` — the headline. Negative `%` = cheaper than the
  unruled baseline.
- Active rules with `delta=+N rent=M` — each surviving rule and what it earns.
- `/warden-receipt` cards — the full evidence (token + quality axis) per rule.
