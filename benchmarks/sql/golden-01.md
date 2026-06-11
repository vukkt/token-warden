---
id: sql-01
agent: sql
prompt: "One of the repository queries in this codebase performs a full table scan on what will be the largest table in production. Find it and fix it by adding the appropriate index to db/schema.sql."
success_check: "grep -qi 'create index' db/schema.sql && grep -qi 'user_id' db/schema.sql"
---

Verifies the missing orders.user_id index (the seeded design flaw) was found
and added.
