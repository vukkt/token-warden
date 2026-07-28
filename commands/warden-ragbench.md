---
description: Measure context architecture over a document corpus — mega-prompt vs retrieval pipeline vs multi-hop agent — on answer recall, token cost, and citation groundedness. Default mode is ZERO tokens; --yes spends them.
argument-hint: "[--sweep] [--budget N] [--dir <suite>] [--json] [--yes]"
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden context-architecture benchmark:

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/ragbench.ts $ARGUMENTS
```

Answers "should this agent get one big prompt or a retrieval pipeline?" with a
measurement instead of an argument.

**Default (zero tokens).** For each strategy — `full` (whole corpus in the
prompt), `bm25` (lexical top-k under a token budget), `section` (expand each hit
to its whole section) — reports mean context tokens, answer recall, document
recall, and tokens spent per answer made available. Recall is checkable without
a model because the shipped corpus is synthetic and its ground truth is known.

**`--sweep` (zero tokens).** Sweeps the retrieval budget and reports the
recall/cost frontier plus the knee: the smallest budget at which retrieval still
answers everything the mega-prompt answers. This is usually the number worth
acting on — everything to the right of the knee is context that changed no
answer.

**`--yes` (SPENDS TOKENS).** Runs every arm end to end against a real model,
including a fourth `agent` arm that issues follow-up queries it could not have
written before seeing the first result. Reports accuracy against known answers,
mean hops, and — the column that matters — how many extracted claims the
citation gate REJECTED. Every fact must cite a chunk and quote the source span
containing its value; anything that fails is discarded, not flagged.

Point it at your own documents with `--dir <path>` (expects `questions.json` and
a corpus directory beside it) or `TOKEN_WARDEN_RAG_SUITE`.

Known limitation, stated because the suite deliberately tests for it: retrieval
here is lexical, so a question that shares no vocabulary with its answer
(`fin-07`) underperforms. That question is in the suite on purpose — it is the
bar a semantic retriever would have to clear to justify itself.
