---
id: backend-03
agent: backend
prompt: "There is a pricing bug in src/services/orderService.ts: the order total does not account for the ordered quantity. Fix createOrder so total_cents reflects price times quantity, and add a regression test for it in tests/."
success_check: "grep -q 'quantity' src/services/orderService.ts && npx vitest run"
---

Verifies the quantity-pricing bug (seeded in BUGS.md) is fixed with a test.
