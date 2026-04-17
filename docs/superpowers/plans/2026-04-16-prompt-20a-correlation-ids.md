# Prompt 20a: Correlation IDs + Structured Logging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add end-to-end correlation IDs so any review, demo, or customer-facing async chain can be traced through `job_outbox` with a single SQL query, and replace raw `console.log` with a structured logger in all BullMQ workers.

**Architecture:** Correlation IDs are stored inside the outbox `payload` JSONB field — no new database columns. A `BasePayload` interface adds `correlation_id?: string` to all 12 payload types. Entry points (pollers, schedulers, API routes, webhooks) generate the ID; workers propagate it when creating downstream outbox entries. A lightweight `createWorkerLogger` replaces `console.log` in all 12 BullMQ handler files, prepending `[WorkerName] [corr-id]` to every log line.

**Tech Stack:** TypeScript, uuid (v7), Vitest. No new dependencies.

**Spec:** Prompt 20a in `docs/Final_Implementation_Plan.md:2251-2293`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/lib/shared/logger.ts` | `createWorkerLogger(prefix, correlationId?)` → `{ log, warn, error }` |
| `src/lib/shared/__tests__/logger.test.ts` | Logger formatting tests |

### Modified Files
| File | Change |
|------|--------|
| `src/lib/shared/worker-types.ts` | Add `BasePayload`, extend 11 payload interfaces |
| `src/lib/demos/types.ts` | Extend `DemoJobPayload` with `BasePayload` |
| `src/lib/reviews/process-review.ts` | Accept + propagate `correlationId` parameter |
| `src/lib/approval/service.ts` | Accept + propagate `correlationId` parameter in all 6 methods |
| `worker/jobs/ReconciliationPoller.ts` | Generate correlation_id in payload |
| `worker/jobs/WeeklySummaryScheduler.ts` | Generate correlation_id in payload |
| `worker/jobs/MonthlyImpactScheduler.ts` | Generate correlation_id in payload |
| `worker/jobs/EngagementMonitorPoller.ts` | Generate correlation_id in payload |
| `worker/jobs/RankingTrackingScheduler.ts` | Generate correlation_id in payload |
| `worker/jobs/OnboardingDripScheduler.ts` | Generate correlation_id in payload |
| `worker/jobs/NotificationFailoverPoller.ts` | Generate correlation_id in payload (2 sites) |
| `worker/jobs/PlaceIdValidationWorker.ts` | Propagate job.data.correlation_id into sync_reviews |
| `worker/jobs/ReviewSyncWorker.ts` | Pass job.data.correlation_id to processReview; use createWorkerLogger |
| `worker/jobs/ResponseGeneratorWorker.ts` | Propagate into send_notification; use createWorkerLogger |
| `worker/jobs/NotificationWorker.ts` | Use createWorkerLogger |
| `worker/jobs/ResponsePublisherWorker.ts` | Use createWorkerLogger |
| `worker/jobs/WeeklySummaryWorker.ts` | Use createWorkerLogger |
| `worker/jobs/MonthlyImpactWorker.ts` | Use createWorkerLogger |
| `worker/jobs/EngagementAlertWorker.ts` | Use createWorkerLogger |
| `worker/jobs/AdminExceptionWorker.ts` | Use createWorkerLogger |
| `worker/jobs/DemoGenerationWorker.ts` | Use createWorkerLogger |
| `worker/jobs/OnboardingDripWorker.ts` | Use createWorkerLogger |
| `worker/jobs/RankingTrackingWorker.ts` | Use createWorkerLogger |
| `src/app/api/admin/businesses/route.ts` | Generate correlation_id for onboarding outbox entries |
| `src/app/api/admin/demos/generate/route.ts` | Generate correlation_id for demo outbox entry |
| `src/app/api/feedback/route.ts` | Generate deterministic correlation_id for satisfaction alert |
| `src/app/api/approve/[token]/approve/route.ts` | Pass response_id as correlationId |
| `src/app/api/approve/[token]/edit/route.ts` | Pass response_id as correlationId |
| `src/app/api/approve/[token]/regenerate/route.ts` | Pass response_id as correlationId |
| `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts` | Pass response_id as correlationId |
| `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts` | Pass response_id as correlationId |
| `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts` | Pass response_id as correlationId |

---

## Task 1: Create the Structured Logger

**Files:**
- Create: `src/lib/shared/logger.ts`
- Create: `src/lib/shared/__tests__/logger.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/lib/shared/__tests__/logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkerLogger } from '../logger';

describe('createWorkerLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prepends prefix and correlation ID to log()', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', 'corr-abc-123');
    logger.log('processing review');
    expect(spy).toHaveBeenCalledWith('[TestWorker] [corr-abc-123]', 'processing review');
  });

  it('prepends prefix only when no correlation ID', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]');
    logger.log('processing review');
    expect(spy).toHaveBeenCalledWith('[TestWorker]', 'processing review');
  });

  it('prepends prefix and correlation ID to warn()', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', 'corr-xyz');
    logger.warn('something suspicious');
    expect(spy).toHaveBeenCalledWith('[TestWorker] [corr-xyz]', 'something suspicious');
  });

  it('prepends prefix and correlation ID to error()', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', 'corr-xyz');
    logger.error('something broke');
    expect(spy).toHaveBeenCalledWith('[TestWorker] [corr-xyz]', 'something broke');
  });

  it('treats undefined correlation ID same as omitted', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', undefined);
    logger.log('test');
    expect(spy).toHaveBeenCalledWith('[TestWorker]', 'test');
  });

  it('passes through multiple arguments', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', 'corr-1');
    logger.log('review', 'abc-123', { count: 5 });
    expect(spy).toHaveBeenCalledWith('[TestWorker] [corr-1]', 'review', 'abc-123', { count: 5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/shared/__tests__/logger.test.ts`
Expected: FAIL — `Cannot find module '../logger'`

- [ ] **Step 3: Write the logger implementation**

```typescript
// src/lib/shared/logger.ts

export interface WorkerLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Creates a structured logger for BullMQ workers with optional correlation ID.
 *
 * Output: [WorkerName] [corr-id] message args...
 *    or:  [WorkerName] message args...          (when no correlation ID)
 *
 * Usage:
 *   const logger = createWorkerLogger('[ReviewSyncWorker]', job.data.correlation_id);
 *   logger.log('processing review', reviewId);
 */
export function createWorkerLogger(
  prefix: string,
  correlationId?: string,
): WorkerLogger {
  const tag = correlationId ? `${prefix} [${correlationId}]` : prefix;

  return {
    log: (...args: unknown[]) => console.log(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/shared/__tests__/logger.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/logger.ts src/lib/shared/__tests__/logger.test.ts
git commit -m "feat(20a): add createWorkerLogger with correlation ID support"
```

---

## Task 2: Add BasePayload to Payload Types

**Files:**
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `src/lib/demos/types.ts`

- [ ] **Step 1: Add BasePayload and extend all interfaces in worker-types.ts**

At the top of `src/lib/shared/worker-types.ts`, after the doc comment (line 6), add:

```typescript
/**
 * Base interface for all outbox job payloads.
 * correlation_id is optional for backward compat with existing outbox rows.
 */
export interface BasePayload {
  correlation_id?: string;
}
```

Then change every `export interface XPayload {` to `export interface XPayload extends BasePayload {` for these 11 interfaces:

| Interface | Current line |
|-----------|-------------|
| `SyncReviewsPayload` | 8 |
| `GenerateResponsePayload` | 13 |
| `SendNotificationPayload` | 19 |
| `PublishResponsePayload` | 28 |
| `NotifyAdminExceptionPayload` | 33 |
| `WeeklySummaryPayload` | 38 |
| `ValidatePlaceIdPayload` | 44 |
| `SendMonthlyImpactPayload` | 49 |
| `EngagementAlertPayload` | 62 |
| `TrackRankingPayload` | 81 |
| `OnboardingDripPayload` | 88 |

Do NOT change `EngagementAlertType` (line 55) — that's a union type, not a payload interface.

- [ ] **Step 2: Extend DemoJobPayload in demos/types.ts**

In `src/lib/demos/types.ts`, add the import and extend:

```typescript
// Line 1: add import
import type { BasePayload } from '@/lib/shared/worker-types';

// Line 6: change to extend
export interface DemoJobPayload extends BasePayload {
```

- [ ] **Step 3: Run tests + type check**

Run: `pnpm test && pnpm tsc --noEmit`
Expected: All 570 tests pass, no type errors. This is purely additive (optional field).

- [ ] **Step 4: Commit**

```bash
git add src/lib/shared/worker-types.ts src/lib/demos/types.ts
git commit -m "feat(20a): add BasePayload with correlation_id to all 12 payload types"
```

---

## Task 3: Generate Correlation IDs at Entry Points (Pollers + Schedulers)

**Files:**
- Modify: `worker/jobs/ReconciliationPoller.ts`
- Modify: `worker/jobs/WeeklySummaryScheduler.ts`
- Modify: `worker/jobs/MonthlyImpactScheduler.ts`
- Modify: `worker/jobs/EngagementMonitorPoller.ts`
- Modify: `worker/jobs/RankingTrackingScheduler.ts`
- Modify: `worker/jobs/OnboardingDripScheduler.ts`
- Modify: `worker/jobs/NotificationFailoverPoller.ts`

Each file already imports `v7 as uuidv7` from `uuid`. The change is adding `correlation_id: uuidv7()` to each payload object right before it's stringified.

- [ ] **Step 1: Update ReconciliationPoller.ts**

Find the payload construction (around line 45):
```typescript
      const payload: SyncReviewsPayload = {
        business_id: biz.id,
        google_place_id: biz.google_place_id,
      };
```

Change to:
```typescript
      const payload: SyncReviewsPayload = {
        business_id: biz.id,
        google_place_id: biz.google_place_id,
        correlation_id: uuidv7(),
      };
```

- [ ] **Step 2: Update WeeklySummaryScheduler.ts**

Find the payload construction and add `correlation_id: uuidv7()`.

- [ ] **Step 3: Update MonthlyImpactScheduler.ts**

Find the payload construction and add `correlation_id: uuidv7()`.

- [ ] **Step 4: Update EngagementMonitorPoller.ts**

Find the payload construction and add `correlation_id: uuidv7()`. This file builds the EngagementAlertPayload object — add the field there.

- [ ] **Step 5: Update RankingTrackingScheduler.ts**

Find the payload construction and add `correlation_id: uuidv7()`.

- [ ] **Step 6: Update OnboardingDripScheduler.ts**

Find the payload construction and add `correlation_id: uuidv7()`.

- [ ] **Step 7: Update NotificationFailoverPoller.ts**

This file has TWO outbox entry insertion points (around lines 102 and 159). Add `correlation_id: uuidv7()` to both payload objects.

- [ ] **Step 8: Run tests**

Run: `pnpm test`
Expected: All 570 tests pass. The `correlation_id` field is optional on all payload types.

- [ ] **Step 9: Commit**

```bash
git add worker/jobs/ReconciliationPoller.ts worker/jobs/WeeklySummaryScheduler.ts worker/jobs/MonthlyImpactScheduler.ts worker/jobs/EngagementMonitorPoller.ts worker/jobs/RankingTrackingScheduler.ts worker/jobs/OnboardingDripScheduler.ts worker/jobs/NotificationFailoverPoller.ts
git commit -m "feat(20a): generate correlation IDs in all 7 pollers/schedulers"
```

---

## Task 4: Generate Correlation IDs at API Route Entry Points

**Files:**
- Modify: `src/app/api/admin/businesses/route.ts`
- Modify: `src/app/api/admin/demos/generate/route.ts`
- Modify: `src/app/api/feedback/route.ts`

- [ ] **Step 1: Update onboarding route (admin/businesses POST)**

In `src/app/api/admin/businesses/route.ts`, the POST handler creates either a `sync_reviews` or `validate_place_id` outbox entry. The file already imports `v7 as uuidv7`. Generate one correlation ID per request and add it to whichever payload is constructed.

Find the sync payload construction (around line 233):
```typescript
    const syncPayload: SyncReviewsPayload = {
      business_id: businessId,
      google_place_id: placeId!,
    };
```

Before the `if (placeIdVerified)` block, add:
```typescript
    const correlationId = uuidv7();
```

Then add `correlation_id: correlationId` to both the `syncPayload` and the `validatePayload` objects.

- [ ] **Step 2: Update demo generation route**

In `src/app/api/admin/demos/generate/route.ts`, find the payload construction (around line 95-103):
```typescript
  const payload: DemoJobPayload = {
    demoId,
    googlePlaceId: placeId,
    businessName,
    category,
    googleMapsUrl,
  };
```

Add `correlation_id: uuidv7()` to the payload. The file already imports `v7 as uuidv7`.

- [ ] **Step 3: Update feedback route**

In `src/app/api/feedback/route.ts`, find the satisfaction alert payload (around line 183):
```typescript
        const payload: EngagementAlertPayload = {
          business_id: businessId,
          alert_type: 'partner_satisfaction_alert',
          satisfaction: {
            rating: 'not_great',
            comment,
            week_start_date: week,
          },
        };
```

Add a deterministic correlation ID:
```typescript
        const payload: EngagementAlertPayload = {
          business_id: businessId,
          alert_type: 'partner_satisfaction_alert',
          correlation_id: `feedback:${businessId}:${week}`,
          satisfaction: {
            rating: 'not_great',
            comment,
            week_start_date: week,
          },
        };
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/businesses/route.ts src/app/api/admin/demos/generate/route.ts src/app/api/feedback/route.ts
git commit -m "feat(20a): generate correlation IDs at API route entry points"
```

---

## Task 5: Propagate Correlation IDs Through Cross-Outbox Chains

**Files:**
- Modify: `src/lib/reviews/process-review.ts`
- Modify: `worker/jobs/ReviewSyncWorker.ts`
- Modify: `worker/jobs/ResponseGeneratorWorker.ts`
- Modify: `worker/jobs/PlaceIdValidationWorker.ts`

- [ ] **Step 1: Add correlationId parameter to processReview**

In `src/lib/reviews/process-review.ts`, change the function signature (line 18):

From:
```typescript
export async function processReview(
  monitored: MonitoredReview,
  businessId: string,
): Promise<ProcessResult> {
```

To:
```typescript
export async function processReview(
  monitored: MonitoredReview,
  businessId: string,
  correlationId?: string,
): Promise<ProcessResult> {
```

Then add `correlation_id: correlationId` to ALL 5 outbox payload objects in this file:

1. Line 55 — new review `GenerateResponsePayload`:
```typescript
      const outboxPayload: GenerateResponsePayload = {
        review_id: reviewId,
        business_id: businessId,
        version: 1,
        correlation_id: correlationId,
      };
```

2. Line 107 — content changed, no active response:
```typescript
      const outboxPayload: GenerateResponsePayload = {
        review_id: existing.id,
        business_id: businessId,
        version: 1,
        correlation_id: correlationId,
      };
```

3. Line 133 — content changed, pending approval:
```typescript
      const outboxPayload: GenerateResponsePayload = {
        review_id: existing.id,
        business_id: businessId,
        version: nextVersion,
        correlation_id: correlationId,
      };
```

4. Line 173 — review edited after post (admin exception):
```typescript
        const notifyPayload: NotifyAdminExceptionPayload = {
          review_exception_id: exceptionId,
          business_id: businessId,
          correlation_id: correlationId,
        };
```

5. Line 198 — other statuses, supersede and regenerate:
```typescript
    const outboxPayload: GenerateResponsePayload = {
      review_id: existing.id,
      business_id: businessId,
      version: nextVersion,
      correlation_id: correlationId,
    };
```

- [ ] **Step 2: Update ReviewSyncWorker to pass correlation_id**

In `worker/jobs/ReviewSyncWorker.ts`, find where `processReview` is called (search for `processReview(`). Pass the correlation_id from the job data:

```typescript
    const result = await processReview(monitored, business_id, job.data.correlation_id);
```

- [ ] **Step 3: Update ResponseGeneratorWorker to propagate correlation_id**

In `worker/jobs/ResponseGeneratorWorker.ts`, find the `send_notification` payload construction (around line 309):

```typescript
    const notifyPayload: SendNotificationPayload = {
      response_id: responseId,
      business_id: businessId,
    };
```

Change to:
```typescript
    const notifyPayload: SendNotificationPayload = {
      response_id: responseId,
      business_id: businessId,
      correlation_id: job.data.correlation_id,
    };
```

The variable `job` is accessible — the handler function receives `job: Job<GenerateResponsePayload>`. The `correlation_id` is on `job.data` because `GenerateResponsePayload extends BasePayload`. However, the actual outbox entry construction is inside `persistResponseAndNotify()` — a helper function. Check whether that function receives the job object or just extracted fields. If it receives extracted fields, add `correlationId?: string` as an additional parameter and thread it through.

- [ ] **Step 4: Update PlaceIdValidationWorker to propagate correlation_id**

In `worker/jobs/PlaceIdValidationWorker.ts`, find the `enqueueSyncReviews` helper (line 95):

```typescript
async function enqueueSyncReviews(
  tx: TxClient,
  businessId: string,
  placeId: string,
): Promise<void> {
  const syncPayload: SyncReviewsPayload = {
    business_id: businessId,
    google_place_id: placeId,
  };
```

Add `correlationId` parameter and propagate:

```typescript
async function enqueueSyncReviews(
  tx: TxClient,
  businessId: string,
  placeId: string,
  correlationId?: string,
): Promise<void> {
  const syncPayload: SyncReviewsPayload = {
    business_id: businessId,
    google_place_id: placeId,
    correlation_id: correlationId,
  };
```

Then update the caller of `enqueueSyncReviews` (in the main handler) to pass `job.data.correlation_id`.

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: All tests pass. Some tests mock `processReview` — they'll receive the extra optional parameter without breaking.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reviews/process-review.ts worker/jobs/ReviewSyncWorker.ts worker/jobs/ResponseGeneratorWorker.ts worker/jobs/PlaceIdValidationWorker.ts
git commit -m "feat(20a): propagate correlation IDs through cross-outbox chains"
```

---

## Task 6: Propagate Correlation IDs Through Approval Service

**Files:**
- Modify: `src/lib/approval/service.ts`
- Modify: `src/app/api/approve/[token]/approve/route.ts`
- Modify: `src/app/api/approve/[token]/edit/route.ts`
- Modify: `src/app/api/approve/[token]/regenerate/route.ts`
- Modify: `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts`
- Modify: `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts`
- Modify: `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts`

- [ ] **Step 1: Add correlationId parameter to all 6 approval service methods**

In `src/lib/approval/service.ts`, add an optional `correlationId?: string` parameter to these 6 functions. Add it as the LAST parameter in each:

**Token-based methods:**

`approve` (line 169) — add after `audit`:
```typescript
export async function approve(
  tx: TxClient,
  link: ApprovalLink,
  deviceCookieHash: string,
  audit: AuditContext,
  correlationId?: string,
): Promise<void> {
```

Then add `correlation_id: correlationId` to the `PublishResponsePayload` at line 187:
```typescript
  const payload: PublishResponsePayload = {
    response_id: link.response_id,
    business_id: link.business_id,
    correlation_id: correlationId,
  };
```

Apply the same pattern to `edit` (line 204) and `regenerate` (line 247).

For `regenerate`, the payload is `GenerateResponsePayload`:
```typescript
  const payload: GenerateResponsePayload = {
    review_id: resp.review_id,
    business_id: link.business_id,
    version: resp.version + 1,
    correlation_id: correlationId,
  };
```

**Session-based methods:**

`approveBySession` (line 323) — add after `audit`:
```typescript
export async function approveBySession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  audit: SessionAuditContext,
  correlationId?: string,
): Promise<void> {
```

Add `correlation_id: correlationId` to the `PublishResponsePayload` at line 338.

Apply the same pattern to `editBySession` (line 355) and `regenerateBySession` (line 394).

- [ ] **Step 2: Update token-based approval API routes to pass correlationId**

In each of these 3 files, pass the `response_id` (available from `link.response_id`) as the correlation ID:

`src/app/api/approve/[token]/approve/route.ts` (line 41):
```typescript
      await approve(tx, link, deviceCookieHash, audit, link.response_id);
```

`src/app/api/approve/[token]/edit/route.ts` (line 59):
```typescript
      await edit(tx, link, editedText.trim(), deviceCookieHash, audit, link.response_id);
```

`src/app/api/approve/[token]/regenerate/route.ts` (line 41):
```typescript
      await regenerate(tx, link, deviceCookieHash, audit, link.response_id);
```

- [ ] **Step 3: Update session-based dashboard approval routes to pass correlationId**

In each of these 3 files, pass `response.id` as the correlation ID:

`src/app/api/dashboard/reviews/[reviewId]/approve/route.ts` (line 53):
```typescript
      await approveBySession(tx, response.id as string, user.businessId!, audit, response.id as string);
```

`src/app/api/dashboard/reviews/[reviewId]/edit/route.ts` (line 71):
```typescript
      await editBySession(tx, response.id as string, user.businessId!, parsed.data.editedText, audit, response.id as string);
```

`src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts` (line 51):
```typescript
      await regenerateBySession(tx, response.id as string, user.businessId!, audit, response.id as string);
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: All tests pass. Existing approval service tests mock the SQL layer and won't be affected by the optional parameter addition.

- [ ] **Step 5: Commit**

```bash
git add src/lib/approval/service.ts src/app/api/approve/ src/app/api/dashboard/reviews/
git commit -m "feat(20a): propagate correlation IDs through approval service and routes"
```

---

## Task 7: Replace console.log with createWorkerLogger in All 12 Workers

**Files:**
- Modify: All 12 BullMQ worker handler files listed below

This is a mechanical transformation applied to each file:

1. Add import: `import { createWorkerLogger } from '../../src/lib/shared/logger';`
   (Worker files use relative paths `../../src/lib/...`, not `@/lib/...` aliases)
2. Remove the `const LOG_PREFIX = '[WorkerName]';` line
3. At the top of the handler function, create the logger from job data:
   `const logger = createWorkerLogger('[WorkerName]', job.data.correlation_id);`
4. Replace all `console.log(\`${LOG_PREFIX} ...\`)` → `logger.log(...)`
5. Replace all `console.warn(\`${LOG_PREFIX} ...\`)` → `logger.warn(...)`
6. Replace all `console.error(\`${LOG_PREFIX} ...\`)` → `logger.error(...)`

**Important:** When converting template literals like `` console.log(`${LOG_PREFIX} Business ${id} not found`) ``, extract the message part: `logger.log('Business', id, 'not found')` or `logger.warn(\`Business ${id} not found\`)`. The tag is handled by the logger.

- [ ] **Step 1: Update ReviewSyncWorker.ts**

```typescript
// Remove: const LOG_PREFIX = '[ReviewSyncWorker]';
// Add at line 1 of imports:
import { createWorkerLogger } from '../../src/lib/shared/logger';

// At the top of handleReviewSync():
const logger = createWorkerLogger('[ReviewSyncWorker]', job.data.correlation_id);
```

- [ ] **Step 2: Update ResponseGeneratorWorker.ts**

Same pattern. Remove `LOG_PREFIX`, add `createWorkerLogger` import, create logger at top of handler.

- [ ] **Step 3: Update NotificationWorker.ts**

Same pattern.

- [ ] **Step 4: Update ResponsePublisherWorker.ts**

Same pattern.

- [ ] **Step 5: Update WeeklySummaryWorker.ts**

Same pattern.

- [ ] **Step 6: Update MonthlyImpactWorker.ts**

Same pattern.

- [ ] **Step 7: Update EngagementAlertWorker.ts**

Same pattern.

- [ ] **Step 8: Update AdminExceptionWorker.ts**

Same pattern.

- [ ] **Step 9: Update PlaceIdValidationWorker.ts**

Same pattern.

- [ ] **Step 10: Update DemoGenerationWorker.ts**

Same pattern.

- [ ] **Step 11: Update OnboardingDripWorker.ts**

Same pattern.

- [ ] **Step 12: Update RankingTrackingWorker.ts**

Same pattern.

**Do NOT update:** OutboxPoller, ReconciliationPoller, ArchivalPoller, WeeklySummaryScheduler, MonthlyImpactScheduler, EngagementMonitorPoller, RankingTrackingScheduler, OnboardingDripScheduler, NotificationFailoverPoller — these are setInterval pollers, not BullMQ job handlers. They keep their existing `LOG_PREFIX` pattern.

- [ ] **Step 13: Run full test suite**

Run: `pnpm test`
Expected: All tests pass. Some tests may spy on `console.log` and assert specific output — if any fail due to the format change from `[WorkerName] message` to `[WorkerName] [corr-id] message`, update the test assertion to match or use `expect.stringContaining()`.

- [ ] **Step 14: Run type check and build**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: No errors.

- [ ] **Step 15: Commit**

```bash
git add worker/jobs/
git commit -m "feat(20a): replace console.log with createWorkerLogger in all 12 workers"
```

---

## Task 8: Verification + Final Tests

- [ ] **Step 1: Audit all INSERT INTO job_outbox for correlation_id coverage**

Run: `rg -n "correlation_id" src worker --type ts | head -40`
Expected: Every file that has `INSERT INTO job_outbox` also has `correlation_id` in a payload object nearby. Cross-reference with the 27 INSERT locations from the audit.

- [ ] **Step 2: Verify queryability**

The following query should work against the outbox once entries are created:
```sql
SELECT topic, status, created_at, completed_at, last_error
FROM job_outbox
WHERE payload->>'correlation_id' = '<any-uuid>'
ORDER BY created_at;
```

- [ ] **Step 3: Run full test suite one final time**

Run: `pnpm test`
Expected: All tests pass (570+ existing + 6 new logger tests).

- [ ] **Step 4: Run build**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 5: Commit any test fixes**

If any tests needed updating for the new log format:
```bash
git add -A
git commit -m "test(20a): update test assertions for structured logger format"
```
