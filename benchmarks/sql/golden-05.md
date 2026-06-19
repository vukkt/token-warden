---
id: sql-05
agent: sql
prompt: "Queries that sort or filter orders by recency have no supporting index. Add an index on orders(created_at) to db/schema.sql, following the style of the existing index, and keep the whole suite passing."
success_check: "grep -qiE 'index[^;]*created_at' db/schema.sql && npx vitest run"
---

A single-file, schema-only change (non-breaking, distinct from sql-01's
orders.user_id index), added as a low-variance anchor for the sql suite.
