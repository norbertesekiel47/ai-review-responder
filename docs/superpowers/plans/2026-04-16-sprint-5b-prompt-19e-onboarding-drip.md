# Sprint 5B Prompt 19e — Onboarding Drip Emails

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an automated onboarding email sequence (day 1, day 7, day 30) that fires after a business's subscription activates, welcoming the owner and proving early value.

**Architecture:** An `OnboardingDripScheduler` (hourly setInterval poller) queries active businesses with `subscription_activated_at IS NOT NULL`, checks which drip emails are due based on elapsed time, and creates `onboarding_drip` outbox entries. An `OnboardingDripWorker` processes each entry — queries stats for the appropriate time period, builds the HTML email, sends via Resend, and inserts into `onboarding_drip_log` (idempotent via UNIQUE constraint ON CONFLICT DO NOTHING). The day_7 drip creates fresh approval links for pending reviews using the shared `createApprovalLink()` helper.

**Tech Stack:** BullMQ, Postgres.js (`sql`), Resend, Vitest.

**Pre-requisite:** Migration `014_retention_expansion.sql` already creates `onboarding_drip_log` table and `businesses.subscription_activated_at` column.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `worker/ingress/stripe.ts` | Set `subscription_activated_at = NOW()` on activation |
| Modify | `src/lib/shared/worker-types.ts` | Add `OnboardingDripPayload` |
| Modify | `worker/queues.ts` | Add `ONBOARDING_DRIP` queue |
| Create | `worker/jobs/OnboardingDripScheduler.ts` | Hourly poller, checks due drips |
| Create | `worker/jobs/OnboardingDripWorker.ts` | Sends drip emails, records in drip log |
| Modify | `src/lib/notifications/email.ts` | Add 3 email templates |
| Modify | `worker/index.ts` | Register worker + scheduler |
| Create | `worker/__tests__/OnboardingDripScheduler.test.ts` | Scheduler tests |
| Create | `worker/__tests__/OnboardingDripWorker.test.ts` | Worker tests |

---

## Task 1: Stripe webhook — set subscription_activated_at

**Files:**
- Modify: `worker/ingress/stripe.ts`

- [ ] **Step 1: Add subscription_activated_at to the checkout.session.completed UPDATE**

In `worker/ingress/stripe.ts`, find the UPDATE statement in the checkout.session.completed handler (around line 50-59). Add `subscription_activated_at` — only set when null so re-activations from past_due don't reset the drip anchor:

Change:
```sql
SET
  subscription_status = 'active',
  stripe_customer_id = ${customerId},
  stripe_subscription_id = ${subscriptionId},
  updated_at = NOW()
```

To:
```sql
SET
  subscription_status = 'active',
  stripe_customer_id = ${customerId},
  stripe_subscription_id = ${subscriptionId},
  subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
  updated_at = NOW()
```

`COALESCE(subscription_activated_at, NOW())` ensures a re-activation from `past_due` → `active` does not reset the drip timing anchor.

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add worker/ingress/stripe.ts
git commit -m "feat(19e): set subscription_activated_at on Stripe checkout activation"
```

---

## Task 2: Add OnboardingDripPayload type + queue registration

**Files:**
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `worker/queues.ts`

- [ ] **Step 1: Add payload type**

Add to `src/lib/shared/worker-types.ts`:

```typescript
export interface OnboardingDripPayload {
  business_id: string;
  drip_type: 'day_1' | 'day_7' | 'day_30';
}
```

- [ ] **Step 2: Add queue name, instance, and topicToQueue entry**

In `worker/queues.ts`:
- Add `ONBOARDING_DRIP: 'onboarding_drip'` to `QUEUE_NAMES`
- Add `onboardingDrip: new Queue(QUEUE_NAMES.ONBOARDING_DRIP, { connection: opts, defaultJobOptions })` to `queues`
- Add `[QUEUE_NAMES.ONBOARDING_DRIP]: queues.onboardingDrip` to `topicToQueue`

- [ ] **Step 3: Verify types compile, commit**

```bash
git add src/lib/shared/worker-types.ts worker/queues.ts
git commit -m "feat(19e): add OnboardingDripPayload type and queue registration"
```

---

## Task 3: Build OnboardingDripScheduler

**Files:**
- Create: `worker/jobs/OnboardingDripScheduler.ts`
- Create: `worker/__tests__/OnboardingDripScheduler.test.ts`

- [ ] **Step 1: Write the scheduler**

Create `worker/jobs/OnboardingDripScheduler.ts` following the WeeklySummaryScheduler pattern:

```typescript
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { OnboardingDripPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[OnboardingDripScheduler]';
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.ONBOARDING_DRIP_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

const DRIP_OFFSETS: Array<{ type: 'day_1' | 'day_7' | 'day_30'; days: number }> = [
  { type: 'day_1', days: 1 },
  { type: 'day_7', days: 7 },
  { type: 'day_30', days: 30 },
];

export async function checkAndSchedule(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    if (isMockMode()) {
      console.log(`${LOG_PREFIX} Mock mode — skipping`);
      return;
    }

    // Find active businesses with a known activation date
    const businesses = await sql<{ id: string; subscription_activated_at: Date }[]>`
      SELECT id, subscription_activated_at
      FROM businesses
      WHERE subscription_status = 'active'
        AND subscription_activated_at IS NOT NULL
    `;

    let queued = 0;
    for (const biz of businesses) {
      const activatedAt = new Date(biz.subscription_activated_at);
      const now = Date.now();

      for (const drip of DRIP_OFFSETS) {
        const dueAfter = activatedAt.getTime() + drip.days * 86_400_000;
        if (now < dueAfter) continue; // Not yet due

        // Check if already sent (drip_log) or already queued (outbox)
        const [alreadySent] = await sql<{ id: string }[]>`
          SELECT id FROM onboarding_drip_log
          WHERE business_id = ${biz.id} AND drip_type = ${drip.type}
          LIMIT 1
        `;
        if (alreadySent) continue;

        const [alreadyQueued] = await sql<{ id: string }[]>`
          SELECT id FROM job_outbox
          WHERE topic = 'onboarding_drip'
            AND aggregate_id = ${biz.id}
            AND status IN ('pending', 'dispatched')
            AND payload->>'drip_type' = ${drip.type}
          LIMIT 1
        `;
        if (alreadyQueued) continue;

        const payload: OnboardingDripPayload = {
          business_id: biz.id,
          drip_type: drip.type,
        };

        try {
          await sql`
            INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
            VALUES (${uuidv7()}, 'onboarding_drip', 'business', ${biz.id},
                    ${JSON.stringify(payload)}::jsonb, 'pending')
          `;
          queued++;
        } catch (err: unknown) {
          if ((err as { code?: string }).code === '23505') continue;
          throw err;
        }
      }
    }

    if (queued > 0) {
      console.log(`${LOG_PREFIX} Queued ${queued} onboarding drip emails`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error:`, error);
  } finally {
    isPolling = false;
  }
}

export function startOnboardingDripScheduler(): void {
  if (pollerInterval) return;
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  checkAndSchedule().catch(console.error);
  pollerInterval = setInterval(() => {
    checkAndSchedule().catch(console.error);
  }, intervalMs);
}

export function stopOnboardingDripScheduler(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
```

- [ ] **Step 2: Write tests**

Create `worker/__tests__/OnboardingDripScheduler.test.ts` with mocked `sql` and `isMockMode`. Test:
- Skips in mock mode
- Skips businesses without subscription_activated_at (query filters them)
- Queues day_1 when 1+ days have passed and no drip_log entry exists
- Skips day_7 when only 3 days have passed
- Skips when drip_log entry already exists
- Skips when outbox entry already pending
- Queues multiple drips for same business when due (day_1 + day_7 both due)

- [ ] **Step 3: Run tests, commit**

```bash
git add worker/jobs/OnboardingDripScheduler.ts worker/__tests__/OnboardingDripScheduler.test.ts
git commit -m "feat(19e): OnboardingDripScheduler — hourly poller for day 1/7/30 drip emails"
```

---

## Task 4: Build email templates

**Files:**
- Modify: `src/lib/notifications/email.ts`

- [ ] **Step 1: Add buildOnboardingDay1Html**

Append to `src/lib/notifications/email.ts`:

```typescript
// ── Onboarding Drip: Day 1 — Welcome ────────────────────────────────

export interface OnboardingDay1Params {
  businessName: string;
  ownerName: string;
  dashboardUrl: string | null; // null if owner has no auth mapping
}

export function buildOnboardingDay1Html(params: OnboardingDay1Params): string {
  const safeName = escapeHtml(params.ownerName);
  const safeBiz = escapeHtml(params.businessName);
  const dashboardLink = params.dashboardUrl
    ? `<p style="margin:16px 0;"><a href="${params.dashboardUrl}" style="...">View your dashboard</a></p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <h1 style="margin:0 0 16px;font-size:24px;color:#111827;">Welcome to RepWorth, ${safeName}!</h1>
    <p style="margin:0 0 12px;font-size:16px;color:#374151;">We are now monitoring reviews for <strong>${safeBiz}</strong>.</p>
    <h2 style="margin:24px 0 8px;font-size:18px;color:#111827;">How it works</h2>
    <ol style="margin:0 0 16px;padding-left:20px;font-size:14px;color:#374151;line-height:1.6;">
      <li>A new review comes in — we draft a response</li>
      <li>You get an email with the draft — tap <strong>Approve</strong>, <strong>Edit</strong>, or <strong>Regenerate</strong></li>
      <li>We post your approved response to Google</li>
    </ol>
    <p style="margin:0 0 12px;font-size:14px;color:#374151;">Each approval takes about <strong>30 seconds</strong>. You will also receive a weekly value report every Monday.</p>
    ${dashboardLink}
    <p style="margin:24px 0 0;font-size:14px;color:#6b7280;">If you have questions, just reply to this email.</p>
  </div>
</body>
</html>`;
}
```

- [ ] **Step 2: Add buildOnboardingDay7Html**

```typescript
// ── Onboarding Drip: Day 7 — First Week Recap ──────────────────────

export interface OnboardingDay7Params {
  businessName: string;
  ownerName: string;
  reviewsHandled: number;
  timeSavedMinutes: number;
  responseRate: number; // 0-100
  highlightReview: { reviewerName: string; starRating: number; reviewText: string; responseText: string } | null;
  hasEdits: boolean;
  pendingReviews: Array<{ reviewerName: string; starRating: number | null; approvalUrl: string }>;
}

export function buildOnboardingDay7Html(params: OnboardingDay7Params): string {
  // Build HTML showing first week stats, optional highlight review,
  // edit acknowledgment, and pending review links
  // ... full implementation with escapeHtml on all user content
}
```

- [ ] **Step 3: Add buildOnboardingDay30Html**

```typescript
// ── Onboarding Drip: Day 30 — First Month Impact ────────────────────

export interface OnboardingDay30Params {
  businessName: string;
  ownerName: string;
  totalReviews: number;
  responseRateBefore: number | null;
  responseRateNow: number;
  timeSavedMinutes: number;
  rankingChange: { keyword: string; from: number; to: number } | null;
  salesPartnerName: string | null;
}

export function buildOnboardingDay30Html(params: OnboardingDay30Params): string {
  // Build HTML showing full month milestone stats,
  // ranking change if available, sign-off with sales partner name
  // ... full implementation with escapeHtml on all user content
}
```

- [ ] **Step 4: Verify types compile, commit**

```bash
git add src/lib/notifications/email.ts
git commit -m "feat(19e): onboarding drip email templates — day 1, day 7, day 30"
```

---

## Task 5: Build OnboardingDripWorker

**Files:**
- Create: `worker/jobs/OnboardingDripWorker.ts`
- Create: `worker/__tests__/OnboardingDripWorker.test.ts`

- [ ] **Step 1: Write the worker**

Create `worker/jobs/OnboardingDripWorker.ts`:

The worker handler must:
1. Load business (subscription guard — only `active`)
2. Check if owner has auth mapping (for dashboard URL):
   ```sql
   SELECT id FROM users WHERE business_id = ${businessId} AND role = 'owner' AND auth_id IS NOT NULL LIMIT 1
   ```
3. Branch on `drip_type`:

   **day_1**: Query owner_name, business name. Build `buildOnboardingDay1Html(...)`. Send. Record drip log.

   **day_7**: Query stats for the first 7 days since activation:
   - Total reviews handled (responses with status in approved/edited/posted/awaiting_manual_post created within 7 days of activation)
   - Time saved (reviews × 7 min)
   - Response rate (responded / total reviews)
   - Highlight: one approved+posted response with longest review text
   - Has edits: any response with edited_text IS NOT NULL
   - Pending reviews: up to 5 pending responses — for each, call `createApprovalLink({ responseId, businessId, revokeMode: 'orphaned_only' })` to create fresh approval links
   Build `buildOnboardingDay7Html(...)`. Send. Record drip log.

   **day_30**: Query full month stats:
   - Total reviews, response rate before (from baseline) vs now
   - Time saved
   - Ranking change (latest vs earliest ranking_snapshot if exists)
   - Sales partner name from users table
   Build `buildOnboardingDay30Html(...)`. Send. Record drip log.

4. Record to `onboarding_drip_log`:
   ```sql
   INSERT INTO onboarding_drip_log (id, business_id, drip_type)
   VALUES (${uuidv7()}, ${businessId}, ${dripType})
   ON CONFLICT (business_id, drip_type) DO NOTHING
   ```
   If ON CONFLICT hits (already sent), complete outbox without sending.

5. Record notification delivery with template `onboarding_drip_day_1` etc.

6. Mark outbox completed.

- [ ] **Step 2: Write tests**

Test cases:
- day_1: sends welcome email with dashboard URL when owner has auth
- day_1: sends without dashboard URL when no auth
- day_7: sends recap with stats and highlight review
- day_7: creates approval links for pending reviews
- day_7: skips approval links when no pending reviews
- day_30: sends impact email with ranking change when data exists
- day_30: sends without ranking when no data
- Skips when drip_log entry already exists (ON CONFLICT)
- Skips when subscription is not active
- Marks outbox failed when business not found

- [ ] **Step 3: Run tests, commit**

```bash
git add worker/jobs/OnboardingDripWorker.ts worker/__tests__/OnboardingDripWorker.test.ts
git commit -m "feat(19e): OnboardingDripWorker — day 1/7/30 email logic with stats queries"
```

---

## Task 6: Register in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add imports**

```typescript
import { startOnboardingDripScheduler, stopOnboardingDripScheduler } from './jobs/OnboardingDripScheduler';
import { handleOnboardingDrip } from './jobs/OnboardingDripWorker';
```

- [ ] **Step 2: Add worker instance**

```typescript
const onboardingDripWorker = new Worker(QUEUE_NAMES.ONBOARDING_DRIP, handleOnboardingDrip, workerOpts);
```

Add to `workers` array.

- [ ] **Step 3: Add scheduler start/stop**

In `main()`: `startOnboardingDripScheduler();`
In `shutdown()`: `stopOnboardingDripScheduler();`

- [ ] **Step 4: Verify types compile, run full test suite, commit**

```bash
git add worker/index.ts
git commit -m "feat(19e): register OnboardingDripScheduler + Worker"
```

---

## Task 7: Run full test suite + update tracking

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Update CLAUDE.md and progresstracking.md**
