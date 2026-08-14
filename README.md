# token-warden

[![CI](https://github.com/vukkt/token-warden/actions/workflows/ci.yml/badge.svg)](https://github.com/vukkt/token-warden/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/vukkt)

**A Claude Code plugin that makes AI coding agents measurably cheaper — and refuses to claim
a saving it cannot prove.**

Every rule that wants space in an agent's context must demonstrate, on a frozen benchmark,
that it saves more tokens than it costs to carry. Rules that fail are evicted. Rules that
already passed are re-tested and evicted when they stop paying.

```text
  version    0.43.1            tests       1271 across 54 files
  released   48 versions       coverage    97.1% lines, CI-enforced floor
  built      2026-06 to now    source      43 modules, 15.7k lines
  license    MIT               test code   20.0k lines
```

---

## The problem

Agent "memory" is usually a text file of advice someone wrote once. Nobody measures whether
it helps. It costs tokens on every single call, forever, whether or not it works.

At team scale that is a real line item: a rule carried by four agents across a thousand
sessions a week is paid for a thousand times a week, silently. The question nobody was
answering is the obvious one — **does this rule actually pay for itself?**

token-warden answers it with a measurement, or refuses to answer.

---

## How it works

```mermaid
flowchart TD
    S["agent session, any project"]
    C["1 COLLECT - collect.ts, transcript.ts"]
    D["2 DISTILL - distill.ts"]
    B["3 BENCH - bench.ts"]
    SEL["4 SELECT - select.ts"]
    MEM["MEMORY.md, compiled rules"]

    S -->|Stop hook parses the transcript| C
    C -->|session cost above rolling p75| D
    D -->|0-2 candidate rules| B
    B -->|measured delta vs context rent| SEL
    SEL -->|survivors only| MEM
    MEM -->|injected into the next session| S
```

Stages 1 and 2 run automatically in the background. The collector lives in a `Stop` hook
under a hard sub-2-second budget and fails open — any error exits 0, so a session is never
blocked. Stages 3 and 4 are an explicit command, so token spend is always a decision the
operator makes.

---

## Results

Six candidate rules, measured on the `sql` agent across **397 headless benchmark runs**.
Read from the live ledger, not a simulation.

```text
  measured delta per candidate rule, tokens/run

          -10k      -5k     0      +5k     +10k
  rule 1    -9,215  ######################|
  rule 2    -6,134         ###############|
  rule 3      +622                        |#
  rule 4    +5,731                        |##############
  rule 5   +10,851                        |##########################
```

| Rule | Measured delta | Bar to clear | Outcome |
|---|---|---|---|
| 1 | -9,215 | 28 | evicted, negative on re-audit |
| 2 | -6,134 | 30 | evicted, negative |
| 3 | +622 | 57 | **kept** |
| 4 | +5,731 | 60 | **kept** |
| 5 | +10,851 | 30 | evicted, **uncertain** (SE 7,814) |
| 6 | -71,998 | 30 | evicted, quota-death artifact |

**Two of six survived.** The interesting row is 5: it measured +10,851 tokens saved per run,
362x the bar it needed to clear, and was still evicted — its standard error of 7,814 meant
the result could not be distinguished from noise. The system is built to refuse exactly that
number, because a measurement instrument that reports what you hope for is not an
instrument.

Row 6 is what a quota death looked like before the tool learned to recognize one. That
garbage verdict is why the environment-failure guard exists; today the same run records no
verdict at all.

---

## Economics

The two surviving rules save a combined **6,353 tokens per session**. At Claude Sonnet input
pricing that is **$0.019 per session** — trivial once, material at volume.

| Deployment | Sessions/week | Per year, 1 agent | Per year, 4 agents |
|---|---|---|---|
| Solo developer | 20 | $20 | $79 |
| Small team (5x) | 100 | $99 | $396 |
| Engineering org (50x) | 1,000 | $991 | $3,964 |
| Enterprise (250x) | 5,000 | $4,955 | $19,821 |
| Platform scale | 25,000 | $24,777 | $99,107 |

Roughly 0.33x on Haiku, 1.67x on Opus, 3.3x on Fable. Any row is reproducible with
`/warden-cost --project --sessions-per-week <n>`.

> These are benchmark measurements on a frozen fixture priced at the input rate, not
> observed invoices, and they assume rules of this size survive on your workload — which is
> the thing the tool measures rather than assumes. See *Limitations* below.

---

## Context architecture

The same question, one level up: **one big prompt, or a retrieval pipeline?**
That is normally settled by argument. It is an empirical question with a different answer
per corpus, and `/warden-ragbench` measures it — at **zero tokens**, because whether a
strategy put the answer in front of the model is decidable without calling one.

Measured on a 5-document financial corpus (a 10-K, its prior year, an earnings-call
transcript, a segment table, and an HTML credit agreement) against 12 golden questions
with known answers:

```text
  answer recall vs retrieval budget

  budget      bm25   section      full
     200       22%       22%      100%
     400       67%       67%      100%
     600       89%       78%      100%
     800       89%       89%      100%
   1,200      100%      100%      100%
   2,400      100%      100%      100%
```

| Architecture | Cost/question | Answer recall | Doc recall | Verdict |
|---|---|---|---|---|
| Mega-prompt (whole corpus) | 4,474 tok | 100% | 100% | Never misses. Pays for everything, every question, forever. |
| Lexical retrieval (`bm25`) | 1,198 tok | 100% | 100% | **3.7x cheaper**, same answers |
| Section retrieval | 1,198 tok | 100% | 100% | **3.7x cheaper**, same answers |

The knee is real — recall collapses to 22% at 200 tokens — and everything to the right of
it is context that changed no answer. **A corpus nobody filtered and a rule nobody measured
are the same mistake at different scales**, which is why this lives here rather than in a
separate tool.

> **Correction, 2026-08-13.** This section previously reported the knee at 400 tokens and
> **11.2x**, with `section` retrieval beating `bm25`. That was wrong, and the fault was in
> the scorer rather than the retriever. `valueAppearsIn` — which decides whether a
> strategy put the answer in the context — generated its trailing-zero variants with
> `toFixed()` under a magnitude guard, so it also accepted every rendering a value *rounds*
> to. It scored the 3.25x covenant as retrieved because the context said `3.0x`, the 3.75x
> maximum because the context said `4.1 million shares`, and a 14.5% margin because a
> transcript said `roughly 15 to 18` distribution centres. The gate's own decision log says
> in as many words that value matching "enumerates renderings; it does not use a tolerance";
> a half-unit-in-the-last-place window had been sitting inside it since v0.42.0. Fixed, with
> the three real cases pinned as regression tests and the knee pinned in CI. The corrected
> ratio is 3.7x, the corrected `section`-vs-`bm25` ordering is a tie, and no number in this
> section had a test holding it in place before now.

> A 5-document corpus is small enough that the mega-prompt is a legitimate architecture.
> Retrieval savings scale with corpus size while retrieval cost does not, so 3.7x is a
> floor, not a headline. The tool prints that caveat with the number.

Three things the pipeline does that are worth naming:

- **Every extracted fact must cite its source and quote the span containing its value**,
  and that check runs mechanically, without a model. Schema validation cannot catch a
  fabricated figure — a made-up number is a valid `number`. Claims that fail are rejected
  and counted, turning hallucination from an invisible failure into a reported column. The
  column has so far read zero on every real burn: unit tests prove the gate fires on
  fabricated input, so this is "no fabrication detected", not a demonstration that the gate
  earns its place.
- **Two of the twelve golden questions have no answer in the corpus**, and one has a
  guidance range sitting exactly where the actual would be. They are scored inversely:
  correct means the pipeline declined. A pipeline that cannot say "not in these documents"
  will always find something.
- **Retrieval is lexical, deliberately** — financial answers turn on exact periods, and an
  embedding places "Q3 2023 revenue" and "Q3 2024 revenue" on top of each other. The
  admitted cost is paraphrase blindness, and `fin-07` is in the suite as the case that
  should expose it: the corpus says "undrawn capacity", the question says "borrowing
  capacity". It is the bar a semantic retriever would have to clear — but honesty about it
  cuts the other way too. **`fin-07` does not actually fail.** Both lexical arms retrieve
  and answer it at every budget at or above the knee. The predicted weakness is real in
  principle and does not bind on this corpus, so the suite does not currently contain a
  case a semantic retriever would win.

Measured once, end to end, against a live model (2026-07-28): four burns, of which the
first three found defects in the instrument rather than results — a dead environment
reporting an identical 33.3% for all four arms, a "multi-hop" arm that stopped on hop 1
every time, and a schema whose `period` bound rejected the very answer shape the
cross-document questions need. The fourth burn ran: 11 of 12 completed, 11 of 11 correct on
the `agent` arm, hops `{1: 10, 2: 2}`. What that does **not** establish is any accuracy
ranking between the four architectures — it was a single-arm subset run, and the one paired
table that exists reverses its own ordering depending on whether failed runs are excluded.
Recall bounds accuracy from above; it does not substitute for it. See FINDINGS.md.

---

## Engineering

The measurement discipline is the product, so the codebase is held to it.

| | |
|---|---|
| **Tests** | 1271 across 54 files. 20.0k lines of test code against 15.7k of source. |
| **Coverage** | 97.0% lines, 96.2% statements, 97.4% functions, 89.2% branches, behind a ratcheted floor CI fails on. |
| **Pipeline** | Staged: quality gates test, fixture and coverage, which gate validate, which gates release. Actions SHA-pinned, least-privilege tokens, `npm ci`. |
| **Types** | Strict TypeScript with `noUncheckedIndexedAccess`. Zero `any`, zero `@ts-ignore`, zero non-null assertions across src and test. |
| **Data** | SQLite with 16 versioned migrations, applied transactionally under `BEGIN IMMEDIATE` so two concurrent processes cannot both apply one. |
| **Security** | Model-generated text is untrusted: validated at the boundary, sanitized before display (control, bidi and zero-width characters), and benchmarks run under scoped permissions, never `bypassPermissions`. |

Three decisions that show the standard better than the metrics do:

- **It measured its own error rates and published the bad news — both tails.** A zero-token
  A/A harness put the gate's false-POSITIVE rate at **8.8%**, against the ~2.5% a synthetic
  model predicted; the larger number is the one in the docs. The false-NEGATIVE rate went
  unmeasured until v0.42.0, and the roadmap forbade building anything to fix it until it
  was measured. It is now: a rule that genuinely saves 2% of a run is falsely evicted
  **78.2%** of the time over twelve re-audits. The unflattering tail turned out to be an
  order of magnitude larger than the flattering one, and it reordered the roadmap. That
  first figure was published as 79.8% and then corrected downward in v0.43.0, because the
  harness had been deciding each simulated re-audit on its first look while the selector
  has always bought a second — a retraction, not a quiet edit.
- **It measured two of its own designs to zero and threw them away.** The v0.43.0 retention
  budget went through three shapes. Spending extra re-audit runs the way the roadmap itself
  proposed moved the false-eviction rate 78.2% to 79.1% — nothing, and it would have billed
  2.2 extra benchmark passes per re-audit to do it — because a one-sided budget cannot cut
  an error that sums both sides. Placing those runs by Neyman
  allocation, the house style everywhere else in the codebase, was actively worse than
  spreading them evenly. Only the third shape shipped: a 10% rule now survives its re-audits
  three times more often (16.3% falsely evicted to **5.4%**).
- **It rejected one of its own features.** A tail-robust estimator looked like an
  improvement until calibration showed it *raised* the false-positive rate. It ships as an
  advisory flag and is kept out of the gate.
- **Refactors are proven, not asserted.** Extracting the statistics module was verified by
  fingerprinting 10,960 verdict-path outputs before and after across swept configuration —
  bit-identical, SHA-256 matched, before the change was committed.

---

## Timeline

| | |
|---|---|
| First commit | 2026-06-11 |
| Releases | 48 tagged versions across ~8 weeks |
| Current | v0.43.0 |
| Cadence | Ships behind a green pipeline; every release note names what is unproven |

Recent arc: variance-aware verdicts and Neyman allocation, empirical self-calibration, a
four-layer environment-failure abort validated against three real quota deaths,
distribution-weighted suites, bring-your-own-agent, a repository-wide hardening pass, a
shared-module extraction, retrieval admitted as a second measurable context source, and a
retention budget that cut the false-eviction rate after two of its own designs measured to
nothing.

---

## Limitations

Stated plainly, because the project's only real claim is that it does not overstate.

- **No rule distilled from day-to-day production work has yet survived the gate.** Survivors
  so far come from benchmark runs. Whether real workloads contain catchable, generalizable
  waste is the open question — `/warden-cohort` and `/warden-confirm` exist to answer it.
- **Only work routed through a measurable agent can be learned from.** Main-thread sessions
  (and ad-hoc subagent types) are recorded and cost-attributed, but distillation is gated on
  the agent having a golden suite and an agent-memory file, so they can never produce a
  candidate rule. `/warden-dogfood` reports which of your recorded sessions are inert and
  what to do about it.
- The rule-compression experiment is **closed as unconfirmable**, not as a win: three token
  burns were each killed by quota exhaustion, and the effect is smaller than the suite's own
  noise at any affordable run count.
- The shipped agents are already well optimized, so the largest measured savings come from a
  deliberately naive positive control built to prove the engine detects a real effect.
- **The retrieval numbers rest on a 5-document, 4,474-token corpus** — a toy. The ratio is
  labelled a floor because retrieval savings scale with corpus size while retrieval cost
  does not, but a floor measured on a toy is still a toy measurement. It is also the
  youngest and least-validated code in the repo: its headline was wrong once (see the
  correction above), and its end-to-end path has been run on exactly one day.

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

`/warden-dogfood` says, for free, whether collection is actually live and whether the
sessions you are recording can be learned from at all.

The bench step spends real tokens — `/warden-power` sizes it first, for free. 22 commands
cover reporting, cost, A/B benchmarking of models, prompts and context architectures,
governance and team sharing. The context-architecture benchmark runs for free:

```bash
npx tsx src/ragbench.ts --sweep              # recall/cost frontier, zero tokens
npx tsx src/ragbench.ts --dir <your-corpus>  # point it at your own documents
```

---

[ARCHITECTURE.md](ARCHITECTURE.md) — module map and data model ·
[DECISIONS.md](DECISIONS.md) — every non-obvious choice and why ·
[FINDINGS.md](FINDINGS.md) — experiments, including the failures ·
[ROADMAP.md](ROADMAP.md) ·
[CONTRIBUTING.md](CONTRIBUTING.md) ·
[SECURITY.md](SECURITY.md)

MIT.
