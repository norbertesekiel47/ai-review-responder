# Sprint 5A Prompt 19d — Engagement Detection & Re-engagement System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a three-layer engagement system: daily metrics computation (EngagementMonitorPoller), automated owner nudge emails with fresh approval links, and sales partner escalation alerts — all following existing outbox/worker patterns.

**Architecture:** A daily `setInterval` poller computes engagement metrics via a single grouped SQL query across all active businesses, applies 4 engagement rules with cooldown dedup, and creates `engagement_alert` outbox entries. An EngagementAlertWorker processes these entries — owner_nudge alerts generate fresh approval links (same pattern as NotificationWorker) and send review-list emails; partner alerts send internal emails to the admin. No new database tables — uses existing `notification_deliveries` for cooldown dedup and `approval_links` for token management.

**Tech Stack:** BullMQ workers, Postgres.js, Resend (email), existing outbox pattern, existing approval link infrastructure

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `src/lib/shared/worker-types.ts` | Add `EngagementAlertPayload` interface |
| Modify | `worker/queues.ts` | Add `ENGAGEMENT_ALERT` queue name, instance, topic mapping |
| Create | `worker/jobs/EngagementMonitorPoller.ts` | Daily poller — grouped metrics query, engagement rules, cooldown dedup, outbox creation |
| Create | `worker/jobs/__tests__/EngagementMonitorPoller.test.ts` | Tests for metrics computation and rule application |
| Create | `src/lib/approval/create-link.ts` | Extracted approval link creation logic (shared by NotificationWorker + EngagementAlertWorker) |
| Modify | `worker/jobs/NotificationWorker.ts` | Refactor to use extracted `createApprovalLink()` |
| Create | `worker/jobs/EngagementAlertWorker.ts` | Processes engagement_alert outbox entries — routes to correct email template |
| Create | `worker/jobs/__tests__/EngagementAlertWorker.test.ts` | Tests for all 4 alert types |
| Modify | `src/lib/notifications/email.ts` | Add 4 email template builders |
| Create | `src/lib/notifications/__tests__/engagement-email-templates.test.ts` | Tests for engagement email templates |
| Modify | `worker/index.ts` | Register worker + poller |

---

## Task 1: Add EngagementAlertPayload + Queue Registration

**Files:**
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `worker/queues.ts`

- [ ] **Step 1: Add payload type**

Append to `src/lib/shared/worker-types.ts`:

```typescript
export type EngagementAlertType =
  | 'owner_nudge'
  | 'partner_engagement_alert'
  | 'partner_escalation_alert'
  | 'partner_low_engagement';

export interface EngagementAlertPayload {
  business_id: string;
  alert_type: EngagementAlertType;
  metrics: {
    days_since_approval: number | null;
    oldest_pending_age_days: number | null;
    pending_count: number;
    approval_rate: number | null;
    notified_count: number;
  };
}
```

- [ ] **Step 2: Add queue registration**

In `worker/queues.ts`:

Add to `QUEUE_NAMES`: `ENGAGEMENT_ALERT: 'engagement_alert',`

Add to `queues`: `engagementAlert: new Queue(QUEUE_NAMES.ENGAGEMENT_ALERT, { connection: opts, defaultJobOptions }),`

Add to `topicToQueue`: `[QUEUE_NAMES.ENGAGEMENT_ALERT]: queues.engagementAlert,`

- [ ] **Step 3: Verify compilation + commit**

```bash
npx tsc --noEmit && pnpm test
git commit -m "feat(5a): add EngagementAlertPayload and queue registration"
```

---

## Task 2: Extract Approval Link Creation from NotificationWorker

**Files:**
- Create: `src/lib/approval/create-link.ts`
- Modify: `worker/jobs/NotificationWorker.ts`

The owner_nudge alert needs to create fresh approval links for each pending review. NotificationWorker already has this logic (lines 127-158). Extract it into a shared function so both workers can use it.

- [ ] **Step 1: Create `src/lib/approval/create-link.ts`**

```typescript
import { randomUUID, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';

/**
 * Creates a fresh approval link for a response.
 * - Revokes existing open links if no delivery record exists (orphaned from crash)
 * - Generates a random token, stores only the SHA-256 hash in DB
 * - Returns the raw token (caller must use it immediately in a URL and never persist it)
 */
export async function createApprovalLink(params: {
  responseId: string;
  businessId: string;
}): Promise<{ rawToken: string; tokenHash: string }> {
  const { responseId, businessId } = params;
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const [existingDelivery] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE response_id = ${responseId} AND template = 'approval_request' AND sent_at IS NOT NULL
    LIMIT 1
  `;

  await sql.begin(async (tx) => {
    if (!existingDelivery) {
      await tx`
        UPDATE approval_links SET revoked_at = NOW()
        WHERE response_id = ${responseId}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > NOW()
      `;
    }

    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
      VALUES (
        ${uuidv7()}, ${responseId}, ${businessId}, ${tokenHash}, 'email',
        NOW() + INTERVAL '48 hours'
      )
    `;
  });

  return { rawToken, tokenHash };
}
```

- [ ] **Step 2: Refactor NotificationWorker to use `createApprovalLink()`**

In `worker/jobs/NotificationWorker.ts`, replace lines 127-158 (token generation + link creation) with:

```typescript
import { createApprovalLink } from '../../src/lib/approval/create-link';

// Replace the manual token gen + sql.begin block with:
const { rawToken } = await createApprovalLink({
  responseId: response_id,
  businessId: business_id,
});
```

Remove the now-unused imports: `randomUUID`, `createHash` from `node:crypto` (if no other usage remains in the file).

- [ ] **Step 3: Verify all tests still pass + commit**

```bash
pnpm test
git commit -m "refactor(5a): extract createApprovalLink for reuse by engagement alerts"
```

---

## Task 3: Engagement Email Templates

**Files:**
- Modify: `src/lib/notifications/email.ts`
- Create: `src/lib/notifications/__tests__/engagement-email-templates.test.ts`

Add 4 email template builders. The owner_nudge template is customer-facing (same styling as approval email). The 3 partner templates are internal (plainer styling).

- [ ] **Step 1: Write tests**

Create `src/lib/notifications/__tests__/engagement-email-templates.test.ts` with tests covering:

- `buildOwnerNudgeEmailHtml`: contains pending review count, star ratings, reviewer names, approval links, friendly tone
- `buildPartnerEngagementAlertHtml`: contains business name, days since approval, pending count, owner contact info
- `buildPartnerEscalationAlertHtml`: contains urgency framing ("at risk"), same metrics, stronger call to action
- `buildPartnerLowEngagementAlertHtml`: contains approval rate percentage, pending count
- All templates escape HTML in user content

- [ ] **Step 2: Implement templates**

Add to `src/lib/notifications/email.ts`:

**`buildOwnerNudgeEmailHtml(params)`** — customer-facing:
- Params: `{ businessName, pendingReviews: Array<{ reviewerName, starRating, reviewText, approvalUrl }> }`
- Subject line: "You have X reviews waiting for your approval"
- Lists each pending review with stars, reviewer, truncated text (50 chars), and "Review & Approve →" link
- Friendly tone, not naggy
- Same email chrome as approval email (600px card, white bg, etc.)

**`buildPartnerEngagementAlertHtml(params)`** — internal:
- Params: `{ businessName, daysSinceApproval, pendingCount, approvalRate, ownerEmail, ownerPhone }`
- "Customer [name] hasn't engaged in [N] days"
- Suggested action: "Consider sending a check-in message"

**`buildPartnerEscalationAlertHtml(params)`** — internal with red accent:
- Same params as engagement alert
- "Customer [name] may be at risk — no engagement in 2+ weeks"
- Suggested action: "Recommend a personal phone call or visit"
- Red/urgent accent color on header

**`buildPartnerLowEngagementAlertHtml(params)`** — internal with amber accent:
- Params: `{ businessName, approvalRate, pendingCount, ownerEmail, ownerPhone }`
- "Customer [name] approval rate dropped to X%"
- Amber accent on header

- [ ] **Step 3: Run tests + commit**

```bash
pnpm test -- src/lib/notifications/__tests__/engagement-email-templates.test.ts
git commit -m "feat(5a): add 4 engagement email templates"
```

---

## Task 4: EngagementMonitorPoller

**Files:**
- Create: `worker/jobs/EngagementMonitorPoller.ts`
- Create: `worker/jobs/__tests__/EngagementMonitorPoller.test.ts`

Daily poller that computes engagement metrics for all active businesses in ONE grouped query and applies 4 engagement rules with cooldown dedup.

- [ ] **Step 1: Write tests**

Create `worker/jobs/__tests__/EngagementMonitorPoller.test.ts` testing:

- Skips when isPolling is true (re-entrancy guard)
- Computes metrics for active businesses only
- Fires `owner_nudge` when activity_age >= 3 days AND pending > 0
- Fires `partner_engagement_alert` when activity_age >= 7 AND pending > 0
- Fires `partner_escalation_alert` when activity_age >= 14 AND (pending > 0 OR notified_count > 0)
- Fires `partner_low_engagement` when approval_rate < 50% AND notified_count >= 3
- Respects cooldown periods (skips if recent delivery exists)
- Does not fire when activity_age is null (no approvals AND no pending)
- Does not fire low_engagement when notified_count < 3 (insufficient sample size)
- Uses `activity_age_days = days_since_approval ?? oldest_pending_age_days`

- [ ] **Step 2: Implement EngagementMonitorPoller**

Create `worker/jobs/EngagementMonitorPoller.ts`:

```typescript
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import type { EngagementAlertPayload, EngagementAlertType } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[EngagementMonitorPoller]';
const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

// Cooldown periods in days per alert type
const COOLDOWNS: Record<EngagementAlertType, number> = {
  owner_nudge: 3,
  partner_engagement_alert: 7,
  partner_escalation_alert: 14,
  partner_low_engagement: 7,
};
```

The main `runEngagementCheck()` function:

1. Single grouped query across all active businesses:
```sql
SELECT
  b.id AS business_id,
  -- Days since last approval
  EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(resp.approved_at))::int
    FILTER (WHERE resp.status IN ('approved','edited','posted','awaiting_manual_post'))
    AS days_since_approval,
  -- Pending count
  COUNT(*) FILTER (WHERE resp.status = 'pending_approval')::int AS pending_count,
  -- Oldest pending age
  EXTRACT(DAY FROM CURRENT_TIMESTAMP - MIN(resp.created_at))::int
    FILTER (WHERE resp.status = 'pending_approval')
    AS oldest_pending_age_days,
  -- 30-day notified count (distinct responses with approval_request delivery)
  (SELECT COUNT(DISTINCT nd.response_id)
   FROM notification_deliveries nd
   WHERE nd.business_id = b.id
     AND nd.template = 'approval_request'
     AND nd.sent_at IS NOT NULL
     AND nd.sent_at >= CURRENT_DATE - 30
  )::int AS notified_count,
  -- 30-day approved count (of those notified)
  (SELECT COUNT(DISTINCT nd.response_id)
   FROM notification_deliveries nd
   JOIN responses r2 ON r2.id = nd.response_id
   WHERE nd.business_id = b.id
     AND nd.template = 'approval_request'
     AND nd.sent_at IS NOT NULL
     AND nd.sent_at >= CURRENT_DATE - 30
     AND r2.status IN ('approved','edited','posted','awaiting_manual_post')
  )::int AS approved_count
FROM businesses b
LEFT JOIN responses resp ON resp.business_id = b.id
WHERE b.subscription_status = 'active'
GROUP BY b.id
```

2. For each business row, compute:
   - `approval_rate = notified_count > 0 ? Math.round((approved_count / notified_count) * 100) : null`
   - `activity_age_days = days_since_approval ?? oldest_pending_age_days`

3. Apply rules (in priority order — a business can trigger multiple alerts per cycle):
   - `owner_nudge`: `activity_age_days >= 3 && pending_count > 0`
   - `partner_engagement_alert`: `activity_age_days >= 7 && pending_count > 0`
   - `partner_escalation_alert`: `activity_age_days >= 14 && (pending_count > 0 || notified_count > 0)`
   - `partner_low_engagement`: `approval_rate !== null && approval_rate < 50 && notified_count >= 3`

4. For each triggered rule, check cooldown via notification_deliveries:
```sql
SELECT 1 FROM notification_deliveries
WHERE business_id = $1
  AND template = $alertType
  AND sent_at > CURRENT_DATE - $cooldownDays * INTERVAL '1 day'
LIMIT 1
```
If a row exists, skip (cooldown active).

5. Create outbox entry:
```sql
INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
VALUES ($id, 'engagement_alert', 'business', $businessId, $payload::jsonb, 'pending')
```

- [ ] **Step 3: Run tests + commit**

```bash
pnpm test
git commit -m "feat(5a): add EngagementMonitorPoller with daily metrics and engagement rules"
```

---

## Task 5: EngagementAlertWorker

**Files:**
- Create: `worker/jobs/EngagementAlertWorker.ts`
- Create: `worker/jobs/__tests__/EngagementAlertWorker.test.ts`

Processes `engagement_alert` outbox entries. Routes to the correct email template based on `alert_type`. The `owner_nudge` type generates fresh approval links for each pending review.

- [ ] **Step 1: Write tests**

Create tests covering:
- `owner_nudge`: loads pending reviews, creates approval links, sends nudge email to owner, records delivery
- `partner_engagement_alert`: sends internal email to admin with business metrics
- `partner_escalation_alert`: sends escalation email to admin
- `partner_low_engagement`: sends low-engagement email to admin
- Skips if business not found → markOutboxFailed
- Skips if subscription not allowed → markOutboxCompleted
- Records notification delivery for all alert types

- [ ] **Step 2: Implement EngagementAlertWorker**

Create `worker/jobs/EngagementAlertWorker.ts`:

```typescript
import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendInternalEmail, buildOwnerNudgeEmailHtml, buildPartnerEngagementAlertHtml, buildPartnerEscalationAlertHtml, buildPartnerLowEngagementAlertHtml } from '../../src/lib/notifications/email';
import { sendApprovalEmail } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { createApprovalLink } from '../../src/lib/approval/create-link';
import type { EngagementAlertPayload } from '../../src/lib/shared/worker-types';
```

Handler logic by alert_type:

**`owner_nudge`:**
1. Load business (owner_email, name)
2. Subscription guard (workerType='notification')
3. Query pending reviews: `SELECT id, reviewer_name, star_rating, review_text FROM reviews r JOIN responses resp ON resp.review_id = r.id WHERE resp.business_id = $1 AND resp.status = 'pending_approval' ORDER BY resp.created_at ASC LIMIT 10`
4. For each pending review, call `createApprovalLink({ responseId, businessId })`
5. Build pending review list with approval URLs
6. Send email via `sendInternalEmail()` with `buildOwnerNudgeEmailHtml()`
7. Record delivery with template='owner_nudge'

**`partner_engagement_alert` / `partner_escalation_alert` / `partner_low_engagement`:**
1. Load business (name, owner_email, owner_phone)
2. Subscription guard (workerType='notification')
3. Get admin email: `ADMIN_NOTIFICATION_EMAIL` env var
4. Build email from corresponding template using metrics from payload
5. Send via `sendInternalEmail()`
6. Record delivery with template matching alert_type

- [ ] **Step 3: Run tests + commit**

```bash
pnpm test
git commit -m "feat(5a): add EngagementAlertWorker with owner nudge and partner alerts"
```

---

## Task 6: Register in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add imports**

```typescript
import { handleEngagementAlert } from './jobs/EngagementAlertWorker';
import { startEngagementMonitorPoller, stopEngagementMonitorPoller } from './jobs/EngagementMonitorPoller';
```

- [ ] **Step 2: Create worker + add to array**

```typescript
const engagementAlertWorker = new Worker(QUEUE_NAMES.ENGAGEMENT_ALERT, handleEngagementAlert, workerOpts);
```

Add `engagementAlertWorker` to the `workers` array.

- [ ] **Step 3: Start/stop poller in lifecycle**

In `main()`: `startEngagementMonitorPoller();`
In `shutdown()`: `stopEngagementMonitorPoller();`

- [ ] **Step 4: Verify + commit**

```bash
npx tsc --noEmit && pnpm test
git commit -m "feat(5a): register EngagementAlertWorker and poller in worker index"
```

---

## Task 7: Update Status Docs

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `docs/progresstracking.md`

- [ ] **Step 1: Update CLAUDE.md Sprint 5 status**

Add Prompt 19d entry with: EngagementMonitorPoller (daily, grouped metrics query, 4 engagement rules, cooldown dedup), EngagementAlertWorker (owner_nudge with fresh approval links, 3 partner alert types), extracted createApprovalLink shared helper, 4 email templates, test count.

- [ ] **Step 2: Update progresstracking.md**

Add Phase 5A.3 entry.

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: update status with Sprint 5A Prompt 19d (engagement system)"
```
