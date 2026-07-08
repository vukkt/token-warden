---
id: sql-07
agent: sql
prompt: "Update listProducts in src/repositories/productRepo.ts to return only in-stock products (stock greater than 0), preserving the existing ordering by name. This is a repository-only change; do not modify db/schema.sql."
success_check: "grep -qiE 'where[^;]*stock' src/repositories/productRepo.ts && npx vitest run"
---

The repository-layer half of sql-02's coordinated change, isolated as a
narrower, lower-variance task: a single list query gains a filter (distinct
function and column from sql-02's listUsers/is_active) with no schema edit.
