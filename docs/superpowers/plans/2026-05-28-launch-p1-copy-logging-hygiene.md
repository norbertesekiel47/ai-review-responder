# Launch P1.1 — Pricing Copy + Logging Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a dev-speak phrase on the public pricing page, stop logging PII in two public API routes, and migrate four worker schedulers/pollers from raw `console.*` to the structured `createWorkerLogger`.

**Architecture:** Three independent local-only changes, no DB/schema/external-API impact, no safety-invariant impact. Worker log *content* is preserved; only the sink changes (`console.*` → `logger.*`, which itself emits one JSON line per call). The only test pinning old behavior is updated in lockstep.

**Tech Stack:** Next.js 16 (routes), Railway worker (TS), Vitest, `createWorkerLogger` (`src/lib/shared/logger.ts`), pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-launch-p1-copy-logging-hygiene-design.md`

**Working dir:** sibling worktree `/Users/norbertesekiel/Developer/startups/RepWorth-logging-hygiene` on branch `fix/launch-p1-copy-logging-hygiene` (off `origin/main` @ `09fcc1ed`).

---

## File structure

| File | Change |
|---|---|
| `src/app/(public)/pricing/PricingContent.tsx` | Modify line 108 (copy) |
| `src/app/api/contact/route.ts` | Modify line 47 (log payload) |
| `src/app/api/demo-request/route.ts` | Modify line 72 (log payload) |
| `worker/background/schedulers/OnboardingDripScheduler.ts` | Migrate to `createWorkerLogger` |
| `worker/background/schedulers/WeeklySummaryScheduler.ts` | Migrate to `createWorkerLogger` |
| `worker/background/schedulers/MonthlyImpactScheduler.ts` | Migrate to `createWorkerLogger` |
| `worker/background/pollers/StripeLocationsReconcilePoller.ts` | Migrate to `createWorkerLogger` |
| `worker/background/schedulers/__tests__/OnboardingDripScheduler.test.ts` | Re-point console-spy assertions to a mocked logger |
| `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts` | Stable logger mock + re-point 2 disabled-path assertions |

**Explicitly NOT modified (deliberate containment):** `billing-reconciliation/drift-alert.ts` (intentional tested Sentry-fallback `console.warn`) and `billing-reconciliation/reconcile-account.ts` (`console.error`, outside the audit's named 4-file scope).

**Commits:** 3 logical commits — (1) pricing, (2) route PII, (3) worker logging.

---

## Task 1: Pricing copy fix

**Files:**
- Modify: `src/app/(public)/pricing/PricingContent.tsx:108`
- Verify (no change): `src/app/(public)/pricing/__tests__/PricingContent.test.tsx`

No new test: the copy carries no behavior, and the existing suite plus a grep are sufficient. (YAGNI — a string-equality test on marketing copy is brittle and adds no protection the grep doesn't.)

- [ ] **Step 1: Make the edit**

In `src/app/(public)/pricing/PricingContent.tsx`, change the Premium feature bullet:

```diff
-      { text: 'Multiple approval notification channels, if implemented' },
+      { text: 'Multiple approval notification channels' },
```

- [ ] **Step 2: Verify the phrase is gone**

Run: `grep -rn "if implemented" src/`
Expected: no matches (exit code 1, empty output).

- [ ] **Step 3: Run the pricing test suite (must stay green)**

Run: `pnpm exec vitest run "src/app/(public)/pricing/__tests__/PricingContent.test.tsx"`
Expected: PASS, all tests.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(public)/pricing/PricingContent.tsx"
git commit -m "fix(pricing): drop \"if implemented\" dev-speak from Premium bullet"
```

---

## Task 2: Route PII → non-PII breadcrumb

**Files:**
- Modify: `src/app/api/contact/route.ts:47`
- Modify: `src/app/api/demo-request/route.ts:72`
- Verify (no change): `src/app/api/contact/__tests__/route.test.ts`, `src/app/api/demo-request/__tests__/route.test.ts`

`createWorkerLogger` is intentionally NOT used here — these are Vercel routes (it would stamp `service: "worker"`) and its sanitizer does not strip `name`/`email` anyway. The fix is to stop logging PII; plain `console.log` stays.

- [ ] **Step 1: Edit `contact/route.ts`**

Replace line 47:

```diff
-  console.log('[contact]', submission);
+  console.log('[contact] submission received', {
+    ip,
+    businessNameLength: submission.businessName.length,
+    ts: submission.timestamp,
+  });
```

(`ip` is already defined at line 11; `submission` at lines 40-45. The existing `console.error('[contact] Resend error:', error.message)` at line 70 is non-PII and stays.)

- [ ] **Step 2: Edit `demo-request/route.ts`**

Replace line 72:

```diff
-  console.log('[demo-request]', submission);
+  console.log('[demo-request] submission received', {
+    ip,
+    businessNameLength: submission.businessName.length,
+    hasUrl: Boolean(submission.googleMapsUrl),
+    ts: submission.timestamp,
+  });
```

(`ip` is defined at line 15; `submission` at lines 64-70. The existing `console.error('[demo-request] Resend error:', error.message)` at line 96 stays.)

- [ ] **Step 3: Verify no PII fields remain in either log call**

Run: `grep -n "console.log('\[contact\]'\|console.log('\[demo-request\]'" src/app/api/contact/route.ts src/app/api/demo-request/route.ts`
Expected: no matches (the old `console.log('[contact]', submission)` form is gone).

Run: `grep -nA4 "submission received" src/app/api/contact/route.ts src/app/api/demo-request/route.ts`
Expected: the new objects contain only `ip`, `businessNameLength`, (`hasUrl`,) `ts` — no `name`, `email`, `businessName` value, or `googleMapsUrl` value.

- [ ] **Step 4: Run both route test suites (must stay green)**

Run: `pnpm exec vitest run "src/app/api/contact/__tests__/route.test.ts" "src/app/api/demo-request/__tests__/route.test.ts"`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/contact/route.ts src/app/api/demo-request/route.ts
git commit -m "fix(api): stop logging PII in contact/demo-request routes (non-PII breadcrumb)"
```

---

## Task 3: Worker logging migration (TDD: tests first → RED → migrate → GREEN)

**Files:**
- Modify: `worker/background/schedulers/__tests__/OnboardingDripScheduler.test.ts`
- Modify: `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`
- Modify: `worker/background/schedulers/OnboardingDripScheduler.ts`
- Modify: `worker/background/schedulers/WeeklySummaryScheduler.ts`
- Modify: `worker/background/schedulers/MonthlyImpactScheduler.ts`
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts`

The canonical pattern (from `CleanupAbandonedSignupsPoller.ts`): `const logger = createWorkerLogger(LOG_PREFIX)` at module scope (brackets stripped internally), no correlation ID; each message drops its `${LOG_PREFIX}` prefix and trailing colon.

### Step group A — update tests to expect the logger (RED)

- [ ] **Step 1: Add a stable mocked logger to `OnboardingDripScheduler.test.ts`**

Insert this block immediately after the existing `vi.mock('../../../../src/lib/shared/mock-mode', ...)` block (after line 25):

```ts
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));
```

(`vi.clearAllMocks()` already runs in `beforeEach`, so `mockLogger`'s call history resets between tests. The module is re-imported per test via `vi.resetModules()` + `await import(...)`; the mock factory returns the same stable `mockLogger` each time.)

- [ ] **Step 2: Re-point the assertions in `OnboardingDripScheduler.test.ts`**

Apply these exact replacements (delete the `consoleSpy`/`consoleErrorSpy` declarations and their `.mockRestore()` calls in each affected test; replace the assertions):

Test `skips in mock mode`:
```ts
// remove: const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
// remove: consoleSpy.mockRestore();
// replace the assertion with:
expect(mockLogger.log).toHaveBeenCalledWith('Mock mode — skipping');
```

Test `queues day_1 ...`:
```ts
// remove the consoleSpy declaration + mockRestore; replace the assertion with:
expect(mockLogger.log).toHaveBeenCalledWith(
  expect.stringContaining('Queued 1 onboarding_drip outbox entries'),
);
```

Test `queues both day_1 and day_7 ...`:
```ts
// remove the consoleSpy declaration + mockRestore; replace the assertion with:
expect(mockLogger.log).toHaveBeenCalledWith(
  expect.stringContaining('Queued 2 onboarding_drip outbox entries'),
);
```

Test `handles 23505 unique constraint gracefully`:
```ts
// remove: const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
// remove: consoleErrorSpy.mockRestore();
// replace the two filter blocks with:
const fatalErrors = mockLogger.error.mock.calls.filter(
  (c) => typeof c[0] === 'string' && c[0].includes('Scheduler cycle failed'),
);
expect(fatalErrors).toHaveLength(0);

const bizErrors = mockLogger.error.mock.calls.filter(
  (c) => typeof c[0] === 'string' && c[0].includes('Failed to queue'),
);
expect(bizErrors).toHaveLength(0);
```

Lifecycle test `uses default 3_600_000ms interval ...`:
```ts
// remove the consoleSpy declaration + mockRestore; replace the assertion with:
expect(mockLogger.log).toHaveBeenCalledWith(
  expect.stringContaining('interval=3600000ms'),
);
```

Lifecycle test `uses custom interval from env`:
```ts
// remove the consoleSpy declaration + mockRestore; replace the assertion with:
expect(mockLogger.log).toHaveBeenCalledWith(
  expect.stringContaining('interval=120000ms'),
);
```

Lifecycle test `stopOnboardingDripScheduler clears the interval`:
```ts
// remove the consoleSpy declaration + mockRestore; replace the assertion with:
expect(mockLogger.log).toHaveBeenCalledWith('Stopped');
```

Lifecycle test `double-start is prevented`:
```ts
// remove the consoleSpy declaration + mockRestore; replace the filter block with:
const startLogs = mockLogger.log.mock.calls.filter(
  (c) => typeof c[0] === 'string' && c[0].includes('Starting'),
);
expect(startLogs).toHaveLength(1);
```

- [ ] **Step 3: Add a stable mocked logger to `StripeLocationsReconcilePoller.test.ts`**

The test currently has (around lines 47-53):
```ts
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
```

Replace it with a stable hoisted mock:
```ts
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));
```

(`vi.clearAllMocks()` already runs in this suite's `beforeEach` at line 364, resetting `mockLogger`.)

- [ ] **Step 4: Re-point the two disabled-path assertions in `StripeLocationsReconcilePoller.test.ts`**

Test `does not start when MOCK_EXTERNAL_APIS=true` (line ~1232):
```diff
-    expect(logSpy).toHaveBeenCalledWith(
+    expect(mockLogger.log).toHaveBeenCalledWith(
       expect.stringContaining('MOCK_EXTERNAL_APIS=true'),
     );
```

Test `does not start when STRIPE_LOCATIONS_RECONCILE_DISABLED=true` (line ~1244):
```diff
-    expect(logSpy).toHaveBeenCalledWith(
+    expect(mockLogger.log).toHaveBeenCalledWith(
       expect.stringContaining('STRIPE_LOCATIONS_RECONCILE_DISABLED=true'),
     );
```

Leave `logSpy`/`errorSpy`/`warnSpy` declarations and `.mockRestore()` calls in place — `logSpy` still silences stray output; `warnSpy` (drift-alert) and `errorSpy` (reconcile-account) assertions are unchanged because those modules are not migrated.

- [ ] **Step 5: Run both test suites to verify they FAIL (RED)**

Run: `pnpm exec vitest run worker/background/schedulers/__tests__/OnboardingDripScheduler.test.ts worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`
Expected: FAIL. OnboardingDrip assertions fail because the impl still calls `console.*` (so `mockLogger.*` was never called); the two Stripe disabled-path assertions fail for the same reason. All other Stripe assertions still pass.

### Step group B — migrate the implementations (GREEN)

- [ ] **Step 6: Migrate `OnboardingDripScheduler.ts`**

Add the import (after line 4) and the module-scope logger (after the `LOG_PREFIX` const at line 6):
```ts
import { createWorkerLogger } from '../../../src/lib/shared/logger';
// ...
const logger = createWorkerLogger(LOG_PREFIX);
```

Replace each `console.*` call:
```diff
-      console.log(`${LOG_PREFIX} Mock mode — skipping`);
+      logger.log('Mock mode — skipping');
```
```diff
-        console.error(`${LOG_PREFIX} Failed to queue ${row.drip_type} for business ${row.business_id}:`, err);
+        logger.error(`Failed to queue ${row.drip_type} for business ${row.business_id}`, err);
```
```diff
-      console.log(`${LOG_PREFIX} Queued ${queued} onboarding_drip outbox entries`);
+      logger.log(`Queued ${queued} onboarding_drip outbox entries`);
```
```diff
-    console.error(`${LOG_PREFIX} Scheduler cycle failed:`, error);
+    logger.error('Scheduler cycle failed', error);
```
```diff
-  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
-  checkAndSchedule().catch(console.error);
+  logger.log(`Starting (interval=${intervalMs}ms)`);
+  checkAndSchedule().catch((err) => logger.error('Initial run failed', err));
   pollerInterval = setInterval(() => {
-    checkAndSchedule().catch(console.error);
+    checkAndSchedule().catch((err) => logger.error('Scheduled run failed', err));
   }, intervalMs);
```
```diff
-    console.log(`${LOG_PREFIX} Stopped`);
+    logger.log('Stopped');
```

- [ ] **Step 7: Migrate `WeeklySummaryScheduler.ts`**

Add the import (after line 3) and `const logger = createWorkerLogger(LOG_PREFIX);` (after line 7). Replace:
```diff
-        console.error(`${LOG_PREFIX} Failed to queue summary for business ${biz.id}:`, err);
+        logger.error(`Failed to queue summary for business ${biz.id}`, err);
```
```diff
-      console.log(`${LOG_PREFIX} Queued ${queued} weekly_summary outbox entries for week ${weekStartDate}`);
+      logger.log(`Queued ${queued} weekly_summary outbox entries for week ${weekStartDate}`);
```
```diff
-    console.error(`${LOG_PREFIX} Scheduler cycle failed:`, error);
+    logger.error('Scheduler cycle failed', error);
```
```diff
-  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms, timezone=${WEEKLY_SUMMARY_TIMEZONE})`);
-  checkAndSchedule().catch(console.error);
+  logger.log(`Starting (interval=${intervalMs}ms, timezone=${WEEKLY_SUMMARY_TIMEZONE})`);
+  checkAndSchedule().catch((err) => logger.error('Initial run failed', err));
   pollerInterval = setInterval(() => {
-    checkAndSchedule().catch(console.error);
+    checkAndSchedule().catch((err) => logger.error('Scheduled run failed', err));
   }, intervalMs);
```
```diff
-    console.log(`${LOG_PREFIX} Stopped`);
+    logger.log('Stopped');
```

- [ ] **Step 8: Migrate `MonthlyImpactScheduler.ts`**

Add the import (after line 3) and `const logger = createWorkerLogger(LOG_PREFIX);` (after line 7). Replace:
```diff
-        console.error(`${LOG_PREFIX} Failed to queue monthly impact for business ${biz.id}:`, err);
+        logger.error(`Failed to queue monthly impact for business ${biz.id}`, err);
```
```diff
-      console.log(`${LOG_PREFIX} Queued ${queued} send_monthly_impact outbox entries for month ${monthStartDate}`);
+      logger.log(`Queued ${queued} send_monthly_impact outbox entries for month ${monthStartDate}`);
```
```diff
-    console.error(`${LOG_PREFIX} Scheduler cycle failed:`, error);
+    logger.error('Scheduler cycle failed', error);
```
```diff
-  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms, timezone=${MONTHLY_IMPACT_TIMEZONE})`);
-  checkAndSchedule().catch(console.error);
+  logger.log(`Starting (interval=${intervalMs}ms, timezone=${MONTHLY_IMPACT_TIMEZONE})`);
+  checkAndSchedule().catch((err) => logger.error('Initial run failed', err));
   pollerInterval = setInterval(() => {
-    checkAndSchedule().catch(console.error);
+    checkAndSchedule().catch((err) => logger.error('Scheduled run failed', err));
   }, intervalMs);
```
```diff
-    console.log(`${LOG_PREFIX} Stopped`);
+    logger.log('Stopped');
```

- [ ] **Step 9: Migrate `StripeLocationsReconcilePoller.ts`**

Add the import after the existing imports (after line 31) and `const logger = createWorkerLogger(LOG_PREFIX);` after `DEFAULT_INTERVAL_MS` (after line 33). `LOG_PREFIX` is imported from `./billing-reconciliation/constants` — keep that import; reuse it as the logger arg. Replace each poller-owned `console.*` (do NOT touch `drift-alert.ts` or `reconcile-account.ts`):
```diff
-    console.log(`${LOG_PREFIX} Previous run still in progress — skipping this tick`);
+    logger.log('Previous run still in progress — skipping this tick');
```
```diff
-      console.log(`${LOG_PREFIX} No paid accounts to reconcile`);
+      logger.log('No paid accounts to reconcile');
```
```diff
-        console.error(
-          `${LOG_PREFIX} Error reconciling account ${account.id}: ${message}`,
-        );
+        logger.error(`Error reconciling account ${account.id}: ${message}`);
```
```diff
-      console.log(
-        `${LOG_PREFIX} Run complete: accountsChecked=${accountsChecked} driftsFound=${driftsFound} errors=${errors}`,
-      );
+      logger.log(
+        `Run complete: accountsChecked=${accountsChecked} driftsFound=${driftsFound} errors=${errors}`,
+      );
```
```diff
-      console.log(
-        `${LOG_PREFIX} Run complete: ${accountsChecked} accounts checked, no drift detected`,
-      );
+      logger.log(
+        `Run complete: ${accountsChecked} accounts checked, no drift detected`,
+      );
```
```diff
-    console.log(
-      `${LOG_PREFIX} STRIPE_LOCATIONS_RECONCILE_DISABLED=true — not starting`,
-    );
+    logger.log('STRIPE_LOCATIONS_RECONCILE_DISABLED=true — not starting');
```
```diff
-    console.log(
-      `${LOG_PREFIX} MOCK_EXTERNAL_APIS=true — not starting`,
-    );
+    logger.log('MOCK_EXTERNAL_APIS=true — not starting');
```
```diff
-    console.log(
-      `${LOG_PREFIX} Already started — ignoring duplicate startStripeLocationsReconcilePoller() call`,
-    );
+    logger.log('Already started — ignoring duplicate startStripeLocationsReconcilePoller() call');
```
```diff
-  console.log(`${LOG_PREFIX} Starting (interval=${interval}ms)`);
-  runOnce().catch((err) =>
-    console.error(`${LOG_PREFIX} Initial run failed:`, err),
-  );
+  logger.log(`Starting (interval=${interval}ms)`);
+  runOnce().catch((err) => logger.error('Initial run failed', err));
   timer = setInterval(() => {
-    runOnce().catch((err) =>
-      console.error(`${LOG_PREFIX} Scheduled run failed:`, err),
-    );
+    runOnce().catch((err) => logger.error('Scheduled run failed', err));
   }, interval);
```
```diff
-    console.log(`${LOG_PREFIX} Stopped`);
+    logger.log('Stopped');
```

- [ ] **Step 10: Run both test suites to verify they PASS (GREEN)**

Run: `pnpm exec vitest run worker/background/schedulers/__tests__/OnboardingDripScheduler.test.ts worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`
Expected: PASS, all tests in both files.

- [ ] **Step 11: Lint + typecheck (catch unused `console` / import issues)**

Run: `pnpm lint && pnpm typecheck`
Expected: both PASS. (No new ESLint warnings; the pre-existing `<img>` warning in `SecurityClient.tsx` is unrelated and may remain.)

- [ ] **Step 12: Commit**

```bash
git add worker/background/schedulers/OnboardingDripScheduler.ts \
        worker/background/schedulers/WeeklySummaryScheduler.ts \
        worker/background/schedulers/MonthlyImpactScheduler.ts \
        worker/background/pollers/StripeLocationsReconcilePoller.ts \
        worker/background/schedulers/__tests__/OnboardingDripScheduler.test.ts \
        worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
git commit -m "refactor(worker): migrate 4 schedulers/pollers to createWorkerLogger"
```

---

## Task 4: Full verification + branch finish

**Files:** none (verification + integration).

- [ ] **Step 1: Full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. (No DB/schema changes → `ci:tenant-scope` / `ci:rls-audit` not applicable.)

- [ ] **Step 2: Include the planning docs in the branch**

```bash
git add docs/superpowers/specs/2026-05-28-launch-p1-copy-logging-hygiene-design.md \
        docs/superpowers/plans/2026-05-28-launch-p1-copy-logging-hygiene.md
git commit -m "docs: spec + plan for launch P1.1 (pricing copy + logging hygiene)"
```

(If the spec was already committed earlier, this commits only the plan / spec update.)

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin fix/launch-p1-copy-logging-hygiene
gh pr create --base main --title "fix: launch P1.1 — pricing copy + logging hygiene" \
  --body "Implements item 1 of docs/launch-ready-part1.md 'Suggested order'.

- fix(pricing): drop \"if implemented\" dev-speak from Premium bullet
- fix(api): stop logging PII (name/email) in contact + demo-request routes
- refactor(worker): migrate OnboardingDrip / WeeklySummary / MonthlyImpact schedulers and StripeLocationsReconcile poller to createWorkerLogger

No DB/schema/external-API changes. Spec + plan under docs/superpowers/."
```

Expected: 4 CI checks (`lint`, `typecheck`, `test`, `build`) run on the PR. Wait for green.

---

## Self-review notes (resolved during planning)

- **Spec coverage:** Change A → Task 1; Change B → Task 2; Change C (+ both test updates) → Task 3. Verification + PR → Task 4. All spec sections mapped.
- **Stripe test correction:** unlike the spec's first draft, the Stripe test *does* assert the poller's two disabled-path logs via `logSpy` (lines ~1232 & ~1244); Task 3 Steps 3-4 update them. `warnSpy`/`errorSpy` target untouched modules and are left as-is.
- **Type/name consistency:** logger handle is `logger` in every impl file; mock handle is `mockLogger` in both test files; message strings drop `${LOG_PREFIX}` and trailing colons consistently.
- **No placeholders:** every code step shows exact before/after.
