---
id: backend-04
agent: backend
prompt: "There is a pricing bug in src/services/orderService.ts: the order total does not account for the ordered quantity. Fix createOrder so total_cents reflects price times quantity, and add a regression test for it in tests/."
success_check: "grep -qE '(price_cents[^;]*[*][^;]*quantity|quantity[^;]*[*][^;]*price_cents)' src/services/orderService.ts && grep -rq 'createOrder' tests/ && npx vitest run"
---

backend-03 with a check that can actually fail.

backend-03's check is `grep -q 'quantity' src/services/orderService.ts && npx
vitest run`. Both halves are satisfied by the pristine fixture: `quantity` is a
PARAMETER NAME of `createOrder` (and appears five more times in the stock and
validation logic), and the shipped test suite passes because the seeded bug has
no test covering it. So backend-03 passes with the agent doing nothing.

That has the same two consequences sql-01 had: it can never detect a
regression, and a quota-dead run on it records `completed = true`, which hides
it from `isEnvironmentFailure` (that discriminator requires `!completed`) — a
blind spot in the environment-failure abort guard.

backend-03 is left byte-identical: its `run1_tokens` is frozen and every
published comparison that includes it stays valid. This task is the corrected
replacement, added rather than edited, matching the remedy used for sql-08 and
for the v0.36.0 noisy-task splits.

The check now verifies the actual defect and the actual deliverable: the
multiplication must exist in either operand order, a test must reference
`createOrder`, and the suite must pass. Verified against the frozen fixture —
pristine exits 1, the fix WITHOUT the requested regression test exits 1, and
the fix WITH it exits 0, where backend-03's exits 0 in all three cases.
