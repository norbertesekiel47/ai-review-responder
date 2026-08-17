# Tenant Isolation

RepWorth uses two tenant-isolation layers:

1. Service-role Postgres.js writes must scope tenant tables by `account_id` or by a `business_id` that belongs to the active account.
2. Authenticated Supabase reads must rely on RLS policies, and RLS must stay enabled on tenant-scoped tables.

## Service-Role SQL

The service role bypasses RLS, so SQL templates against tenant tables need an explicit tenant predicate. Preferred predicates are:

- `account_id = ${accountId}` for account-level data.
- `business_id = ${businessId}` for location-level data.
- A validated location lookup where the `business_id` was already proven to belong to the active `account_id`.

`pnpm ci:tenant-scope` runs a query-block-aware static audit over Postgres.js `sql` templates in `src` and `worker`, including local aliases and static `unsafe` query variables. It audits every physical tenant-table binding independently across CTEs, scalar subqueries, `EXISTS`/`NOT EXISTS`, LATERAL blocks, data-modifying CTEs, and every set-operation arm. A child block may inherit tenant proof only through an explicit account/business identity equality to an already-proven ancestor binding; aliases, sibling predicates, row-id correlations, strings, and comments cannot lend scope. It also fails closed for `OR`/`NOT`, unqualified correlated tenant columns, and non-tenant ownership bridges. It catches unscoped `SELECT`, `UPDATE`, and `DELETE` bindings, accepts account root lookups by `accounts.id`, location row lookups by `businesses.id`, and supports explicit exact-match allowlist entries for trusted flows that static analysis intentionally cannot prove.

A scope predicate counts only on a column the table PHYSICALLY carries (`TENANT_SCOPE_COLUMNS` in `scripts/ci/tenant-tables.ts`, asserted against `information_schema` by `scripts/ci/__tests__/tenant-tables.integration.test.ts`). Inside a subquery PostgreSQL resolves an unqualified column the local table lacks to the OUTER row — `EXISTS (SELECT 1 FROM reviews WHERE account_id = $1)` compiles and restricts nothing — so `reviews`/`responses` (business_id only) and `account_audit_log`/`auto_approval_policies` (account_id only) are never proven by the column they do not have. Aliases resolve to the NEAREST enclosing block: an alias re-bound in an intermediate block hides the same-named ancestor from every descendant.

Each missing-scope finding prints a stable `sqlIdentity`: normalized-template fingerprint and same-fingerprint occurrence ordinal, followed by statement, set arm, query-block path, table, alias, and binding ordinal. Use that identity to triage the exact occurrence rather than guessing from file/table alone. `pnpm exec tsx scripts/ci/tenant-scope-audit.ts --no-allowlist` runs the same occurrence analysis without applying exceptions; it intentionally exits non-zero and is an audit/triage mode, not a CI pass condition.

Allowlist entries live in `scripts/ci/tenant-scope-allowlist.ts`. Every entry must name the exact file, table, SQL snippet, and a human-readable reason that explains why that statement is safe. Do not add broad entries; prefer tightening the scanner when a finding is a repeatable false positive.

## RLS

RLS must remain enabled on tenant-scoped tables listed in `docs/security/rls-inventory.md`. `pnpm ci:rls-audit` checks the database catalog when `TEST_DATABASE_POOL_URL` or `DATABASE_POOL_URL` is set. It skips successfully when neither URL is available, so it is safe for local and CI environments without a database.

Do not add `pnpm ci:rls-audit` as a hard CI step until the CI environment has a real tenant-test database URL.

## Cross-Tenant Tests

`src/__tests__/tenant-isolation.test.ts` is skipped unless `TEST_DATABASE_POOL_URL` is present. When the URL is present it is a hard integration proof: it seeds two accounts with multiple locations, reviews, responses, approval links, approval audit rows, account audit rows, and channel enrollments. It then asserts account-A-scoped reads only return account A evidence, account-A-scoped updates can mutate its own location, and account-A-scoped updates cannot mutate account B businesses, responses, or channel enrollments.

## Gates

- `pnpm ci:tenant-scope` - required CI gate for obvious unscoped service-role SQL.
- `pnpm ci:rls-audit` - database-backed RLS inventory audit, skipped without a DB URL.
- `src/__tests__/tenant-isolation.test.ts` - guarded integration home for two-account isolation proofs.
