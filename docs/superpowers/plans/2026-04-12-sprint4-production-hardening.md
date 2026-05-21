# Sprint 4 Prompt 17: Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the system runs 10 businesses with zero engineering intervention — notification failover, weekly summaries, and table archival.

**Architecture:** Three new `setInterval` pollers follow the ReconciliationPoller pattern (NOT BullMQ repeatable jobs). The NotificationWorker gains failover-awareness so it can re-send approval emails for stale/bounced notifications. WeeklySummaryWorker is a standard BullMQ consumer. All pollers create outbox entries rather than directly enqueuing BullMQ jobs.

**Tech Stack:** Postgres.js `sql`, BullMQ Worker, Resend email, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/shared/worker-types.ts` | **MODIFY** | Add `WeeklySummaryPayload`, add `failover` field to `SendNotificationPayload` |
| `worker/jobs/NotificationWorker.ts` | **MODIFY** | Add failover-aware branch so re-sent notifications bypass normal idempotency |
| `worker/jobs/NotificationFailoverPoller.ts` | **CREATE** | 2-hour poller: finds stale/failed notifications, creates failover outbox entries, alerts admin |
| `worker/jobs/WeeklySummaryScheduler.ts` | **CREATE** | Hourly poller: checks if Monday 8-9 AM UTC, creates outbox entries per business |
| `worker/jobs/WeeklySummaryWorker.ts` | **REWRITE** | Consumes `weekly_summary` jobs, queries stats, builds email, sends, saves |
| `src/lib/notifications/email.ts` | **MODIFY** | Add `buildWeeklySummaryEmailHtml()` |
| `worker/jobs/ArchivalPoller.ts` | **CREATE** | 24-hour poller: deletes old outbox/events/demos |
| `worker/index.ts` | **MODIFY** | Register 3 new pollers + WeeklySummaryWorker in startup/shutdown lifecycle |
| `worker/__tests__/NotificationFailoverPoller.test.ts` | **CREATE** | Tests for stale detection, all-failed admin alert, dedup |
| `worker/__tests__/NotificationWorker.test.ts` | **MODIFY** | Add tests for failover mode |
| `worker/__tests__/WeeklySummaryWorker.test.ts` | **CREATE** | Tests for active summary, cancelled skip, duplicate week skip |

---

## Task 1: Extend `SendNotificationPayload` and add `WeeklySummaryPayload`

**Files:**
- Modify: `src/lib/shared/worker-types.ts`

- [ ] **Step 1: Add the failover field and weekly summary payload**

Replace the full content of `src/lib/shared/worker-types.ts` with:

```typescript
/**
 * Job payload interfaces shared between outbox producers and BullMQ consumers.
 * Every worker and every outbox INSERT must use these types for the payload shape.
 *
 * DemoJobPayload lives in src/lib/demos/types.ts (already exists).
 */

export interface SyncReviewsPayload {
  business_id: string;
  google_place_id: string;
}

export interface GenerateResponsePayload {
  review_id: string;
  business_id: string;
  version: number;
}

export interface SendNotificationPayload {
  response_id: string;
  business_id: string;
  /** Present only when re-queued by the NotificationFailoverPoller. */
  failover?: {
    reason: 'stale_no_delivery' | 'all_deliveries_failed';
  };
}

export interface PublishResponsePayload {
  response_id: string;
  business_id: string;
}

export interface NotifyAdminExceptionPayload {
  review_exception_id: string;
  business_id: string;
}

export interface WeeklySummaryPayload {
  business_id: string;
  /** ISO date 'YYYY-MM-DD' — always a Monday (start of the week being summarized). */
  week_start_date: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run existing tests to ensure nothing broke**

Run: `pnpm test`
Expected: 189 tests pass

- [ ] **Step 4: Commit**

```bash
git add src/lib/shared/worker-types.ts
git commit -m "feat: add failover field to SendNotificationPayload, add WeeklySummaryPayload"
```

---

## Task 2: Modify `NotificationWorker` for failover-awareness

**Files:**
- Modify: `worker/jobs/NotificationWorker.ts`
- Modify: `worker/__tests__/NotificationWorker.test.ts`

- [ ] **Step 1: Write the failing tests for failover mode**

Append the following tests to `worker/__tests__/NotificationWorker.test.ts`, inside the existing `describe` block (after the last `it` block, before the closing `});`):

```typescript
  // ── Failover mode tests ───────────────────────────────────────────

  // 6. Failover skips when delivery already succeeded
  it('failover: completes without sending when delivered_at exists', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'stale_no_delivery' as const };

    sqlReturnQueue.push([mockResponseRow()]);           // 1: response+review
    sqlReturnQueue.push([mockBusinessRow()]);            // 2: business
    sqlReturnQueue.push([{ id: 'delivered-1' }]);        // 3: failover delivered check → found

    await handleSendNotification(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  // 7. Failover re-sends even when old sent_at delivery exists (the key distinction)
  it('failover: re-sends when sent_at exists but no delivered_at', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'stale_no_delivery' as const };

    sqlReturnQueue.push([mockResponseRow()]);           // 1: response+review
    sqlReturnQueue.push([mockBusinessRow()]);            // 2: business
    sqlReturnQueue.push([]);                             // 3: failover delivered check → none found
    // sql.begin: revoke orphans + create link → 2 tx calls
    sqlReturnQueue.push([]);                             // INSERT notification_deliveries

    await handleSendNotification(job);

    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(mockSendApprovalEmail).toHaveBeenCalledOnce();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });

  // 8. Failover respects subscription guard
  it('failover: skips for cancelled subscription', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'all_deliveries_failed' as const };

    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleSendNotification(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `pnpm test -- worker/__tests__/NotificationWorker.test.ts`
Expected: test 7 ("failover: re-sends when sent_at exists but no delivered_at") FAILS because the current idempotency check finds the existing `sent_at` delivery row and short-circuits.

- [ ] **Step 3: Implement failover logic in NotificationWorker**

In `worker/jobs/NotificationWorker.ts`, replace the idempotency check section (Step 3, lines 90-102) with a failover-aware version. The change is:

Find this block:
```typescript
  // ── Step 3: Idempotency check ──────────────────────────────────────
  // If a delivery record already exists for this response, the email was
  // already sent (previous attempt succeeded). Complete and return.
  const [existingDelivery] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE response_id = ${response_id} AND template = 'approval_request' AND sent_at IS NOT NULL
  `;

  if (existingDelivery) {
    console.log(`${LOG_PREFIX} Delivery already exists for response ${response_id}, skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }
```

Replace with:
```typescript
  // ── Step 3: Idempotency / failover check ───────────────────────────
  const isFailover = !!(job.data as SendNotificationPayload).failover;

  if (isFailover) {
    // Failover mode: only skip if a delivery was actually DELIVERED (not just sent).
    // A sent_at without delivered_at means the email may have been lost.
    const [deliveredRow] = await sql<{ id: string }[]>`
      SELECT id FROM notification_deliveries
      WHERE response_id = ${response_id}
        AND template = 'approval_request'
        AND delivered_at IS NOT NULL
    `;
    if (deliveredRow) {
      console.log(`${LOG_PREFIX} Failover: delivery already confirmed for response ${response_id}, skipping`);
      await markOutboxCompleted(outboxId);
      return;
    }
    console.log(`${LOG_PREFIX} Failover: re-sending notification for response ${response_id} (reason: ${job.data.failover!.reason})`);
  } else {
    // Normal mode: skip if any delivery record with sent_at exists (email was sent).
    const [existingDelivery] = await sql<{ id: string }[]>`
      SELECT id FROM notification_deliveries
      WHERE response_id = ${response_id} AND template = 'approval_request' AND sent_at IS NOT NULL
    `;
    if (existingDelivery) {
      console.log(`${LOG_PREFIX} Delivery already exists for response ${response_id}, skipping`);
      await markOutboxCompleted(outboxId);
      return;
    }
  }
```

No other changes needed — steps 4-7 (validate config, generate token, revoke+create link, send email, record delivery) already do exactly what failover needs: revoke old orphaned links, create a fresh token, send a fresh email, record the delivery.

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm test -- worker/__tests__/NotificationWorker.test.ts`
Expected: all 8 tests pass (5 existing + 3 new)

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/NotificationWorker.ts worker/__tests__/NotificationWorker.test.ts
git commit -m "feat: add failover-awareness to NotificationWorker"
```

---

## Task 3: Notification Failover Poller

**Files:**
- Create: `worker/jobs/NotificationFailoverPoller.ts`
- Create: `worker/__tests__/NotificationFailoverPoller.test.ts`

- [ ] **Step 1: Write the tests**

Create `worker/__tests__/NotificationFailoverPoller.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockSendInternalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    // Attach .count for INSERT results
    if (Array.isArray(result)) {
      (result as any).count = result.length > 0 ? 1 : 0;
    }
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'mock-admin-1' }),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
}));
vi.mock('../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: vi.fn(),
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

describe('NotificationFailoverPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates failover outbox entry for stale response with no delivery', async () => {
    // stale query returns one response
    sqlReturnQueue.push([{ response_id: 'resp-1', business_id: 'biz-1' }]);
    // INSERT outbox for stale → count=1
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // all-failed query returns empty
    sqlReturnQueue.push([]);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0); // flush immediate invocation

    // Verify an INSERT into job_outbox happened
    const insertCalls = mockSql.mock.calls.filter(
      (call: any[]) => {
        const text = Array.from(call[0] as TemplateStringsArray).join('');
        return text.includes('job_outbox') && text.includes('INSERT');
      },
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    // No admin email for stale (only for all-failed)
    expect(mockSendInternalEmail).not.toHaveBeenCalled();

    mod.stopNotificationFailoverPoller();
  });

  it('sends admin alert and creates failover outbox for all-failed deliveries', async () => {
    // stale query returns empty
    sqlReturnQueue.push([]);
    // all-failed query returns one response
    sqlReturnQueue.push([{
      response_id: 'resp-2',
      business_id: 'biz-2',
      business_name: 'Test Biz',
      reviewer_name: 'Jane',
      star_rating: 1,
    }]);
    // admin alert dedup check → no existing alert
    sqlReturnQueue.push([]);
    // INSERT outbox for all-failed → count=1
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.to).toBe('admin@test.com');
    expect(emailArgs.subject).toContain('Test Biz');

    mod.stopNotificationFailoverPoller();
  });

  it('deduplicates admin alerts within 24 hours', async () => {
    // stale query → empty
    sqlReturnQueue.push([]);
    // all-failed query → one response
    sqlReturnQueue.push([{
      response_id: 'resp-3',
      business_id: 'biz-3',
      business_name: 'Dup Biz',
      reviewer_name: 'Bob',
      star_rating: 2,
    }]);
    // admin alert dedup check → already sent within 24h
    sqlReturnQueue.push([{ id: 'existing-alert' }]);
    // INSERT outbox for all-failed (still created — it's the email that's deduped)
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    // Admin email NOT sent because dedup found recent alert
    expect(mockSendInternalEmail).not.toHaveBeenCalled();

    mod.stopNotificationFailoverPoller();
  });

  it('lifecycle: start and stop work without errors', async () => {
    sqlReturnQueue.push([]); // stale
    sqlReturnQueue.push([]); // all-failed
    const mod = await import('../jobs/NotificationFailoverPoller');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopNotificationFailoverPoller();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[NotificationFailover] Stopped'));
    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- worker/__tests__/NotificationFailoverPoller.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the poller**

Create `worker/jobs/NotificationFailoverPoller.ts`:

```typescript
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { sendInternalEmail } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { escapeHtml } from '../../src/lib/shared/html';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[NotificationFailover]';
const DEFAULT_INTERVAL_MS = 7_200_000; // 2 hours

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.NOTIFICATION_FAILOVER_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function checkFailedNotifications(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    // ── 1. Stale: pending_approval >4h, no confirmed delivery, no in-flight outbox ──
    const staleResponses = await sql<{ response_id: string; business_id: string }[]>`
      SELECT resp.id AS response_id, resp.business_id
      FROM responses resp
      WHERE resp.status = 'pending_approval'
        AND resp.created_at < NOW() - INTERVAL '4 hours'
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id
            AND nd.template = 'approval_request'
            AND nd.delivered_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'send_notification'
            AND jo.aggregate_id = resp.id
            AND jo.status IN ('pending', 'dispatched')
        )
    `;

    let staleQueued = 0;
    for (const row of staleResponses) {
      const payload: SendNotificationPayload = {
        response_id: row.response_id,
        business_id: row.business_id,
        failover: { reason: 'stale_no_delivery' },
      };
      try {
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'send_notification',
            'response',
            ${row.response_id},
            ${JSON.stringify(payload)}::jsonb,
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'send_notification'
              AND jo.aggregate_id = ${row.response_id}
              AND jo.status IN ('pending', 'dispatched')
          )
        `;
        if (inserted.count > 0) staleQueued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue; // unique violation — safe
        console.error(`${LOG_PREFIX} Failed to queue failover for response ${row.response_id}:`, err);
      }
    }

    if (staleQueued > 0) {
      console.log(`${LOG_PREFIX} Queued ${staleQueued} stale failover entries (${staleResponses.length} candidates)`);
    }

    // ── 2. All-failed: every approval_request delivery has failed_at set ──
    const allFailedResponses = await sql<{
      response_id: string;
      business_id: string;
      business_name: string;
      reviewer_name: string;
      star_rating: number;
    }[]>`
      SELECT resp.id AS response_id, resp.business_id,
             b.name AS business_name, r.reviewer_name, r.star_rating
      FROM responses resp
      JOIN businesses b ON resp.business_id = b.id
      JOIN reviews r ON resp.review_id = r.id
      WHERE resp.status = 'pending_approval'
        AND resp.created_at < NOW() - INTERVAL '4 hours'
        AND EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id AND nd.template = 'approval_request'
        )
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id
            AND nd.template = 'approval_request'
            AND nd.failed_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'send_notification'
            AND jo.aggregate_id = resp.id
            AND jo.status IN ('pending', 'dispatched')
        )
    `;

    for (const row of allFailedResponses) {
      // ── Admin alert dedup: skip if an admin_exception delivery was sent <24h ago ──
      const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
      if (adminEmail) {
        const [recentAlert] = await sql<{ id: string }[]>`
          SELECT id FROM notification_deliveries
          WHERE response_id = ${row.response_id}
            AND template = 'admin_notification_failover'
            AND recipient = ${adminEmail}
            AND created_at > NOW() - INTERVAL '24 hours'
        `;

        if (!recentAlert) {
          try {
            const { messageId } = await sendInternalEmail({
              to: adminEmail,
              subject: `Notification failure: ${row.business_name} — all delivery attempts failed`,
              bodyHtml: `<p>All approval email delivery attempts have failed for a response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong>.</p><p>The system will re-attempt delivery. Please check the Resend dashboard for bounce/complaint details.</p>`,
            });
            await recordNotificationDelivery({
              businessId: row.business_id,
              responseId: row.response_id,
              channel: 'email',
              recipient: adminEmail,
              template: 'admin_notification_failover',
              externalMessageId: messageId,
            });
          } catch (emailErr) {
            console.error(`${LOG_PREFIX} Failed to send admin alert for response ${row.response_id}:`, emailErr);
          }
        }
      }

      // Queue a failover re-send
      const payload: SendNotificationPayload = {
        response_id: row.response_id,
        business_id: row.business_id,
        failover: { reason: 'all_deliveries_failed' },
      };
      try {
        await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'send_notification',
            'response',
            ${row.response_id},
            ${JSON.stringify(payload)}::jsonb,
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'send_notification'
              AND jo.aggregate_id = ${row.response_id}
              AND jo.status IN ('pending', 'dispatched')
          )
        `;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        console.error(`${LOG_PREFIX} Failed to queue all-failed failover for response ${row.response_id}:`, err);
      }
    }

    if (allFailedResponses.length > 0) {
      console.log(`${LOG_PREFIX} Processed ${allFailedResponses.length} all-failed responses`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Poll cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startNotificationFailoverPoller(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  checkFailedNotifications().catch(console.error);
  pollerInterval = setInterval(() => {
    checkFailedNotifications().catch(console.error);
  }, intervalMs);
}

export function stopNotificationFailoverPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- worker/__tests__/NotificationFailoverPoller.test.ts`
Expected: all 4 tests pass

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/NotificationFailoverPoller.ts worker/__tests__/NotificationFailoverPoller.test.ts
git commit -m "feat: add NotificationFailoverPoller with stale/failed detection and admin alerts"
```

---

## Task 4: Weekly Summary Email Template

**Files:**
- Modify: `src/lib/notifications/email.ts`

- [ ] **Step 1: Add the email builder**

Append the following to the end of `src/lib/notifications/email.ts`:

```typescript
// ── Weekly summary email template ─────────────────────────────────────

export interface WeeklySummaryEmailParams {
  businessName: string;
  weekStartDate: string; // 'YYYY-MM-DD'
  weekEndDate: string;   // 'YYYY-MM-DD'
  totalReviews: number;
  totalResponded: number;
  notableReviews: Array<{
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
  }>;
}

function formatWeekDate(iso: string): string {
  try {
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return iso;
  }
}

export function buildWeeklySummaryEmailHtml(params: WeeklySummaryEmailParams): string {
  const { businessName, weekStartDate, weekEndDate, totalReviews, totalResponded, notableReviews } = params;
  const safeName = escapeHtml(businessName);
  const responseRate = totalReviews > 0 ? Math.round((totalResponded / totalReviews) * 100) : 0;
  const weekRange = `${formatWeekDate(weekStartDate)} – ${formatWeekDate(weekEndDate)}`;

  let notableHtml = '';
  if (notableReviews.length > 0) {
    const items = notableReviews.map((r) => {
      const stars = renderStars(r.starRating);
      const text = r.reviewText ? escapeHtml(truncate(r.reviewText, 150)) : 'Rating only';
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;"><span style="font-size:16px;">${stars}</span> <strong>${escapeHtml(r.reviewerName)}</strong><br><span style="color:#4b5563;font-size:14px;">${text}</span></td></tr>`;
    }).join('');
    notableHtml = `
      <tr><td style="padding:16px 24px 0;">
        <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Reviews needing attention</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
      </td></tr>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Weekly Review Summary — ${safeName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">${weekRange}</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            <tr>
              <td style="padding:16px;background:#f9fafb;border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:#111;">${totalReviews}</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Reviews</p>
              </td>
              <td style="width:8px;"></td>
              <td style="padding:16px;background:#f9fafb;border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:#111;">${totalResponded}</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Responded</p>
              </td>
              <td style="width:8px;"></td>
              <td style="padding:16px;background:${responseRate >= 90 ? '#f0fdf4' : '#fef3c7'};border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:${responseRate >= 90 ? '#166534' : '#92400e'};">${responseRate}%</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Rate</p>
              </td>
            </tr>
          </table>
        </td></tr>
        ${notableHtml}
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/notifications/email.ts
git commit -m "feat: add weekly summary email template"
```

---

## Task 5: Weekly Summary Worker

**Files:**
- Rewrite: `worker/jobs/WeeklySummaryWorker.ts`
- Create: `worker/__tests__/WeeklySummaryWorker.test.ts`

- [ ] **Step 1: Write the tests**

Create `worker/__tests__/WeeklySummaryWorker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendInternalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-ws-1' }),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildWeeklySummaryEmailHtml: vi.fn(() => '<html>summary</html>'),
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handleWeeklySummary } from '../jobs/WeeklySummaryWorker';

function makeJob(overrides: Partial<WeeklySummaryPayload> = {}): Job<WeeklySummaryPayload> {
  return {
    data: {
      business_id: 'biz-1',
      week_start_date: '2026-04-06',
      ...overrides,
    },
    id: 'outbox-ws-1',
  } as Job<WeeklySummaryPayload>;
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    name: 'Test Biz',
    owner_email: 'owner@test.com',
    subscription_status: 'active',
    updated_at: new Date(),
    ...overrides,
  };
}

describe('WeeklySummaryWorker – handleWeeklySummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
  });

  it('generates and sends weekly summary for active business', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);                          // business
    sqlReturnQueue.push([{ count: '5' }]);                             // total reviews
    sqlReturnQueue.push([{ count: '4' }]);                             // total responded
    sqlReturnQueue.push([{ reviewer_name: 'Jane', star_rating: 1, review_text: 'Bad' }]); // notable
    sqlReturnQueue.push([{ sent_at: null }]);                          // upsert RETURNING
    sqlReturnQueue.push([]);                                           // UPDATE sent_at

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.to).toBe('owner@test.com');
    expect(emailArgs.subject).toContain('Test Biz');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1');
  });

  it('skips cancelled subscription', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1');
  });

  it('skips pending_payment subscription', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1');
  });

  it('skips duplicate week (sent_at already set)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);                          // business
    sqlReturnQueue.push([{ count: '3' }]);                             // total reviews
    sqlReturnQueue.push([{ count: '3' }]);                             // total responded
    sqlReturnQueue.push([]);                                           // no notable
    sqlReturnQueue.push([{ sent_at: '2026-04-07T08:00:00Z' }]);       // upsert RETURNING → already sent

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1');
  });

  it('fails outbox when business not found', async () => {
    sqlReturnQueue.push([]);

    await handleWeeklySummary(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-ws-1', 'business_not_found');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- worker/__tests__/WeeklySummaryWorker.test.ts`
Expected: FAIL — `handleWeeklySummary` not exported

- [ ] **Step 3: Implement the worker**

Replace the content of `worker/jobs/WeeklySummaryWorker.ts` with:

```typescript
import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendInternalEmail, buildWeeklySummaryEmailHtml } from '../../src/lib/notifications/email';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[WeeklySummaryWorker]';

export async function handleWeeklySummary(
  job: Job<WeeklySummaryPayload>,
): Promise<void> {
  const { business_id, week_start_date } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── 1. Load business ──────────────────────────────────────────────
  const [business] = await sql<{
    id: string;
    name: string;
    owner_email: string;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT id, name, owner_email, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── 2. Subscription guard ─────────────────────────────────────────
  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'summary',
  );

  if (!subCheck.allowed) {
    console.log(`${LOG_PREFIX} Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 3. Query week stats ───────────────────────────────────────────
  const weekEnd = new Date(week_start_date + 'T00:00:00Z');
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const weekEndDate = weekEnd.toISOString().slice(0, 10);

  const [reviewCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM reviews
    WHERE business_id = ${business_id}
      AND detected_at >= ${week_start_date}::date
      AND detected_at < ${weekEndDate}::date
  `;

  const [respondedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM responses
    WHERE business_id = ${business_id}
      AND status IN ('posted', 'approved', 'edited', 'awaiting_manual_post')
      AND created_at >= ${week_start_date}::date
      AND created_at < ${weekEndDate}::date
  `;

  const notableReviews = await sql<{
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
  }[]>`
    SELECT reviewer_name, star_rating, review_text FROM reviews
    WHERE business_id = ${business_id}
      AND star_rating <= 2
      AND detected_at >= ${week_start_date}::date
      AND detected_at < ${weekEndDate}::date
    ORDER BY detected_at DESC
    LIMIT 5
  `;

  const totalReviews = parseInt(reviewCount?.count ?? '0', 10);
  const totalResponded = parseInt(respondedCount?.count ?? '0', 10);

  // ── 4. Upsert weekly_summaries row (idempotent) ───────────────────
  const [upsertRow] = await sql<{ sent_at: string | null }[]>`
    INSERT INTO weekly_summaries (id, business_id, week_start_date, total_reviews, total_responded, notable_reviews)
    VALUES (
      gen_random_uuid(), ${business_id}, ${week_start_date}::date,
      ${totalReviews}, ${totalResponded},
      ${JSON.stringify(notableReviews)}::jsonb
    )
    ON CONFLICT (business_id, week_start_date)
    DO UPDATE SET
      total_reviews = EXCLUDED.total_reviews,
      total_responded = EXCLUDED.total_responded,
      notable_reviews = EXCLUDED.notable_reviews
    WHERE weekly_summaries.sent_at IS NULL
    RETURNING sent_at
  `;

  // If row already had sent_at, the WHERE clause prevents the update and
  // RETURNING returns the existing sent_at. If sent_at IS NOT NULL, skip.
  if (upsertRow?.sent_at !== null && upsertRow?.sent_at !== undefined) {
    console.log(`${LOG_PREFIX} Weekly summary for ${business_id} week ${week_start_date} already sent`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 5. Build and send email ───────────────────────────────────────
  const html = buildWeeklySummaryEmailHtml({
    businessName: business.name,
    weekStartDate: week_start_date,
    weekEndDate: weekEndDate,
    totalReviews,
    totalResponded,
    notableReviews: notableReviews.map((r) => ({
      reviewerName: r.reviewer_name,
      starRating: r.star_rating,
      reviewText: r.review_text,
    })),
  });

  const weekLabel = `${week_start_date} to ${weekEndDate}`;
  await sendInternalEmail({
    to: business.owner_email,
    subject: `Weekly Review Summary — ${business.name} (${weekLabel})`,
    bodyHtml: html,
  });

  // ── 6. Mark as sent ───────────────────────────────────────────────
  await sql`
    UPDATE weekly_summaries
    SET sent_at = NOW()
    WHERE business_id = ${business_id} AND week_start_date = ${week_start_date}::date
  `;

  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Weekly summary sent for ${business.name} (week ${week_start_date})`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- worker/__tests__/WeeklySummaryWorker.test.ts`
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/WeeklySummaryWorker.ts worker/__tests__/WeeklySummaryWorker.test.ts
git commit -m "feat: implement WeeklySummaryWorker with stats query, idempotent upsert, email"
```

---

## Task 6: Weekly Summary Scheduler

**Files:**
- Create: `worker/jobs/WeeklySummaryScheduler.ts`

- [ ] **Step 1: Create the scheduler**

Create `worker/jobs/WeeklySummaryScheduler.ts`:

```typescript
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[WeeklySummaryScheduler]';
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const WEEKLY_SUMMARY_TIMEZONE = 'UTC';

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.WEEKLY_SUMMARY_SCHEDULER_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Returns the Monday 00:00 UTC of the week that just ended.
 * Called on Monday 8-9 AM: returns the PREVIOUS Monday.
 */
function getPreviousMonday(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  // getUTCDay(): 0=Sun, 1=Mon. If today is Monday (1), go back 7 days.
  const dayOfWeek = d.getUTCDay();
  const daysBack = dayOfWeek === 0 ? 6 : (dayOfWeek - 1) + 7;
  // Wait — if it's Monday, we want LAST Monday = 7 days back
  // If it's Tuesday, we want the Monday before = 8 days back? No.
  // The scheduler only fires on Monday 8-9 AM. So dayOfWeek is always 1.
  // Previous Monday = 7 days back.
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

async function checkAndSchedule(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    const now = new Date();
    const utcDay = now.getUTCDay(); // 0=Sun, 1=Mon
    const utcHour = now.getUTCHours();

    // Only schedule on Monday between 8-9 AM UTC
    if (utcDay !== 1 || utcHour < 8 || utcHour >= 9) {
      return;
    }

    const weekStartDate = getPreviousMonday(now);

    // Find businesses that need a summary
    const businesses = await sql<{ id: string }[]>`
      SELECT b.id FROM businesses b
      WHERE b.subscription_status IN ('active', 'past_due')
        AND NOT EXISTS (
          SELECT 1 FROM weekly_summaries ws
          WHERE ws.business_id = b.id
            AND ws.week_start_date = ${weekStartDate}::date
            AND ws.sent_at IS NOT NULL
        )
    `;

    let queued = 0;
    for (const biz of businesses) {
      const payload: WeeklySummaryPayload = {
        business_id: biz.id,
        week_start_date: weekStartDate,
      };

      try {
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'weekly_summary',
            'business',
            ${biz.id},
            ${JSON.stringify(payload)}::jsonb,
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'weekly_summary'
              AND jo.aggregate_id = ${biz.id}
              AND jo.status IN ('pending', 'dispatched')
              AND jo.payload->>'week_start_date' = ${weekStartDate}
          )
        `;
        if (inserted.count > 0) queued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        console.error(`${LOG_PREFIX} Failed to queue summary for business ${biz.id}:`, err);
      }
    }

    if (queued > 0) {
      console.log(`${LOG_PREFIX} Queued ${queued} weekly_summary outbox entries for week ${weekStartDate}`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Scheduler cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startWeeklySummaryScheduler(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms, timezone=${WEEKLY_SUMMARY_TIMEZONE})`);
  checkAndSchedule().catch(console.error);
  pollerInterval = setInterval(() => {
    checkAndSchedule().catch(console.error);
  }, intervalMs);
}

export function stopWeeklySummaryScheduler(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/WeeklySummaryScheduler.ts
git commit -m "feat: add WeeklySummaryScheduler (hourly check, Monday 8-9 AM UTC)"
```

---

## Task 7: Archival Poller

**Files:**
- Create: `worker/jobs/ArchivalPoller.ts`

- [ ] **Step 1: Create the poller**

Create `worker/jobs/ArchivalPoller.ts`:

```typescript
import { sql } from '../../src/lib/db/server';

const LOG_PREFIX = '[ArchivalPoller]';
const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.ARCHIVAL_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function runArchival(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    // 1. Completed outbox entries older than 7 days
    const [outboxResult] = await sql<{ count: string }[]>`
      WITH deleted AS (
        DELETE FROM job_outbox
        WHERE status = 'completed'
          AND completed_at < NOW() - INTERVAL '7 days'
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    // 2. Processed inbound events older than 30 days
    const [eventsResult] = await sql<{ count: string }[]>`
      WITH deleted AS (
        DELETE FROM inbound_events
        WHERE status = 'processed'
          AND processed_at < NOW() - INTERVAL '30 days'
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    // 3. Expired prospect demos older than 30 days past expiry
    const [demosResult] = await sql<{ count: string }[]>`
      WITH deleted AS (
        DELETE FROM prospect_demos
        WHERE expires_at < NOW() - INTERVAL '30 days'
          AND generation_status = 'completed'
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    const outboxCount = parseInt(outboxResult?.count ?? '0', 10);
    const eventsCount = parseInt(eventsResult?.count ?? '0', 10);
    const demosCount = parseInt(demosResult?.count ?? '0', 10);

    if (outboxCount + eventsCount + demosCount > 0) {
      console.log(
        `${LOG_PREFIX} Archived: ${outboxCount} outbox entries, ${eventsCount} inbound events, ${demosCount} expired demos`,
      );
    } else {
      console.log(`${LOG_PREFIX} Nothing to archive`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Archival cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startArchivalPoller(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  runArchival().catch(console.error);
  pollerInterval = setInterval(() => {
    runArchival().catch(console.error);
  }, intervalMs);
}

export function stopArchivalPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ArchivalPoller.ts
git commit -m "feat: add ArchivalPoller for outbox/events/demos cleanup"
```

---

## Task 8: Register everything in `worker/index.ts`

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add imports**

In `worker/index.ts`, add these imports after the existing import block (after line 46, the `handleStripeWebhook` import):

```typescript
import { handleWeeklySummary } from './jobs/WeeklySummaryWorker';
import { startNotificationFailoverPoller, stopNotificationFailoverPoller } from './jobs/NotificationFailoverPoller';
import { startWeeklySummaryScheduler, stopWeeklySummaryScheduler } from './jobs/WeeklySummaryScheduler';
import { startArchivalPoller, stopArchivalPoller } from './jobs/ArchivalPoller';
```

- [ ] **Step 2: Register the WeeklySummaryWorker**

After the `adminExceptionWorker` definition (line 84) and before `const workers = [...]` (line 87), add:

```typescript
const weeklySummaryWorker = new Worker(QUEUE_NAMES.WEEKLY_SUMMARY, handleWeeklySummary, {
  connection: redisOpts,
});
```

Then update the `workers` array to include `weeklySummaryWorker`:

```typescript
const workers = [demoWorker, reviewSyncWorker, responseGenWorker, notificationWorker, publisherWorker, adminExceptionWorker, weeklySummaryWorker];
```

- [ ] **Step 3: Start pollers in main()**

In the `main()` function, after `startReconciliationPoller();` (line 138), add:

```typescript
  startNotificationFailoverPoller();
  startWeeklySummaryScheduler();
  startArchivalPoller();
```

- [ ] **Step 4: Stop pollers in shutdown()**

In the `shutdown()` function, after `stopReconciliationPoller();` (line 148), add:

```typescript
  stopNotificationFailoverPoller();
  stopWeeklySummaryScheduler();
  stopArchivalPoller();
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: all tests pass (previous 189 + new tests from Tasks 2, 3, 5)

- [ ] **Step 7: Commit**

```bash
git add worker/index.ts
git commit -m "feat: register NotificationFailoverPoller, WeeklySummaryScheduler, ArchivalPoller, WeeklySummaryWorker in worker lifecycle"
```

---

## Self-Review Notes

**Spec coverage check:**
- Notification failover poller (stale + all-failed + admin dedup): Task 3 ✓
- NotificationWorker failover-awareness: Task 2 ✓
- `SendNotificationPayload.failover` field: Task 1 ✓
- Weekly summary scheduler (Monday 8-9 UTC, previous week): Task 6 ✓
- Weekly summary worker (stats, upsert, idempotent send): Task 5 ✓
- Weekly summary email template: Task 4 ✓
- `WeeklySummaryPayload`: Task 1 ✓
- Archival poller (outbox 7d, events 30d, demos 30d): Task 7 ✓
- Registration in `worker/index.ts`: Task 8 ✓
- Tests for WeeklySummaryWorker: Task 5 ✓
- Tests for NotificationFailoverPoller: Task 3 ✓
- Tests for NotificationWorker failover mode: Task 2 ✓

**Placeholder scan:** No TBD, TODO, or "fill in later" found.

**Type consistency:** `SendNotificationPayload.failover`, `WeeklySummaryPayload`, `handleWeeklySummary`, `startNotificationFailoverPoller`/`stopNotificationFailoverPoller`, `startWeeklySummaryScheduler`/`stopWeeklySummaryScheduler`, `startArchivalPoller`/`stopArchivalPoller` — all consistent across tasks.
