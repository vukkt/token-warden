---
id: sql-02
agent: sql
prompt: "Add an is_active column to the users table in db/schema.sql (INTEGER NOT NULL DEFAULT 1), and update listUsers in src/repositories/userRepo.ts to return only active users."
success_check: "grep -q 'is_active' db/schema.sql && grep -q 'is_active' src/repositories/userRepo.ts && npx vitest run"
---

Verifies a coordinated schema + repository change lands in both layers
without breaking the suite.
