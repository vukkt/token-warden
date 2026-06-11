---
id: backend-02
agent: backend
prompt: "Add input validation to the POST /orders route in src/routes/orders.ts using zod (already a dependency). Invalid bodies must get a 400 JSON error naming the offending field; valid bodies must behave exactly as before."
success_check: "grep -q 'zod' src/routes/orders.ts && grep -q '400' src/routes/orders.ts && npx vitest run"
---

Verifies zod validation guards the order-creation route.
