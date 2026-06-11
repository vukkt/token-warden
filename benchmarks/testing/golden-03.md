---
id: testing-03
agent: testing
prompt: "Write contract tests for the database schema in tests/schema.test.ts: assert that the users, products, and orders tables exist with their expected columns, that users.email is unique, and that orders enforces its foreign keys to users and products. Use createDb() from src/db.ts and make sure the whole suite passes."
success_check: "test -f tests/schema.test.ts && npx vitest run"
---

Verifies the schema's contract is pinned by tests.
