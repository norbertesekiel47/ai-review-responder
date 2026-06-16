# Phase 8 Implementation Plan — F-5/F-20 (code) + F-18/F-19/F-11 (docs)

**Spec:** `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-8-design.md`
**Branch:** `security/audit-remediation-phase-8` off `main@d9fbb63a`

## Task 1 — F-5 publisher moderation-hold gate (TDD, worker)

**Red:**
- `worker/jobs/publisher/__tests__/held-flag-gate.test.ts` (new): mock `sql.begin`
  + `hasOpenFlag`; assert the helper locks the response row (FOR UPDATE) and
  returns the flag state. FAILS (module doesn't exist).
- `ResponsePublisherWorker.test.ts`: add `vi.mock('../held-flag-gate')` default
  `false`; new test — held → `markOutboxCompleted` called, `postReply` NOT called.

**Green:**
- New `worker/jobs/publisher/held-flag-gate.ts` → `isHeldForModerationReview`.
- `ResponsePublisherWorker.ts`: import + gate after subscription guard (line 114),
  before Zernio connection load; `warn` + `markOutboxCompleted` + return on hold.

## Task 2 — F-20 per-admin daily demo cap (TDD, route)

**Red (`route.test.ts`):** per-admin cap exhausted → 429; update the existing
per-IP-exhausted mock chain to the new call order (daily → per-admin → per-IP).

**Green:** insert `checkRateLimit('demo:generate:daily:admin:${gate.admin.id}', 20,
86400)` between the global daily and per-IP caps; 429 on `!allowed`.

## Task 3 — docs (F-18 document, F-19 defer, F-11 record)

`docs/security-audit/2026-06-15-refresh-delta.md`:
- F-18 → ACCEPTED (per-route read model intentional; write gates centralized).
- F-19 → DEFERRED (self-referential oracle; negligible value vs payment-flow risk).
- F-11 → DEFERRED (static-render incompatibility; force-dynamic is the validated
  fix but trades away static prerendering; style-src also un-nonceable).
- F-5 → FIXED (publisher belt-and-suspenders gate); F-20 → FIXED (per-admin cap).

`docs/security/csp-rollout.md`: record the F-11 static-rendering finding +
force-dynamic fix + cost.

## Verification gate

`pnpm lint` + `npx eslint worker/jobs/publisher/held-flag-gate.ts
worker/jobs/publisher/ResponsePublisherWorker.ts` · `pnpm typecheck` · `pnpm test`
· `pnpm ci:fallow` · `pnpm ci:static-policy` · `pnpm ci:tenant-scope` · `pnpm
ci:rls-audit` · `pnpm build`. PR → CI green.

## Review

F-5 → spec-compliance + code-quality review. F-20 → controller verifies diff.

## Out of scope

F-18 centralization, F-19 unification, F-11 nonce code (all deferred/documented).
