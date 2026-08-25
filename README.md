# token-warden

[![CI](https://github.com/vukkt/token-warden/actions/workflows/ci.yml/badge.svg)](https://github.com/vukkt/token-warden/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/vukkt)

**Agent memory is charged rent. A rule stays only if it proves, on a frozen benchmark, that
it saves more tokens than it costs to carry.**

That is the whole idea. Everything below is either the loop that enforces it, the two
theorems that survived measurement, or the record of the three that did not.

```text
  version    1.1.0             tests       ~960 across 36 files
  license    MIT               coverage    96% lines, CI-enforced floor
  source     24 modules        commands    6
              9.5k lines       built       2026-06 to 2026-08
```

---

## The problem

Agent "memory" is usually a text file of advice someone wrote once. Nobody measures whether
it helps. It costs tokens on every single call, forever, whether or not it works.

A rule carried by four agents across a thousand sessions a week is paid for a thousand times
a week, silently. The question nobody was answering is the obvious one — **does this rule
actually pay for itself?**

token-warden answers it with a measurement, or refuses to answer.

---

## The loop

```text
  collect  ->  distill  ->  bench  ->  select
  (hook)       (1 model     (golden   (keep only if
                call)        suite)    it pays rent)
```

A Stop hook records what each session cost. When a session runs expensive, one model call
proposes candidate rules from the waste trace. `/warden-select` then runs a frozen golden
suite with and without each candidate, and keeps only what clears the bar.

Six commands, and that is the entire surface:

| | |
|---|---|
| `/warden-status` | see state |
| `/warden-power` | plan a burn before spending on it |
| `/warden-bench` | run the golden suite |
| `/warden-select` | measure pending candidates and decide |
| `/warden-receipt` | the evidence behind any verdict |
| `/warden-cost` | the dollar lens |

---

## Two theorems, and three that did not survive

The hard part is not the loop. It is that the measurement is expensive and noisy: the
standard error on a suite runs around **5,500 tokens** against a bar around **54**. A
signal-to-noise ratio of 1:100 is what every design decision here is really about.

Four proven results were proposed for that problem. All four were implemented and measured
against the recorded data. **Two earned their place:**

| stage | theorem | runs |
|---|---|---|
| **allocate** | Neyman (1934), optimal stratified allocation | **always** — every top-up pass |
| **pack** | submodular greedy under a knapsack — Khuller, Moss & Naor (1999) | only under `WARDEN_CONTEXT_BUDGET`, which is **unset by default** |

The knapsack's `(1-1/e)/2` bound is verified against brute-force optima over 800 random
instances rather than cited in a comment.

**So one theorem runs in a default install, not two, and the reason is arithmetic rather
than caution.** The knapsack manages scarcity in the context window, and at observed rule
counts there is none: rule bodies are capped at 200 characters, so 100 rules would occupy
about 2,800 tokens — **1.4% of a 200k window**. This ledger has measured six rules in ten
weeks. A budget generous enough not to evict rules you paid to measure would never bind for
anyone; a budget tight enough to bind would start throwing away measured savings. There is
no honest default between those, so it ships unset.

The code stays wired because its cost when idle is one null check, and it is the only thing
that would handle rule accumulation if that ever becomes real. That is a different case
from the three deleted theorems, which were measured and found *harmful or neutral at the
operating point*; this one is measured as **not yet needed**.

**The other three were deleted, and that is the more useful half of this project.** A
codebase that ships four proven algorithms proves it can copy from a paper. One that
implements four, measures them against its own data, and keeps the two that pay has done
the thing it claims to do for memory rules — to itself. Full derivations and every
correction: **[docs/four-theorems.md](docs/four-theorems.md)**.

---

## What the measurements said

This is the part worth reading. **Three of the four proposed theorems were implemented,
measured, rejected, and deleted** — and the one gate change that shipped goes the opposite
way from five versions of prior work. The code is gone; the evidence is not, which is the
right way round.

**Variance moderation (Smyth 2004) was rejected.** Replacing each task's
2-degree-of-freedom sample variance with an empirical-Bayes posterior is a strictly better
*estimator* — it more than halves log-MSE even at three tasks. It made the gate strictly
*worse*: false positives flat (8.9% -> 9.2%), power down at every effect size. The estimator
is fitted on `log s^2` and so is biased on the natural scale, running 1.84x high at df=1,
which widens the confidence band by 35% and costs exactly that power. **Minimising
estimation error and maximising decision quality are different objectives.**

**Online FDR control (LORD++) was rejected, and it is the more interesting failure.** It
does what it promises — a 4x cut in false discoveries — and loses on tokens anyway:

| arm | false discoveries in memory | net tokens saved / run |
|---|---|---|
| shipped gate | 55.1% | **14,218** |
| LORD++ online FDR | 13.3% | 5,588 |

A worthless rule costs its rent, ~25 tokens/run. A missed real rule forfeits its whole
saving, ~4,769 tokens/run. **False positives are ~191x cheaper than false negatives**, so a
rule is worth keeping once `P(real)` exceeds about 0.5% — while `z=2` demands 97.7%. The
looser arm wins on net tokens in all nine cells of a true-rate x effect-size sweep,
including the cell where its own false-discovery rate reaches 95%.

**So the default confidence multiple dropped from 2 to 1.5**, reversing v0.29.0:

| z | false positive | power at a 10% saving |
|---|---|---|
| 1.0 | 19.4% | 63.0% |
| **1.5** | **9.8%** | **46.1%** |
| 2.0 | 8.9% | 34.9% |

11.2 points of power for 0.9 points of false positives, with overlapping intervals. Every
statistical change this project had made — z from 1 to 2, robust SE, two-strike retention,
confidence sequences, a t-correction — pushed the gate *stricter*. It was already about 200x
too strict for its own economics.

The design the evidence supports is the inverse of what was built: **permissive at the gate,
strict at the packer.** Scarcity logic belongs where the scarcity actually is — the context
window — not at the admission test.

**Successive Halving was rejected for having no room to work.** It is correct and it is
the right tool at scale — above ~8 candidates its advantage reaches 2.3x. But
`MAX_CANDIDATES_PER_INVOCATION` is 3, and at three candidates with three runs a side the
schedule gives the winner **exactly the same evidence uniform allocation does**. Zero gain,
in exchange for restructuring the gate and accepting false negatives.

Measuring it also found it was *wrong*: when a round could not afford one run per arm it
skipped that round while still narrowing the field, so seven arms became a plan over two
with five discarded on no measurement at all. Twelve tests passed throughout. It was fixed
and pinned before being deleted — a negative result about a broken implementation is not a
result.

All three deletions follow the same rule: a correct implementation is what makes a negative
result trustworthy, and once the result is recorded the code has no further job.

All of it, with the sweeps: **[FINDINGS.md](FINDINGS.md)**.

---

## Economics

The two surviving `sql` rules save **6,353 tokens per session** gross, **6,298 net** of the
55 tokens/session they cost to carry. Read from the live ledger, not a projection. Priced at
the agent's real token mix — 90% cache-read, the cheapest tokens there are — that is
**$0.0051 per session on Sonnet**.

| Sessions/week per dev | Saved per developer, per year |
|---|---|
| 10 | **$2.67** |
| 20 | **$5.34** |
| 40 | **$10.69** |

Finding those two rules cost **415 benchmark runs and 23.4M tokens — $19.13 one-time**.
Against $5.34/year, one developer never realistically recovers that:

| Team size | Team saving/year | Payback on the $19 discovery burn |
|---|---|---|
| 1 dev | $5 | 186 weeks |
| 5 devs | $27 | 37 weeks |
| 20 devs | $107 | 9 weeks |
| 50 devs | $267 | 4 weeks |
| 250 devs | $1,336 | under 1 week |

**This is the honest shape of the tool.** Discovery is one-time and shared; the saving is
per-developer and recurring. Below roughly 10 developers the arithmetic does not work on
token savings alone — what you are buying at that scale is the *refusal*, the fact that a
rule which does not pay gets deleted rather than accumulating.

> **Correction, 2026-08-19.** This section previously reported **$20/developer/year** and
> made no mention of discovery cost. It priced the saving at the raw **input** rate when the
> tool prices at the blended mix — a 3.7x overstatement — and reported gross savings while
> omitting the one-time burn that produced them, which is the difference between "saves
> $20/year" and "pays back in three and a half years". Recomputed from the live ledger
> through `src/pricing.ts`.

> These are benchmark measurements on a frozen fixture, not observed invoices, and they
> assume rules of this size survive on your workload — which is the thing the tool measures
> rather than assumes. See *Limitations*.

---

## Engineering

The measurement discipline is the product, so the codebase is held to it.

| | |
|---|---|
| **Tests** | 957 across 36 files. 15.5k lines of test against 9.5k of source. |
| **Coverage** | 95.7% lines, 94.6% statements, 96.5% functions, 89.1% branches, behind a floor CI fails on. |
| **Pipeline** | Staged: quality gates test, fixture and coverage, which gate validate, which gates release. Actions SHA-pinned, `npm ci`. |
| **Types** | Strict TypeScript with `noUncheckedIndexedAccess`. Zero `any`, zero `@ts-ignore`, zero non-null assertions. |
| **Data** | SQLite, 16 versioned migrations applied transactionally under `BEGIN IMMEDIATE`. |
| **Security** | Model-generated text is untrusted: validated at the boundary, sanitized before display, benchmarks run under scoped permissions, never `bypassPermissions`. |

Four decisions that show the standard better than the metrics do:

- **It measured its own error rates and published the bad news — both tails.** A zero-token
  A/A harness put the gate's false-POSITIVE rate at **8.8%** against the ~2.5% a synthetic
  model predicted; the larger number is the one in the docs. The false-NEGATIVE rate went
  unmeasured until v0.42.0, and the roadmap forbade building anything to fix it until it was
  measured. It is now: a rule saving 2% of a run is falsely evicted **78.2%** of the time
  over twelve re-audits. That figure was published as 79.8% and corrected downward in
  v0.43.0 — a retraction, not a quiet edit.
- **It measured two of its own designs to zero and threw them away.** Spending extra
  re-audit runs the way the roadmap itself proposed moved false eviction 78.2% to 79.1% —
  nothing, for 2.2 extra passes — because a one-sided budget cannot cut an error that sums
  both sides. Placing them by Neyman allocation, the house style everywhere else in this
  codebase, was actively worse than spreading them evenly.
- **It has now rejected four of its own features on measurement**: a tail-robust estimator
  that raised the false-positive rate, variance moderation, online FDR, and Successive
  Halving. Three were deleted outright once the result was recorded — a negative result
  needs a correct implementation to be trustworthy, and nothing after that.
- **Refactors are proven, not asserted.** Extracting the statistics module was verified by
  fingerprinting 10,960 verdict-path outputs before and after — bit-identical, SHA-256
  matched, before the change was committed.

---

## Limitations

Stated plainly, because the project's only real claim is that it does not overstate.

- **No rule distilled from day-to-day production work has yet survived the gate.** Survivors
  so far come from benchmark runs. Whether real workloads contain catchable, generalizable
  waste is the open question, and it is still open.
- **Only work routed through a measurable agent can be learned from.** Distillation is gated
  on the agent having a golden suite, so main-thread sessions never produce a candidate.
- **The packer's redundancy signal is a textual proxy.** `src/knapsack.ts` is wired into
  memory compilation behind `WARDEN_CONTEXT_BUDGET` (unset = unbounded, and byte-identical
  to before), and it detects near-duplicate rules by trigram overlap between their bodies —
  the same measure the distiller already uses to decide two rules *are* the same rule. That
  is similarity of **wording**, not of what two rules actually save. It will miss rules
  worded differently that address the same waste, and over-discount rules worded alike that
  address different waste. Measuring real pairwise savings overlap is a token burn nobody
  has run.
- **The gate-loosening result rests on one agent's replicate pool** — `sql`, three tasks, two
  runs a side. The direction is robust across nine parameter cells; the exact optimum is not.
- The rule-compression experiment is **closed as unconfirmable**, not as a win: three token
  burns were each killed by quota exhaustion.
- The shipped agents are already well optimized, so the largest measured savings come from a
  deliberately naive positive control built to prove the engine detects a real effect.

---

## Try it

Node.js 22+, Claude Code v2.1+.

```text
/plugin marketplace add vukkt/token-warden
/plugin install token-warden@vukkt-plugins
```

Sessions are measured immediately; `/warden-status` shows the data. To run the part that
saves tokens:

```bash
git clone https://github.com/vukkt/token-warden.git && cd token-warden && npm install
npm run bench -- --agent all      # freeze baselines, once
npx tsx src/select.ts --agent sql # measure pending candidates
```

---

MIT. Built by [@vukkt](https://github.com/vukkt).
