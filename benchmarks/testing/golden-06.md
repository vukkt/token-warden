---
id: testing-06
agent: testing
prompt: "Write vitest unit tests for the multi-row query path of src/repositories/orderRepo.ts in tests/orderQueries.test.ts. Cover listOrdersByUser and listOrdersWithUserNames, seeding users, products, and orders via an in-memory db from createDb() like the existing tests, and make sure the whole suite passes."
success_check: "test -f tests/orderQueries.test.ts && npx vitest run"
---

The other half of testing-02's surface, isolated as a narrower task: the
multi-row list and user-name query path only, for lower per-task variance.
