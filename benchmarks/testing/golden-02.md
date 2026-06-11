---
id: testing-02
agent: testing
prompt: "Write vitest unit tests for src/repositories/orderRepo.ts in tests/orderRepo.test.ts. Cover insertOrder, getOrderById including the missing case, listOrdersByUser, and listOrdersWithUserNames. Use an in-memory db via createDb() like the existing tests, and make sure the whole suite passes."
success_check: "test -f tests/orderRepo.test.ts && npx vitest run"
---

Verifies the order repository gains passing coverage.
