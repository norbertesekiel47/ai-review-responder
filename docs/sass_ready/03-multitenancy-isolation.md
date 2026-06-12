# Spec 03 — Multi-tenancy & Data Isolation

> **Goal:** Make the existing app-layer scoping (inline `WHERE account_id = …`) **provably** correct: a CI guard that catches ungated tenant queries, an accurate two-path isolation model (service-role writes vs. RLS-protected anon reads), and a brutal cross-tenant integration test that gates merges. No repository-layer rewrite.
>
> **✅ Wave 1 SHIPPED (2026-05-25, branch `codex/wave-1-foundation-launch-risk` → PR #85):** RLS audit (`scripts/ci/rls-audit.ts`), tenant-scope static audit + vetted allowlist running in the blocking `lint` job, and the guarded cross-tenant integration test (`src/__tests__/tenant-isolation.test.ts`) all landed; `onboarding_demos` brought under RLS (migration 045). Docs: `docs/security/{rls-inventory,tenant-isolation}.md`. **Resolved since:** the CI `test` job now runs a Postgres 16 service with all migrations applied and sets `TEST_DATABASE_POOL_URL`, so the DB-gated suites run on every PR (the `docs/PENDING-db-gated-tests.md` reminder has been deleted).

---

## 1. Why this matters

The single highest-blast-radius bug in B2B SaaS is cross-tenant data leak. One breach destroys trust permanently. The architecture invariant exists (`accounts` = billing parent, `businesses` = per-location) but the **automated proof** that the invariant holds is what auditors, enterprises, and SOC 2 reviewers will demand.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- **No repository layer.** There is no `src/lib/repositories/*`. Tenant scoping is **inline** — each query site adds `WHERE account_id = ${accountId}` (e.g. `src/lib/admin/cost-report-service.ts`), with lookup helpers in `src/lib/db/account-guard.ts`. This is the pattern to harden, not replace (§3).
- **Two enforcement paths — only one is RLS-covered:**
  - **Transactional writes** use the Postgres.js client with the **service role** (`src/lib/db/server.ts`) → **bypasses RLS**. The app-layer `WHERE account_id` clause is the *only* guard here.
  - **Anon / `supabase-js` reads** go through RLS policies using the `owner_account_id()` predicate tied to Supabase `auth.uid()`, added in migrations **035** (`rls_policies`), **040** (`rls_tightening`), **041** (`rls_missing_revokes`).
  - ⚠️ The spec's original "RLS via `current_setting('app.account_id')`" model is **not** implemented and would not protect the service-role write path. Corrected in §3.
- Browser never receives `SUPABASE_SERVICE_KEY` — enforced by the `server.ts` / `browser.ts` split + Edge middleware (verified).
- **No** cross-tenant isolation test, **no** RLS audit CI script, **no** custom ESLint rules (config is just `next/core-web-vitals`), **no** `acct:` cache-key convention (keys are `businessId`-based, e.g. `cost:daily:${businessId}`).
- `worker/config/startup-assert.ts` exists (env assertions only, no RLS audit); `src/instrumentation.ts` exists (Sentry init + scrubber).
- Tests are collocated in `src/**/__tests__/*.test.ts` (Vitest) and `e2e/*.spec.ts` (Playwright) — there is **no** `tests/integration/` directory.

## 3. Target state

### Layer 1 — App-layer scoping + a CI guard (no repository rewrite)
- Keep the inline `WHERE account_id = ${accountId}` pattern; do **not** build `src/lib/repositories/*` (decision: match reality, smallest blast radius).
- Add a **CI guard** (`scripts/ci/tenant-scope-audit.ts`) that scans `sql\`…\`` template literals touching tenant-scoped tables and fails when a `SELECT/UPDATE/DELETE` lacks an `account_id` (or `business_id` join) predicate. Maintain an explicit allowlist for legitimately global queries, each with a justification comment.
- Resolve accountId the same way everywhere via `src/lib/db/account-guard.ts`.

### Layer 2 — Database RLS (defense-in-depth for the anon/`supabase-js` path)
- RLS is already enabled on tenant-scoped tables via migrations 035/040/041, using `owner_account_id()` keyed on Supabase `auth.uid()` — **not** `current_setting('app.account_id')`. Keep this model.
- The Postgres.js **service-role** write path bypasses RLS by design; its guarantee is the Layer-1 `WHERE` clause + the CI guard. RLS is the safety net for any read flowing through the anon/`supabase-js` client.
- Task: produce an RLS inventory and a CI audit that fails if any tenant-scoped table has `relrowsecurity = false` (`scripts/ci/rls-audit.ts`).

### Layer 3 — Synthetic + observability
- Hourly synthetic probe: dedicated `probe-account` queries its own data, asserts row count and that `account_id` matches the probe.
- Sentry alert: any DB result returned via an authenticated session where `row.account_id !== session.account_id` triggers a P0 page.

### Layer 4 — Resource isolation beyond rows
- **Cache keys:** current keys are **location-scoped** (`cost:daily:${businessId}`, `gen:*`), not `acct:`-prefixed. ⚠️ Decide before enforcing: (a) accept `businessId` as the isolation unit (a business belongs to exactly one account → transitively scoped) and document it, or (b) add an `acct:{account_id}:` prefix and migrate keys. A lint rule only makes sense after (b); don't assert a convention that doesn't exist.
- **Storage paths:** Supabase Storage paths `accounts/{account_id}/...`; bucket policy enforces.
- **BullMQ:** job IDs include `{account_id}_{business_id}_{uuid}`.
- **Logs:** AsyncLocalStorage-bound `account_id` on every log line.

### Layer 5 — The tenant-isolation test
- `src/__tests__/tenant-isolation.test.ts` (Vitest, gated by `TEST_DATABASE_POOL_URL` like the existing integration tests):
  - Create accounts A and B (seeded businesses, reviews, responses, billing rows).
  - For every list/get/update/delete operation reachable from an authenticated session, perform as A, assert no row of B's data.
  - Run on every PR; failure blocks merge.
  - Re-run nightly on staging seeded with realistic data volumes.

## 4. Implementation tasks

1. Inventory tenant-scoped tables (`SELECT relname, relrowsecurity FROM pg_class …`) → `docs/security/rls-inventory.md`. Add `scripts/ci/rls-audit.ts` that fails CI if any tenant-scoped table has `relrowsecurity = false`.
2. Add `scripts/ci/tenant-scope-audit.ts`: scan tenant-touching `sql\`…\`` literals across `src/` **and** `worker/`; fail on a missing `account_id`/`business_id` predicate. Maintain an allowlist for global queries. (No repository-layer migration — decision per §3.)
3. ~~`SET LOCAL app.account_id` connection middleware~~ — **removed.** RLS uses `owner_account_id()` on `auth.uid()`, and the write path is service-role (RLS-bypassing); a session GUC would add risk without protecting writes. Scope stays in the `WHERE` clause + the CI guard.
4. Write `src/__tests__/tenant-isolation.test.ts` (Vitest, gated by `TEST_DATABASE_POOL_URL`). Seed 2 accounts × (3 businesses, 50 reviews, 20 responses, 1 audit row, 1 invoice). Exercise every authenticated route under `src/app/api/*` and the inline-scoped query helpers as account A; assert zero rows of B. Run every PR; nightly on staging volumes.
5. Add `scripts/synthetic/tenant-probe.ts` — hourly via Railway cron; fixed probe-account asserts row count and `account_id` match.
6. Add Sentry alert: any authenticated response payload containing an `account_id` ≠ session account → P0.
7. **Cache-key decision first** (Layer 4). If adopting `acct:` prefixing, add the convention + a lint rule; otherwise document `businessId` as the transitively-scoped unit. No lint rule against a non-existent convention.
8. Document the contract in `docs/security/tenant-isolation.md` (the two-path model, test plan, alert table); reference it from `CLAUDE.md`.

## 5. Acceptance criteria

- [ ] `src/__tests__/tenant-isolation.test.ts` runs on every PR and passes with ≥ 50 distinct cross-tenant assertions.
- [ ] `scripts/ci/rls-audit.ts` exits non-zero if any tenant-scoped table has `relrowsecurity = false`.
- [ ] `scripts/ci/tenant-scope-audit.ts` fails on an ungated tenant query; its allowlist is reviewed in the PR.
- [ ] Synthetic probe alert configured and tested by intentionally breaking it once.
- [ ] `docs/security/tenant-isolation.md` exists and is referenced from `CLAUDE.md`.
- [ ] Pen-test report includes "no cross-tenant leakage found" finding ([Spec 09](./09-security-compliance.md)).

## 6. Metrics & alerts

| Alert | Severity | Trigger |
|---|---|---|
| Synthetic probe mismatch | P0 | row.account_id != probe-account id |
| RLS audit CI failure | P1 (blocks merge) | any tenant-scoped table without RLS |
| Cross-tenant assertion failure | P0 | tenant-isolation.spec.ts red on main |

## 7. Risks & mitigations

- **Risk:** A new query forgets the `WHERE account_id` clause (the service-role write path has no RLS net). **Mitigation:** `tenant-scope-audit.ts` + the cross-tenant test are the backstop; both block merge.
- **Risk:** Service-role client used in a browser-reachable path. **Mitigation:** browser never gets `SUPABASE_SERVICE_KEY` (verified, enforced by `server.ts`/`browser.ts` split + Edge middleware); `src/instrumentation.ts` already exists as the Next.js boot hook for an added assertion.
- **Risk:** Test suite grows expensive. **Mitigation:** parallelize via Vitest workers; use a transactional fixture that rolls back per test.

## 8. Dependencies & cross-links

- [Spec 09 — Security & Compliance](./09-security-compliance.md) (pen test, SOC 2)
- [Spec 23 — Testing & QA](./23-testing-qa.md) (CI gates, integration fixtures)
- Code anchors: `supabase/migrations/035_rls_policies.sql`, `supabase/migrations/040_rls_tightening.sql`, `supabase/migrations/041_rls_missing_revokes.sql`, `worker/config/startup-assert.ts`
- Invariant: "Auth scope is app-enforced" in `CLAUDE.md`
- Code anchors (current state): `src/lib/db/server.ts` (service-role Postgres.js), `src/lib/db/account-guard.ts`, `src/lib/admin/cost-report-service.ts` (inline-scope example)

## 9. Implementation in the current repo

- **The guard is the high-leverage piece.** Because writes go through the RLS-bypassing service role, the only thing standing between a forgotten `WHERE` and a cross-tenant leak is `WHERE account_id` discipline. `scripts/ci/tenant-scope-audit.ts` (AST-walk of `sql\`…\`` tagged templates) makes that discipline enforceable. Wire it into the same CI job as `pnpm lint`.
- **The isolation test** reuses the existing integration harness: it needs `TEST_DATABASE_POOL_URL` (the same env the edit-replies integration tests already use) and the Vitest config at `vitest.config.ts`. Seed via a transactional fixture that rolls back per test.
- **RLS audit** is a thin script over `pg_class.relrowsecurity` run against the pooled URL; it complements (does not replace) the guard, since RLS doesn't cover the service-role path.
- **Synthetic probe** runs as a Railway cron alongside the existing `worker/background/` loops; emit to Sentry.
- **Logging context:** there's no AsyncLocalStorage account binding today (`src/lib/shared/logger.ts` carries only a correlation ID). If row-level alerting needs the session account on every log line, that binding is net-new — scope it as its own task, not assumed.

---
_Verified 2026-05-23 against migration head 042. Corrected the isolation model (service-role writes bypass RLS; RLS uses `owner_account_id()`/`auth.uid()`, not `app.account_id`); dropped the non-existent repository layer and the GUC middleware; fixed test path and cache-key claims to match reality._
