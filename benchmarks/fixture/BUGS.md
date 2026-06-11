# Seeded flaws (never shown to agents)

The benchmark runner excludes this file when copying the fixture. These flaws
are golden-task material; do not fix them in the committed fixture.

1. **`src/lib/pagination.ts` — off-by-one offset.** `offset = page * pageSize`
   with a 1-based `page` skips the first `pageSize` items; page 1 returns the
   second page. Correct is `(page - 1) * pageSize`. Untested on purpose.

2. **`src/services/orderService.ts` — total ignores quantity.**
   `createOrder` computes `totalCents = product.priceCents`, dropping the
   `quantity` multiplier. An order of 3 items is charged for 1.
   (Target of backend/golden-03.)

3. **`web/hooks/useFetch.ts` — stale error on refetch.** The hook never
   resets `error` to null when a refetch starts, so a recovered request still
   renders the old error alongside fresh data.

4. **`db/schema.sql` — missing index (deliberate design flaw).** `orders` has
   no index on `user_id`, so `orderRepo.listByUser` full-scans the largest
   table. (Target of sql/golden-01.) Related: `orderRepo.listWithUserNames`
   runs one user query per order — a classic N+1 (target of sql/golden-03).
