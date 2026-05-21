# Spec 03 — Multi-tenancy & Data Isolation

> **Goal:** Scope every query by `account_id` (and `business_id` where per-location) at the repository layer, RLS on every tenant-scoped table, and a brutal cross-tenant integration test that gates merges.

---

## 1. Why this matters

The single highest-blast-radius bug in B2B SaaS is cross-tenant data leak. One breach destroys trust permanently. The architecture invariant exists (`accounts` = billing parent, `businesses` = per-location) but the **automated proof** that the invariant holds is what auditors, enterprises, and SOC 2 reviewers will demand.

## 2. Current state (RepWorth)

- Architecture invariants in `CLAUDE.md` document scoping rules.
- Migrations 035 (`rls_policies`), 040 (`rls_tightening`), 041 (`rls_missing_revokes`) added RLS in layers.
- No visible `tests/integration/tenant-isolation.spec.ts`.
- No CI guard that fails when a tenant-scoped table has RLS disabled.
- BullMQ job IDs already include `account_id` (per outbox pattern).

## 3. Target state

### Layer 1 — Repository scoping
- Every repo function under `src/lib/repositories/*` takes `accountId: string` as required first arg.
- Query builders inject `WHERE account_id = $accountId` (or join through to `accounts`).
- TypeScript guard: lint rule (custom ESLint or `eslint-plugin-boundaries`) flags any direct `sql\`SELECT ... FROM tenant_table\`` not routed through a repo.

### Layer 2 — Database RLS
- RLS enabled on every tenant-scoped table (already in place per migration 040/041).
- Policies: `USING (account_id = current_setting('app.account_id')::uuid)` — set per-request from Supabase Auth.
- Service-role bypass remains for worker code paths (correct — they enforce in app layer).
- Anon and authenticated roles must rely on RLS.

### Layer 3 — Synthetic + observability
- Hourly synthetic probe: dedicated `probe-account` queries its own data, asserts row count and that `account_id` matches the probe.
- Sentry alert: any DB result returned via an authenticated session where `row.account_id !== session.account_id` triggers a P0 page.

### Layer 4 — Resource isolation beyond rows
- **Cache keys:** every Redis key prefixed `acct:{account_id}:`. Lint rule flags non-prefixed cache writes.
- **Storage paths:** Supabase Storage paths `accounts/{account_id}/...`; bucket policy enforces.
- **BullMQ:** job IDs include `{account_id}_{business_id}_{uuid}`.
- **Logs:** AsyncLocalStorage-bound `account_id` on every log line.

### Layer 5 — The tenant-isolation test
- `tests/integration/tenant-isolation.spec.ts`:
  - Create accounts A and B (seeded businesses, reviews, responses, billing rows).
  - For every list/get/update/delete operation reachable from an authenticated session, perform as A, assert no row of B's data.
  - Run on every PR; failure blocks merge.
  - Re-run nightly on staging seeded with realistic data volumes.

## 4. Implementation tasks

1. Inventory tenant-scoped tables. Query: `SELECT relname, relrowsecurity FROM pg_class WHERE relkind='r' AND relname NOT IN ('schema_migrations', ...)`. Output → `docs/security/rls-inventory.md`. Fail CI if any tenant-scoped table has RLS off (script in `scripts/ci/rls-audit.ts`).
2. Audit all `sql\`...\`` template literals in `src/`. Move any direct tenant-scoped SELECT into `src/lib/repositories/*`. Add ESLint rule banning the pattern outside repo files.
3. Add Postgres connection middleware that sets `SET LOCAL app.account_id = $1` per request from Supabase Auth session.
4. Write `tests/integration/tenant-isolation.spec.ts`. Seed: 2 accounts × (3 businesses, 50 reviews, 20 responses, 1 audit log, 1 invoice). Operations to cover: every route under `src/app/api/*` and every repo function. Use Vitest.
5. Add `scripts/synthetic/tenant-probe.ts` — runs hourly via Railway cron, hits a fixed probe-account, asserts row count and `account_id` match.
6. Add Sentry alert: if any response payload contains an `account_id` not matching the authenticated session, page P0.
7. Add ESLint custom rule `repworth/cache-key-prefix` that flags Redis writes without `acct:` prefix.
8. Document the contract in `docs/security/tenant-isolation.md` (architecture overview, test plan, alert table).

## 5. Acceptance criteria

- [ ] `tests/integration/tenant-isolation.spec.ts` runs on every PR and currently passes with ≥ 50 distinct cross-tenant assertions.
- [ ] `scripts/ci/rls-audit.ts` exits non-zero if any tenant-scoped table has `relrowsecurity = false`.
- [ ] ESLint blocks unprefixed cache writes and ungated SQL in non-repo files.
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

- **Risk:** RLS adds latency. **Mitigation:** benchmark before/after; `app.account_id` is a cheap GUC, target <5% overhead.
- **Risk:** Service-role bypass becomes a foot-gun if accidentally used in a route. **Mitigation:** browser client never gets `SUPABASE_SERVICE_KEY` (invariant); add startup assertion in `worker/config/startup-assert.ts` mirror for Next.js (`src/instrumentation.ts`).
- **Risk:** Test suite grows expensive. **Mitigation:** parallelize via Vitest workers; use a transactional fixture that rolls back per test.

## 8. Dependencies & cross-links

- [Spec 09 — Security & Compliance](./09-security-compliance.md) (pen test, SOC 2)
- [Spec 23 — Testing & QA](./23-testing-qa.md) (CI gates, integration fixtures)
- Code anchors: `supabase/migrations/035_rls_policies.sql`, `supabase/migrations/040_rls_tightening.sql`, `supabase/migrations/041_rls_missing_revokes.sql`, `worker/config/startup-assert.ts`
- Invariant: "Auth scope is app-enforced" in `CLAUDE.md`
