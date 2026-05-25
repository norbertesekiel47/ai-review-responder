# Tenant Isolation

RepWorth uses two tenant-isolation layers:

1. Service-role Postgres.js writes must scope tenant tables by `account_id` or by a `business_id` that belongs to the active account.
2. Authenticated Supabase reads must rely on RLS policies, and RLS must stay enabled on tenant-scoped tables.

## Service-Role SQL

The service role bypasses RLS, so SQL templates against tenant tables need an explicit tenant predicate. Preferred predicates are:

- `account_id = ${accountId}` for account-level data.
- `business_id = ${businessId}` for location-level data.
- A validated location lookup where the `business_id` was already proven to belong to the active `account_id`.

`pnpm ci:tenant-scope` runs a heuristic scanner over Postgres.js `sql` templates in `src` and `worker`. It catches obvious unscoped `SELECT`, `UPDATE`, and `DELETE` templates against tenant tables. It also accepts narrow row-identity lookups used by existing trusted flows, such as account root lookups by `accounts.id`, location row lookups by `businesses.id`, response lookups by `review_id`, and provider callback lookups by external delivery IDs.

Allowlist entries live in `scripts/ci/tenant-scope-allowlist.ts`. Every entry must name the exact file, table, and a non-empty reason. Do not add broad entries; prefer tightening the scanner when a finding is a repeatable false positive.

## RLS

RLS must remain enabled on tenant-scoped tables listed in `docs/security/rls-inventory.md`. `pnpm ci:rls-audit` checks the database catalog when `TEST_DATABASE_POOL_URL` or `DATABASE_POOL_URL` is set. It skips successfully when neither URL is available, so it is safe for local and CI environments without a database.

Do not add `pnpm ci:rls-audit` as a hard CI step until the CI environment has a real tenant-test database URL.

## Cross-Tenant Tests

Cross-tenant integration tests should seed two accounts and assert that account A cannot read or mutate account B data. The guarded shell in `src/__tests__/tenant-isolation.test.ts` is skipped unless `TEST_DATABASE_POOL_URL` is present; expand it with two-account read/write assertions when the test database is available.

## Gates

- `pnpm ci:tenant-scope` - required CI gate for obvious unscoped service-role SQL.
- `pnpm ci:rls-audit` - database-backed RLS inventory audit, skipped without a DB URL.
- `src/__tests__/tenant-isolation.test.ts` - guarded integration home for two-account isolation proofs.
