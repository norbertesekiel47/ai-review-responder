# Sprint 5B Prompt 19g — Satisfaction Pulse

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a satisfaction pulse to the weekly value report email — three HMAC-signed links (Great / OK / Not great) that let the business owner rate their experience without logging in. "Not great" triggers a partner alert via the existing `partner_satisfaction_alert` pipeline.

**Architecture:** HMAC-signed links in the weekly email point to `GET /api/feedback` which validates the signature and renders a confirmation page (no DB write — scanner-safe). The confirmation page POSTs back with hidden signed fields. `POST /api/feedback` validates HMAC again, upserts `satisfaction_responses` in a single transaction, and if rating is `not_great`, inserts an `engagement_alert` outbox entry in the same transaction (transactional outbox invariant). Redirects to `/feedback/thanks`. The `EngagementAlertWorker` already handles `partner_satisfaction_alert` — no worker changes needed.

**Tech Stack:** Next.js App Router, HMAC-SHA256 (node:crypto), Postgres.js (`sql`), Vitest.

**Pre-requisite:** Migration `014_retention_expansion.sql` already creates `satisfaction_responses` table. The `partner_satisfaction_alert` handler in `EngagementAlertWorker` is already implemented.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/shared/feedback-hmac.ts` | HMAC sign/verify for feedback links |
| Create | `src/app/api/feedback/route.ts` | GET (render confirmation) + POST (upsert + outbox) |
| Create | `src/app/(public)/feedback/thanks/page.tsx` | Static thank-you page after POST redirect |
| Modify | `src/lib/notifications/email.ts` | Add satisfaction pulse links to `buildWeeklyValueReportHtml` |
| Modify | `worker/jobs/WeeklySummaryWorker.ts` | Pass feedback URLs to the template |
| Create | `src/app/api/feedback/__tests__/route.test.ts` | Feedback route tests |
| Create | `src/lib/shared/__tests__/feedback-hmac.test.ts` | HMAC sign/verify tests |

---

## Task 1: HMAC sign/verify helper

**Files:**
- Create: `src/lib/shared/feedback-hmac.ts`
- Create: `src/lib/shared/__tests__/feedback-hmac.test.ts`

- [ ] **Step 1: Write the HMAC helper**

Create `src/lib/shared/feedback-hmac.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function getSecret(): string {
  const secret = process.env.CSRF_SECRET;
  if (!secret) throw new Error('CSRF_SECRET not configured');
  return secret;
}

/**
 * Sign feedback link params with HMAC-SHA256.
 * Input: business_id + rating + week_start_date concatenated with '|'.
 */
export function signFeedback(businessId: string, rating: string, weekStartDate: string): string {
  return createHmac('sha256', getSecret())
    .update(`${businessId}|${rating}|${weekStartDate}`)
    .digest('hex');
}

/**
 * Verify feedback HMAC. Uses constant-time comparison.
 */
export function verifyFeedback(businessId: string, rating: string, weekStartDate: string, sig: string): boolean {
  const expected = signFeedback(businessId, rating, weekStartDate);
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/**
 * Build a signed feedback URL for the weekly email.
 */
export function buildFeedbackUrl(
  appUrl: string,
  businessId: string,
  rating: 'great' | 'ok' | 'not_great',
  weekStartDate: string,
): string {
  const sig = signFeedback(businessId, rating, weekStartDate);
  const params = new URLSearchParams({
    business_id: businessId,
    rating,
    week: weekStartDate,
    sig,
  });
  return `${appUrl}/api/feedback?${params.toString()}`;
}
```

- [ ] **Step 2: Write tests**

Create `src/lib/shared/__tests__/feedback-hmac.test.ts`:

Tests:
- `signFeedback` returns consistent hex string for same inputs
- `verifyFeedback` returns true for valid sig
- `verifyFeedback` returns false for tampered rating
- `verifyFeedback` returns false for tampered business_id
- `verifyFeedback` returns false for tampered week
- `verifyFeedback` returns false for wrong-length sig
- `buildFeedbackUrl` includes all params and valid sig

- [ ] **Step 3: Run tests, commit**

```bash
git add src/lib/shared/feedback-hmac.ts src/lib/shared/__tests__/feedback-hmac.test.ts
git commit -m "feat(19g): HMAC sign/verify helper for satisfaction pulse feedback links"
```

---

## Task 2: Feedback API route (GET + POST)

**Files:**
- Create: `src/app/api/feedback/route.ts`
- Create: `src/app/api/feedback/__tests__/route.test.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/feedback/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { verifyFeedback } from '@/lib/shared/feedback-hmac';
import type { EngagementAlertPayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

const VALID_RATINGS = ['great', 'ok', 'not_great'] as const;

/**
 * GET /api/feedback — scanner-safe confirmation page.
 * Validates HMAC, renders lightweight HTML with a form that POSTs back.
 * NEVER writes to the database (email scanners prefetch GET URLs).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get('business_id');
  const rating = searchParams.get('rating');
  const week = searchParams.get('week');
  const sig = searchParams.get('sig');

  if (!businessId || !rating || !week || !sig) {
    return new NextResponse('Missing parameters', { status: 400 });
  }

  if (!VALID_RATINGS.includes(rating as typeof VALID_RATINGS[number])) {
    return new NextResponse('Invalid rating', { status: 400 });
  }

  if (!verifyFeedback(businessId, rating, week, sig)) {
    return new NextResponse('Invalid signature', { status: 400 });
  }

  // Validate week is a real date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return new NextResponse('Invalid date', { status: 400 });
  }

  const ratingLabel = rating === 'not_great' ? 'Not great' : rating === 'ok' ? 'OK' : 'Great';
  const showComment = rating === 'not_great';

  // Render lightweight confirmation page — NO DB write
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Feedback — RepWorth</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <div style="max-width:480px;margin:40px auto;padding:24px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <h1 style="font-size:20px;color:#111;margin:0 0 8px;">Confirm your feedback</h1>
    <p style="font-size:14px;color:#374151;margin:0 0 20px;">You selected: <strong>${ratingLabel}</strong></p>
    <form method="POST" action="/api/feedback">
      <input type="hidden" name="business_id" value="${businessId}">
      <input type="hidden" name="rating" value="${rating}">
      <input type="hidden" name="week" value="${week}">
      <input type="hidden" name="sig" value="${sig}">
      ${showComment ? `
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:14px;color:#374151;margin-bottom:4px;">Anything you'd like us to know? (optional)</label>
        <textarea name="comment" rows="3" maxlength="1000" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:8px;font-size:14px;font-family:inherit;resize:vertical;" placeholder="Tell us what could be better..."></textarea>
      </div>` : ''}
      <button type="submit" style="display:block;width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:16px;font-weight:600;cursor:pointer;">Submit Feedback</button>
    </form>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private' },
  });
}

/**
 * POST /api/feedback — upserts satisfaction_responses + optional outbox entry.
 * Validates HMAC again (form fields could be tampered).
 * Single sql.begin() transaction for state change + outbox (transactional outbox invariant).
 * Redirects to /feedback/thanks after commit.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  const businessId = formData.get('business_id') as string | null;
  const rating = formData.get('rating') as string | null;
  const week = formData.get('week') as string | null;
  const sig = formData.get('sig') as string | null;
  const comment = (formData.get('comment') as string | null)?.trim() || null;

  if (!businessId || !rating || !week || !sig) {
    return new NextResponse('Missing parameters', { status: 400 });
  }

  if (!VALID_RATINGS.includes(rating as typeof VALID_RATINGS[number])) {
    return new NextResponse('Invalid rating', { status: 400 });
  }

  if (!verifyFeedback(businessId, rating, week, sig)) {
    return new NextResponse('Invalid signature', { status: 400 });
  }

  // Single transaction: upsert satisfaction_responses + optional engagement_alert outbox
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO satisfaction_responses (id, business_id, week_start_date, rating, comment)
      VALUES (${uuidv7()}, ${businessId}, ${week}::date, ${rating}, ${comment})
      ON CONFLICT (business_id, week_start_date)
      DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment
    `;

    if (rating === 'not_great') {
      const payload: EngagementAlertPayload = {
        business_id: businessId,
        alert_type: 'partner_satisfaction_alert',
        satisfaction: {
          rating: 'not_great',
          comment,
          week_start_date: week,
        },
      };

      // Cooldown dedup: one partner_satisfaction_alert per business per week
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        SELECT ${uuidv7()}, 'engagement_alert', 'business', ${businessId},
               ${JSON.stringify(payload)}::jsonb, 'pending'
        WHERE NOT EXISTS (
          SELECT 1 FROM job_outbox
          WHERE topic = 'engagement_alert'
            AND aggregate_id = ${businessId}
            AND status <> 'failed'
            AND payload->>'alert_type' = 'partner_satisfaction_alert'
            AND payload->'satisfaction'->>'week_start_date' = ${week}
        )
      `;
    }
  });

  // Redirect to thank-you page
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  return NextResponse.redirect(`${appUrl}/feedback/thanks`, { status: 303 });
}
```

- [ ] **Step 2: Write tests**

Create `src/app/api/feedback/__tests__/route.test.ts`:

Tests:
- GET with valid signature returns 200 HTML with confirmation form
- GET with invalid signature returns 400
- GET with missing params returns 400
- GET does NOT call sql (no DB write)
- POST with valid signature upserts exactly one row (check sql.begin was called)
- POST with duplicate week updates existing row (ON CONFLICT DO UPDATE)
- POST with rating=not_great creates engagement_alert outbox entry in same transaction
- POST with rating=great does NOT create outbox entry
- POST with invalid signature returns 400
- POST redirects to /feedback/thanks (303)

- [ ] **Step 3: Run tests, commit**

```bash
git add src/app/api/feedback/ src/app/api/feedback/__tests__/
git commit -m "feat(19g): GET + POST /api/feedback — scanner-safe satisfaction pulse with HMAC"
```

---

## Task 3: Thank-you page

**Files:**
- Create: `src/app/(public)/feedback/thanks/page.tsx`

- [ ] **Step 1: Create the static page**

Create `src/app/(public)/feedback/thanks/page.tsx`:

```typescript
export default function FeedbackThanksPage() {
  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <h1 style={{ fontSize: 24, color: '#111827', marginBottom: 8 }}>Thank you!</h1>
      <p style={{ fontSize: 16, color: '#374151' }}>Your feedback has been recorded. We appreciate it.</p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/(public)/feedback/"
git commit -m "feat(19g): /feedback/thanks static page"
```

---

## Task 4: Add satisfaction pulse links to weekly email template

**Files:**
- Modify: `src/lib/notifications/email.ts` — `WeeklyValueReportParams` + `buildWeeklyValueReportHtml`
- Modify: `worker/jobs/WeeklySummaryWorker.ts` — pass feedback URLs

- [ ] **Step 1: Extend WeeklyValueReportParams**

In `src/lib/notifications/email.ts`, find the `WeeklyValueReportParams` interface and add:

```typescript
/** HMAC-signed feedback URLs for satisfaction pulse. null if CSRF_SECRET not configured. */
feedbackUrls: {
  great: string;
  ok: string;
  notGreat: string;
} | null;
```

- [ ] **Step 2: Add satisfaction pulse section to the template**

In `buildWeeklyValueReportHtml`, add a new section BEFORE the footer ("Powered by RepWorth") but AFTER the dashboard link section. Only render when `params.feedbackUrls` is not null:

```html
<!-- Satisfaction Pulse -->
<tr><td style="padding:16px 24px 0;">
  <p style="margin:0 0 12px;font-size:14px;color:#374151;text-align:center;">How was your experience this week?</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" width="33%" style="padding:0 4px;">
        <a href="${feedbackUrls.great}" style="display:block;padding:10px;background:#d1fae5;color:#065f46;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;text-align:center;">Great</a>
      </td>
      <td align="center" width="33%" style="padding:0 4px;">
        <a href="${feedbackUrls.ok}" style="display:block;padding:10px;background:#fef3c7;color:#92400e;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;text-align:center;">OK</a>
      </td>
      <td align="center" width="33%" style="padding:0 4px;">
        <a href="${feedbackUrls.notGreat}" style="display:block;padding:10px;background:#fee2e2;color:#991b1b;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;text-align:center;">Not great</a>
      </td>
    </tr>
  </table>
</td></tr>
```

- [ ] **Step 3: Pass feedback URLs from WeeklySummaryWorker**

In `worker/jobs/WeeklySummaryWorker.ts`, import `buildFeedbackUrl` from `@/lib/shared/feedback-hmac` and build the URLs before calling `buildWeeklyValueReportHtml`:

```typescript
import { buildFeedbackUrl } from '../../src/lib/shared/feedback-hmac';

// Inside the handler, before building HTML:
let feedbackUrls: { great: string; ok: string; notGreat: string } | null = null;
const appUrl = process.env.NEXT_PUBLIC_APP_URL;
if (appUrl && process.env.CSRF_SECRET) {
  feedbackUrls = {
    great: buildFeedbackUrl(appUrl, business_id, 'great', week_start_date),
    ok: buildFeedbackUrl(appUrl, business_id, 'ok', week_start_date),
    notGreat: buildFeedbackUrl(appUrl, business_id, 'not_great', week_start_date),
  };
}

// Pass to template:
const html = buildWeeklyValueReportHtml({
  ...existingParams,
  feedbackUrls,
});
```

- [ ] **Step 4: Verify types compile, run tests, commit**

```bash
git add src/lib/notifications/email.ts worker/jobs/WeeklySummaryWorker.ts
git commit -m "feat(19g): add satisfaction pulse links to weekly value report email"
```

---

## Task 5: Run full test suite + update tracking

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Update CLAUDE.md and progresstracking.md**

- [ ] **Step 4: Commit tracking docs**
