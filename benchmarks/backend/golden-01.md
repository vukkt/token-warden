---
id: backend-01
agent: backend
prompt: "Add a GET /orders/:id route to src/routes/orders.ts that returns the order as JSON, or a 404 JSON error when the order does not exist. Follow the error-handling pattern used by the other routes."
success_check: "grep -q ':id' src/routes/orders.ts && npx vitest run"
---

Verifies a get-by-id endpoint exists and the suite still passes.
