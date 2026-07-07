---
id: testing-05
agent: testing
prompt: "Write vitest unit tests for the insert and single-row read path of src/repositories/orderRepo.ts in tests/orderInsert.test.ts. Cover insertOrder and getOrderById including the missing (undefined) case. Use an in-memory db via createDb() like the existing tests, seeding a user and product first, and make sure the whole suite passes."
success_check: "test -f tests/orderInsert.test.ts && npx vitest run"
---

One half of testing-02's surface, isolated as a narrower task: the order
insert and single-row read path only (no list or join fixtures), for lower
per-task variance.
