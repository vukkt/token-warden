---
id: sql-06
agent: sql
prompt: "Add a discontinued column to the products table in db/schema.sql (INTEGER NOT NULL DEFAULT 0). This is a schema-only change; do not modify any repository code."
success_check: "grep -q 'discontinued' db/schema.sql && npx vitest run"
---

The schema-layer half of sql-02's coordinated change, isolated as a narrower,
lower-variance task: a single non-breaking column added to products (distinct
column and table from sql-02's users.is_active).
