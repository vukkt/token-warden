# token-warden

[![CI](https://github.com/vukkt/token-warden/actions/workflows/ci.yml/badge.svg)](https://github.com/vukkt/token-warden/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/vukkt)

**Agent memory is charged rent.**
**A rule stays only if it proves, on a frozen benchmark,**
**that it saves more than it costs to carry.**

```text
  version    1.1.0             tests       ~1,120 across 41 files
  license    MIT               coverage    96% lines, CI-enforced floor
  source     25 modules        commands    7
              10.7k lines      built       2026-06 to 2026-09
```

---

## The problem

Agent "memory" is a text file of advice someone wrote once. It is pasted into every call,
forever, and nobody measures whether it helps.

A rule carried by four agents across a thousand sessions a week is paid for a thousand
times a week, silently.

## The loop

```text
   collect   ->   distill   ->   bench   ->   select
   a hook         one model      frozen       keep only if
   records        call reads     golden       it beats twice
   the cost       the waste      suite        its own rent
                                    |
                     evicted  <-----+----->  kept
                  recorded, never          re-audited;
                  silently dropped         two strikes and out
```

Seven commands. That is the whole surface.

`/warden-status` · `/warden-power` · `/warden-bench` · `/warden-select` · `/warden-receipt` · `/warden-cost` · `/warden-draft`

---

## The mathematics

Measurement here is expensive and noisy: the standard error runs **~5,500 tokens** against
a bar of **~54**. A signal-to-noise ratio of 1:100 is what every decision is really about.

Four proven results were proposed for it. All four were built and measured.

| | theorem | verdict |
|---|---|---|
| **allocate** | Neyman (1934) — optimal stratified allocation | **runs on every pass** |
| **pack** | Khuller, Moss & Naor (1999) — submodular greedy under a knapsack | built, idle: the window is not scarce |
| ~~moderate~~ | Smyth (2004) — empirical-Bayes variance | **deleted** — better estimator, worse gate |
| ~~control~~ | Benjamini-Hochberg / LORD++ — online FDR | **deleted** — 4x fewer errors, half the tokens |
| ~~schedule~~ | Karnin et al. (2013) — Successive Halving | **deleted** — no gain at three candidates |

**Three of the four were deleted, and that is the more useful half.** A codebase that ships
four proven algorithms proves it can copy from a paper. One that implements four, measures
them against its own data, and keeps what pays has done to itself the thing it claims to do
for memory rules.

A later survey scored **100 algorithms** the same way. Most die *structurally*: adjusting
for tool calls would cut the standard error 4.3x and is invalid, because a turn-reducing
rule works *through* tool calls — so controlling for them deletes the effect along with the
noise. That one was then built and measured rather than left as an argument: on the one real
rule effect on record, the adjustment subtracts **105.4%** of the saving away.

→ [The four theorems](docs/four-theorems.md) · [The hundred](docs/hundred-algorithms.md)

---

## What it actually saves

Read from the live ledger, priced at the agent's real token mix. Not a projection.

```text
  two surviving rules      6,353 tokens/session gross
  less rent                   55 tokens/session
  ---------------------------------------------------
  net                      6,298 tokens/session     ~ $0.0051 on Sonnet
```

Discovery cost **415 benchmark runs, 23.4M tokens, $19.13 — one-time and shared.** The
saving is per-developer and recurring:

| Team | Saved / year | Payback on discovery |
|---|---|---|
| 1 dev | $5 | 186 weeks |
| 5 devs | $27 | 37 weeks |
| 20 devs | $107 | 9 weeks |
| 50 devs | $267 | 4 weeks |
| 250 devs | $1,336 | under a week |

**Below roughly ten developers the arithmetic does not work on token savings alone.** What
you are buying at that scale is the *refusal* — that a rule which does not pay is deleted
instead of quietly accumulating.

> An earlier version of this section claimed $20/developer/year and omitted discovery cost
> entirely. It priced savings at the raw input rate instead of the blended mix, a 3.7x
> overstatement. Recomputed and corrected in the open.

---

## Why the numbers can be trusted

| | |
|---|---|
| **Tests** | 1,116 across 41 files — 17.8k lines of test against 10.7k of source |
| **Coverage** | 96% lines, 90% branches, behind a floor CI fails on |
| **Types** | Strict TypeScript. Zero `any`, zero `@ts-ignore`, zero non-null assertions |
| **Data** | SQLite, 17 versioned migrations under `BEGIN IMMEDIATE` |
| **Security** | Model output is untrusted: validated at the boundary, sanitized before display |

It publishes its own bad news. A zero-token A/A harness put the gate's false-positive rate
at **8.8%** where a synthetic model predicted 2.5% — the larger number is the one in the
docs. False *negatives* went unmeasured until v0.42.0, and the roadmap forbade fixing what
had not been measured; a rule saving 2% is falsely evicted **78.2%** of the time. That
figure was published at 79.8% and corrected downward — a retraction, not a quiet edit.

It has rejected **six of its own features** on measurement. Three had their code deleted
once the result was recorded; a tail-robust estimator that raised the false-positive rate
survives only as an advisory flag, never as a gate input; and two more were built, measured
and left out in the open — a measured replacement for the packer's redundancy signal, and a
covariate adjustment that halves the error bar on an effect that does not exist and cannot
see the one that does.

→ [Every measurement, with the sweeps](FINDINGS.md)

---

## Limits

- **No rule distilled from real production work has yet survived the gate.** Survivors so
  far come from benchmark runs. Whether real workloads hold catchable waste is the open
  question, and it is open.
- **The noise floor is the binding constraint, and it cannot be borrowed away.** One
  integer — the agent's turn count — explains ~94% of within-task spread. Conditioning on
  it (CUPED/ANCOVA) halves the minimum detectable saving under the additive effect every
  harness here simulates, and is useless against a real one: on the only rule effect this
  project has measured surviving the gate, the adjustment subtracts **105.4%** of the
  recorded saving away as noise, because turn count is the channel a rule saves through,
  not a nuisance beside it. That is why the rule-compression experiment stays **closed as
  unconfirmable** — three token burns, each killed by quota exhaustion, on an effect below
  a floor no estimator can lower.
- **An agent with no golden suite can now have one drafted** from its recorded sessions,
  which refuses more clusters than it emits — too-noisy, no derivable success check, or a
  check that already passes on the pristine fixture. A drafted suite is still
  **unvalidated**: whether the task is measurable under benchmark conditions costs tokens
  to learn, so drafts land where the benchmark does not read them until a human promotes
  one.
- **The packer's redundancy signal is still textual similarity** — and now for a measured
  reason rather than an unrun one. The savings-overlap replacement was built: `runs` carries
  no rule id, every rule is measured against one shared baseline so any two saving vectors
  correlate at 1/2 under a no-effect null at every depth, and the one recoverable pair's
  measured overlap sits at the 44th percentile of that null. A signal biased toward
  "redundant" would evict measured savings on an artifact.
- **The gate-loosening result replicated in direction on a second pool, not in bracket.** A
  looser gate nets more tokens at every overlap, on both pools. But the published claim that
  returning to `z = 2.0` would need an absurd harm was a near-zero denominator on one pool;
  on the second the same number is ~a fifth of one tool call. No default moved.
- The shipped agents are already well optimized, so the largest measured savings come from
  a deliberately naive positive control, built to prove the engine detects a real effect.

---

## Try it

Node.js 22+, Claude Code v2.1+.

```text
/plugin marketplace add vukkt/token-warden
/plugin install token-warden@vukkt-plugins
```

Sessions are measured immediately; `/warden-status` shows the data.

```bash
git clone https://github.com/vukkt/token-warden.git && cd token-warden && npm install
npm run bench -- --agent all       # freeze baselines, once
npx tsx src/select.ts --agent sql  # measure pending candidates
```

---

MIT · built by [@vukkt](https://github.com/vukkt) · [sponsor](https://github.com/sponsors/vukkt)
