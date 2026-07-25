---
id: sql-08
agent: sql
prompt: "One of the repository queries in this codebase performs a full table scan on what will be the largest table in production. Find it and fix it by adding the appropriate index to db/schema.sql."
success_check: "grep -qiE 'create +index[^;]*on +orders *[(] *user_id' db/schema.sql"
---

sql-01 with a check that can actually fail.

sql-01's check is `grep -qi 'create index' && grep -qi 'user_id'`, and the
pristine fixture already satisfies both: it ships `CREATE INDEX IF NOT EXISTS
idx_products_name ON products(name);` on line 24 and `user_id INTEGER NOT NULL
REFERENCES users(id),` on line 17. So sql-01 passes with the agent doing
nothing. Two consequences: it can never detect a regression, and — worse — a
quota-dead run on it records `completed = true`, which hides it from
`isEnvironmentFailure` (that discriminator requires `!completed`). That is a
blind spot in the environment-failure abort guard on the very agent every burn
in FINDINGS.md used.

sql-01 is left byte-identical: its `run1_tokens` is frozen and every published
comparison that includes it stays valid (invariant: first-run baselines are
frozen forever). This task is the corrected replacement, added rather than
edited — the same remedy v0.36.0 used when splitting the noisy sql-02 and
testing-02 into sql-06/07 and testing-05/06.

The check requires an index whose target is specifically `orders(user_id)`, the
seeded design flaw. Verified against the frozen fixture: it exits 1 before the
fix and 0 after, where sql-01's exits 0 in both cases.
