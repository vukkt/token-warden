---
id: testing-04
agent: testing
prompt: "Write vitest unit tests for src/repositories/userRepo.ts in tests/userRepo.test.ts. Cover insertUser, getUserById including the not-found case, and listUsers. Use an in-memory db via createDb() like the existing tests, and make sure the whole suite passes."
success_check: "test -f tests/userRepo.test.ts && npx vitest run"
---

A single-table sibling of testing-02 (no joins, no cross-table fixtures), added
as a low-variance anchor for the testing suite — see FINDINGS.md.
