---
id: sql-03
agent: sql
prompt: "listOrdersWithUserNames in src/repositories/orderRepo.ts issues one extra query per order to look up the user name — a classic N+1. Rewrite it as a single SQL query using a JOIN, preserving the returned shape (all order columns plus user_name)."
success_check: "grep -qi 'join' src/repositories/orderRepo.ts && npx vitest run"
---

Verifies the N+1 pattern was collapsed into one JOIN query.
