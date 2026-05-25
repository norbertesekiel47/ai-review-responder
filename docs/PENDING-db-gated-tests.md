# ⚠️ PENDING: DB-gated tests that do NOT run in CI

**Status:** open reminder — safe to delete once CI has a test database (see "Permanent fix").
**Created:** 2026-05-25 (during Wave 1 review).

## The problem in one sentence

Several integration tests need a **real Postgres database** to run. CI is
deliberately secret-free and has **no database**, so these tests **skip
themselves** — they show up green without ever actually running. A skipped
test protects nothing: code could break the behavior it guards and CI would
stay green.

## How to recognize one

They are gated on the `TEST_DATABASE_POOL_URL` environment variable, usually:

```ts
const RUN = !!process.env.TEST_DATABASE_POOL_URL;
const d = RUN ? describe : describe.skip;   // whole suite skips with no DB
```

In a normal `pnpm test` / CI run you'll see them counted as **`skipped`**, not
`passed`.

## The tests currently affected

| Test file | What it protects (don't let this rot) |
|---|---|
| `src/lib/approval/__tests__/audit-snapshot.integration.test.ts` | The approval snapshot (`response_text_at_approval`) stays **immutable** after `responses.approved_text` is later changed. This is the dispute-evidence guarantee. |
| `src/__tests__/tenant-isolation.test.ts` | No cross-tenant data leakage between two seeded accounts on real read/write paths. |
| `src/lib/demos/__tests__/lifecycle.test.ts` | Onboarding demo lifecycle state transitions. |
| `src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts` | WhatsApp channel enrollment end-to-end. |
| `worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts` | Edit-existing-reply publish path. |
| `worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts` | Zernio ingest end-to-end. |

> Re-scan command to refresh this list:
> `grep -rln "TEST_DATABASE_POOL_URL" --include="*.test.ts" --include="*.test.tsx" src/ worker/ scripts/`

## What to do until CI has a database

1. **Run them by hand against a test/staging DB** before anything risky merges
   (especially changes to approval/audit, multi-tenant scoping, or Zernio ingest):

   ```bash
   TEST_DATABASE_POOL_URL="postgres://...test-db..." \
     pnpm vitest run \
       src/lib/approval/__tests__/audit-snapshot.integration.test.ts \
       src/__tests__/tenant-isolation.test.ts
   ```

   Confirm they print **`passed`**, not `skipped`. Note it in the PR description.

2. **Don't trust a green CI run alone** for the behaviors in the table above —
   CI does not exercise them.

## Permanent fix (then delete this file)

Add a Postgres service to `.github/workflows/ci.yml` and set
`TEST_DATABASE_POOL_URL` in the CI env. This is already the next CI keystone in
`docs/sass_ready/README.md` ("DB-backed integration + Playwright/e2e in CI —
need `TEST_DATABASE_POOL_URL`"). Once that lands, every test above runs
automatically on every PR and this reminder is obsolete.

Related: `docs/security/tenant-isolation.md` documents the staging-gated
expectation for the cross-tenant test specifically.
