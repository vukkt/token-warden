# shopette

A small storefront: Express API over SQLite with a React admin UI.

- `db/schema.sql` — database schema (users, products, orders)
- `src/` — API: routes → services → repositories, wired in `server.ts`
- `web/` — React admin UI: components, hooks, context, API client
- `tests/` — vitest suite (run with `npm test`)

The API serves `/users`, `/products`, and `/orders`. Services hold business
logic and validation; repositories hold all SQL.
