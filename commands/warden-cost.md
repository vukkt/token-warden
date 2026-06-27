---
description: Dollar accounting — what does each active rule actually save, in money? Translates the token-measured verdict into dollars using a price table and the agent's own token-type mix, with a per-session net and a break-even. Read-only; spends no tokens.
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(npx tsx:*)
---

Run the token-warden dollar report (read-only; it prices the stored receipts):

```
cd "${CLAUDE_SKILL_DIR}/.." && npx tsx src/cost.ts $ARGUMENTS
```

Argument forms (pass through verbatim as `$ARGUMENTS`):

- *(no args)* — per-rule dollar report for every domain agent
- `--agent sql` — one agent
- `--json` — machine-readable output
- `--project` — horizon projection (default **13 weeks ≈ 3 months**): gross
  savings, operating (discovery) cost, NET benefit, break-even, and the cost
  **with vs without** the plugin over that span
- `--months 6` / `--weeks 26` — set the projection horizon (implies `--project`)
- `--sessions-per-week 40` — assumed session volume for the projection (implies
  `--project`; defaults to `WARDEN_SESSIONS_PER_WEEK`)

Prices default to the public Anthropic rate card; override any rate with the
`TOKEN_WARDEN_PRICE_INPUT` / `_OUTPUT` / `_CACHE_WRITE` / `_CACHE_READ` env vars
(in $/1M tokens) to apply your own per-token prices.

Relay the report to the user. Always preserve the honest accounting note it
prints: savings are priced at the agent's **blended** $/token mix (most saved
tokens are cheap input/cache-read, so the dollar figure is the truthful
magnitude, not an inflated output-rate number), and rent is priced at the input
rate. The keep/evict decision itself still runs in tokens — this is the dollar
*lens* on it, not a second gate.
