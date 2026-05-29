# Launch P1.1 — Public pricing copy bug + logging hygiene

> **Date:** 2026-05-28
> **Status:** Approved design — ready for implementation plan
> **Source:** `docs/launch-ready-part1.md`, "Suggested order" item 1 (line 164)
> **Branch:** `fix/launch-p1-copy-logging-hygiene` (sibling worktree `RepWorth-logging-hygiene`, off `origin/main` @ `09fcc1ed`)
> **Lands via:** PR (main is protected)

## Context

The launch-readiness audit bundles three independent, local-only fixes under one
line item. None touch the database, external APIs, or any safety invariant. They
are grouped only because each is a small hygiene fix shippable today:

1. A dev-speak phrase shipped to every pricing-page visitor.
2. PII (name + email) written to stdout in two public API routes.
3. Four worker schedulers/pollers logging via raw `console.*` instead of the
   structured `createWorkerLogger`.

## Decisions (resolved during brainstorming)

- **Pricing copy:** drop the `, if implemented` qualifier only — final text is
  `Multiple approval notification channels`. Matches the card's existing
  "Coming soon"/disabled framing; no over- or under-promise rework.
- **Route PII:** replace the full-submission dump with a **non-PII breadcrumb**
  (occurrence + IP + `businessName` length + `hasUrl`), preserving operational
  visibility without writing name/email/business-name-value/URL-value.
- **Worker scope:** migrate **only the four named files**. Leave the intentional
  Sentry-fallback `console.warn` and the out-of-scope `reconcile-account.ts`
  untouched. No net-new test suites for the two currently-untested schedulers.

## Change A — Pricing copy (1 line)

`src/app/(public)/pricing/PricingContent.tsx:108`

```diff
- { text: 'Multiple approval notification channels, if implemented' },
+ { text: 'Multiple approval notification channels' },
```

`PricingContent.test.tsx` does not assert this string (verified by grep), so the
existing suite must stay green unchanged.

## Change B — Route PII → non-PII breadcrumb (2 files)

These are Next.js / Vercel routes, **not** workers. `createWorkerLogger` is
deliberately *not* adopted here: it stamps `service: "worker"` (wrong origin) and
its sanitizer does not strip `name`/`email`, so it would not fix the PII anyway.
The fix is to stop logging PII. Plain `console.log` is kept (Vercel captures
stdout); only the payload changes.

`src/app/api/contact/route.ts:47`

```diff
- console.log('[contact]', submission);
+ console.log('[contact] submission received', {
+   ip,
+   businessNameLength: submission.businessName.length,
+   ts: submission.timestamp,
+ });
```

`src/app/api/demo-request/route.ts:72`

```diff
- console.log('[demo-request]', submission);
+ console.log('[demo-request] submission received', {
+   ip,
+   businessNameLength: submission.businessName.length,
+   hasUrl: Boolean(submission.googleMapsUrl),
+   ts: submission.timestamp,
+ });
```

- `ip` is already in scope in both handlers (`contact` L11, `demo-request` L15).
- The existing `console.error('[...] Resend error:', error.message)` lines log a
  Resend API error message (non-PII) and stay untouched.
- The route tests (`contact/__tests__/route.test.ts`,
  `demo-request/__tests__/route.test.ts`) do not assert on the `console.log`
  payload (verified by grep), so they stay green unchanged.

## Change C — 4 worker files → `createWorkerLogger`

**Files:** `worker/background/schedulers/OnboardingDripScheduler.ts`,
`WeeklySummaryScheduler.ts`, `MonthlyImpactScheduler.ts`,
`worker/background/pollers/StripeLocationsReconcilePoller.ts`.

**Canonical pattern** (already used by `CleanupAbandonedSignupsPoller.ts`):

```ts
import { createWorkerLogger } from '../../../src/lib/shared/logger';
const logger = createWorkerLogger(LOG_PREFIX); // brackets stripped internally; no correlation ID
```

**Transformation rules (mechanical, behavior-preserving):**

| Before | After |
|---|---|
| `console.log(\`${LOG_PREFIX} msg\`)` | `logger.log('msg')` |
| `console.error(\`${LOG_PREFIX} msg:\`, err)` | `logger.error('msg', err)` (drop trailing colon — the error serializes into its own fields) |
| `.catch(console.error)` | `.catch((err) => logger.error('<context> failed', err))` |

- Reuse each file's existing `LOG_PREFIX` as the constructor arg; the
  `${LOG_PREFIX}` interpolation is removed from every message string.
- `StripeLocationsReconcilePoller` imports `LOG_PREFIX` from
  `./billing-reconciliation/constants` (shared with untouched sub-modules) — keep
  the import and pass it to `createWorkerLogger`.

**Explicitly NOT touched (deliberate containment, not oversight):**

- `worker/background/pollers/billing-reconciliation/drift-alert.ts` `console.warn`
  — intentional Sentry-unset fallback; documented in the file header and asserted
  by `StripeLocationsReconcilePoller.test.ts` via `mockConsoleWarn`.
- `worker/background/pollers/billing-reconciliation/reconcile-account.ts`
  `console.error` — outside the audit's named four-file scope. Left as a known
  follow-up so the migration boundary is explicit.

## Test work

- **`OnboardingDripScheduler.test.ts` (TDD, RED→GREEN):** the suite currently
  spies on `console.log`/`console.error` and asserts exact `[prefix] message`
  strings. After migration those calls emit a JSON record instead, so the
  assertions must move to a mocked logger. Introduce a hoisted shared mock and
  assert on it with prefix-stripped messages:

  ```ts
  const { mockLogger } = vi.hoisted(() => ({
    mockLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.mock('../../../../src/lib/shared/logger', () => ({
    createWorkerLogger: () => mockLogger,
  }));
  // assertions: expect(mockLogger.log).toHaveBeenCalledWith('Mock mode — skipping') etc.
  ```

  Sequence: update the test to expect logger calls (RED, impl still on
  `console`), then migrate the impl (GREEN). Reset the mock in `beforeEach`.

- **`StripeLocationsReconcilePoller.test.ts`:** already mocks
  `createWorkerLogger` (returns no-op `vi.fn()`s) and checks the drift-alert path
  via `mockConsoleWarn`. No change required — verify it stays green after the
  impl swap.

- **`WeeklySummaryScheduler` / `MonthlyImpactScheduler`:** no test files exist;
  none added (per scope decision). The change is a behavior-preserving logging
  swap, covered by `typecheck` + `lint`.

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` — all green.
- Affected-suite baseline already green (79 tests): `PricingContent`,
  `contact/route`, `demo-request/route`, `OnboardingDripScheduler`,
  `StripeLocationsReconcilePoller`.
- No DB or schema changes → `ci:tenant-scope` / `ci:rls-audit` not applicable.

## Commits & PR

Three logical commits, one PR:

1. `fix(pricing): drop "if implemented" dev-speak from Premium bullet`
2. `fix(api): stop logging PII in contact/demo-request routes (non-PII breadcrumb)`
3. `refactor(worker): migrate 4 schedulers/pollers to createWorkerLogger`

## Non-breakage rationale

- No public interface, route contract, queue payload, or DB shape changes.
- Worker log *content* is preserved (same messages, structured); only the sink
  (`console.*` → `logger.*`, which itself calls `console.*` with a JSON record)
  changes.
- The only test that pins old behavior (`OnboardingDripScheduler.test.ts`) is
  updated in lockstep; every other affected suite is verified untouched-and-green.
- Sibling worktree (not nested under `.claude/worktrees/`) avoids the documented
  `node_modules`/eslintrc leak that poisons local lint/test.
