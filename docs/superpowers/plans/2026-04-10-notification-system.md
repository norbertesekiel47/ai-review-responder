# Notification System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the notification pipeline: email sending via Resend, NotificationWorker that generates approval tokens and sends approval emails, and Resend delivery webhook handler for tracking email delivery status.

**Architecture:** The NotificationWorker consumes `send_notification` BullMQ jobs. For each, it generates a raw approval token, stores only the SHA-256 hash in `approval_links`, constructs the approval URL with the raw token, sends the email via Resend, and records the delivery in `notification_deliveries`. The raw token only exists in memory and in the sent email — never persisted. Resend delivery webhooks hit `/ingress/resend` on Railway, are deduplicated via `inbound_events`, and update `notification_deliveries` with delivered/bounced/complained status. Idempotency handles retries: if a link+delivery already exist, skip; if a link exists but no delivery, revoke the old link and create a new one (since we can't reconstruct the raw token from the hash).

**Tech Stack:** Resend SDK, node:crypto (randomUUID + createHash), Postgres.js, BullMQ, Fastify raw-body for webhook signature verification

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/notifications/email.ts` | Create | Resend email sender with HTML template |
| `src/lib/notifications/index.ts` | Modify | Barrel exports |
| `worker/jobs/NotificationWorker.ts` | Create | Process send_notification jobs: token gen, link creation, email send, delivery tracking |
| `worker/ingress/resend.ts` | Replace | Resend delivery webhook handler with signature verification + dedup |
| `worker/index.ts` | Modify | Register NotificationWorker, wire real resend ingress handler |
| `.env.example` | Modify | Add RESEND_FROM_EMAIL |
| `worker/__tests__/NotificationWorker.test.ts` | Create | Unit tests |

---

### Task 1: Add RESEND_FROM_EMAIL to env files

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add RESEND_FROM_EMAIL after RESEND_WEBHOOK_SECRET**

In `.env.example`, after the `RESEND_WEBHOOK_SECRET` line:
```
RESEND_FROM_EMAIL="RepWorth <notifications@yourdomain.com>"
```

- [ ] **Step 2: Verify no syntax issues**

Run: `npx tsc --noEmit`
Expected: No errors (env files aren't compiled, but sanity check)

---

### Task 2: Create email sender

**Files:**
- Create: `src/lib/notifications/email.ts`
- Modify: `src/lib/notifications/index.ts`

- [ ] **Step 1: Create the email module**

```typescript
import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { isMockMode } from '@/lib/shared/mock-mode';

const LOG_PREFIX = '[email]';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

export interface ApprovalEmailParams {
  to: string;
  from: string;
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  responsePreview: string;
  approvalUrl: string;
}

function renderStars(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function buildApprovalEmailHtml(params: ApprovalEmailParams): string {
  const { businessName, reviewerName, starRating, reviewText, responsePreview, approvalUrl } = params;
  const stars = renderStars(starRating);
  const reviewBody = reviewText
    ? truncate(reviewText, 200)
    : 'Rating only — no written review';
  const preview = truncate(responsePreview, 100);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">New review for ${businessName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">A draft response is ready for your approval.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:24px;letter-spacing:2px;">${stars}</p>
              <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">${reviewerName}</p>
              <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.5;">${reviewBody}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 0;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Draft response</p>
          <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;font-style:italic;">"${preview}"</p>
        </td></tr>
        <tr><td style="padding:24px;" align="center">
          <a href="${approvalUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;text-decoration:none;">Review &amp; Approve</a>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This link expires in 48 hours.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendApprovalEmail(
  params: ApprovalEmailParams,
): Promise<{ messageId: string }> {
  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Approval email to=${params.to} subject="New review for ${params.businessName} — response ready" messageId=${mockId}`);
    return { messageId: mockId };
  }

  const resend = getResend();
  const html = buildApprovalEmailHtml(params);

  const { data, error } = await resend.emails.send({
    from: params.from,
    to: params.to,
    subject: `New review for ${params.businessName} — response ready`,
    html,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
```

- [ ] **Step 2: Update barrel exports**

Replace `src/lib/notifications/index.ts`:
```typescript
export { sendApprovalEmail } from './email';
export type { ApprovalEmailParams } from './email';
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 3: Create NotificationWorker

**Files:**
- Create: `worker/jobs/NotificationWorker.ts`

- [ ] **Step 1: Create the worker**

```typescript
import type { Job } from 'bullmq';
import { randomUUID, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendApprovalEmail } from '../../src/lib/notifications/email';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[NotificationWorker]';

export async function handleSendNotification(
  job: Job<SendNotificationPayload>,
): Promise<void> {
  const { response_id, business_id } = job.data;
  const outboxId = job.id!;

  // ── Step 1: Read response + review + business ──────────────────────
  const [responseRow] = await sql<{
    id: string;
    response_text: string;
    review_id: string;
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    review_date: string;
  }[]>`
    SELECT resp.id, resp.response_text, resp.review_id,
           r.reviewer_name, r.star_rating, r.review_text, r.review_date
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.id = ${response_id}
  `;

  if (!responseRow) {
    console.warn(`${LOG_PREFIX} Response ${response_id} not found`);
    await markOutboxFailed(outboxId, 'response_not_found');
    return;
  }

  const [business] = await sql<{
    owner_email: string;
    owner_name: string;
    name: string;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT owner_email, owner_name, name, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── Step 2: Subscription guard ─────────────────────────────────────
  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'notification',
  );

  if (!subCheck.allowed) {
    console.log(`${LOG_PREFIX} Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

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

  // Check for an existing unexpired link without a delivery record.
  // This means a previous attempt created the link but crashed before
  // sending the email. We can't reconstruct the raw token from the hash,
  // so revoke the orphaned link and create a new one.
  const [orphanedLink] = await sql<{ id: string }[]>`
    SELECT id FROM approval_links
    WHERE response_id = ${response_id}
      AND revoked_at IS NULL
      AND expires_at > NOW()
  `;

  if (orphanedLink) {
    console.warn(`${LOG_PREFIX} Revoking orphaned approval link ${orphanedLink.id} for response ${response_id}`);
    await sql`
      UPDATE approval_links SET revoked_at = NOW() WHERE id = ${orphanedLink.id}
    `;
  }

  // ── Step 4: Generate approval token ────────────────────────────────
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // ── Step 5: Create approval link in transaction ────────────────────
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
      VALUES (
        ${uuidv7()}, ${response_id}, ${business_id}, ${tokenHash}, 'email',
        NOW() + INTERVAL '48 hours'
      )
    `;
  });

  // ── Step 6: Send email ─────────────────────────────────────────────
  const approvalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/approve/${rawToken}`;
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'RepWorth <notifications@repworth.com>';

  let messageId: string;
  try {
    const result = await sendApprovalEmail({
      to: business.owner_email,
      from: fromEmail,
      businessName: business.name,
      reviewerName: responseRow.reviewer_name,
      starRating: responseRow.star_rating,
      reviewText: responseRow.review_text,
      responsePreview: responseRow.response_text,
      approvalUrl,
    });
    messageId = result.messageId;
  } catch (err) {
    // Email send failed — throw so BullMQ retries.
    // The approval link exists in DB. On retry, the idempotency check
    // finds no delivery record, revokes the orphaned link, creates a
    // new one with a fresh token, and retries the email.
    console.error(`${LOG_PREFIX} Failed to send email for response ${response_id}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // ── Step 7: Record delivery ────────────────────────────────────────
  await sql`
    INSERT INTO notification_deliveries (id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
    VALUES (
      ${uuidv7()}, ${business_id}, ${response_id}, 'email', ${business.owner_email},
      'approval_request', NOW(), ${messageId}
    )
  `;

  // Raw token only existed in memory during this function.
  // NEVER log it, NEVER store it in outbox payloads.
  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Approval email sent for response ${response_id} to ${business.owner_email}`);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 4: Create Resend webhook handler

**Files:**
- Replace: `worker/ingress/resend.ts`

- [ ] **Step 1: Create the webhook handler**

```typescript
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';

const LOG_PREFIX = '[ingress/resend]';

interface ResendWebhookBody {
  type: string;
  data: {
    email_id?: string;
    [key: string]: unknown;
  };
}

/**
 * Verify Resend webhook signature (svix-based).
 * Resend uses Svix for webhook delivery. Headers:
 *   svix-id, svix-timestamp, svix-signature
 * Signature = base64(HMAC-SHA256(secret, "${svixId}.${svixTimestamp}.${body}"))
 */
function verifySignature(rawBody: string, headers: Record<string, string | undefined>): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(`${LOG_PREFIX} RESEND_WEBHOOK_SECRET not set, skipping verification`);
    return true; // Allow in dev when secret isn't configured
  }

  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  // Svix secrets are prefixed with "whsec_" and base64-encoded after the prefix
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  // svix-signature can contain multiple signatures separated by spaces (v1,xxx v1,yyy)
  const signatures = svixSignature.split(' ').map((s) => s.split(',')[1] ?? '');
  return signatures.some((sig) => {
    try {
      return timingSafeEqual(Buffer.from(sig, 'base64'), Buffer.from(expected, 'base64'));
    } catch {
      return false;
    }
  });
}

export async function handleResendWebhook(
  request: FastifyRequest<{ Body: ResendWebhookBody }>,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const headers = request.headers as Record<string, string | undefined>;

  if (!verifySignature(rawBody, headers)) {
    console.warn(`${LOG_PREFIX} Invalid webhook signature`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  const body = request.body;
  const eventType = body.type;
  const emailId = body.data?.email_id;
  const svixId = headers['svix-id'] ?? `resend-${Date.now()}`;

  // Deduplicate via inbound_events
  const inserted = await sql`
    INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status)
    VALUES (${uuidv7()}, 'resend', ${svixId}, ${eventType}, ${JSON.stringify(body)}::jsonb, 'received')
    ON CONFLICT (external_event_key) DO NOTHING
  `;

  if (inserted.count === 0) {
    // Already processed — return 200 so Resend doesn't retry
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  // Process the event
  try {
    if (emailId) {
      switch (eventType) {
        case 'email.delivered':
          await sql`
            UPDATE notification_deliveries SET delivered_at = NOW()
            WHERE external_message_id = ${emailId}
          `;
          break;

        case 'email.bounced':
        case 'email.complained': {
          const reason = eventType === 'email.bounced' ? 'bounced' : 'complained';
          await sql`
            UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = ${reason}
            WHERE external_message_id = ${emailId}
          `;
          break;
        }
      }
    }

    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${svixId}
    `;
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to process event ${svixId}: ${err instanceof Error ? err.message : err}`);
    await sql`
      UPDATE inbound_events SET status = 'failed', error_message = ${err instanceof Error ? err.message : String(err)}
      WHERE external_event_key = ${svixId}
    `;
  }

  // Always return 200 — Resend expects 2xx
  reply.status(200).send({ received: true });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 5: Wire everything into worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add NotificationWorker import**

After the ResponseGeneratorWorker import:
```typescript
import { handleSendNotification } from './jobs/NotificationWorker';
```

- [ ] **Step 2: Add worker creation**

After `responseGenWorker`:
```typescript
const notificationWorker = new Worker(QUEUE_NAMES.SEND_NOTIFICATION, handleSendNotification, {
  connection: redisOpts,
});
```

- [ ] **Step 3: Add to workers array**

```typescript
const workers = [demoWorker, reviewSyncWorker, responseGenWorker, notificationWorker];
```

- [ ] **Step 4: Replace resend ingress placeholder**

Add import at top:
```typescript
import { handleResendWebhook } from './ingress/resend';
```

Replace the placeholder route:
```typescript
// Old:
app.post('/ingress/resend', { config: { rawBody: true } }, async (_request, reply) => {
  reply.status(200).send({ received: true });
});

// New:
app.post('/ingress/resend', { config: { rawBody: true } }, handleResendWebhook);
```

- [ ] **Step 5: Verify TypeScript compiles and tests pass**

Run: `npx tsc --noEmit && pnpm test`
Expected: No errors, all tests pass

---

### Task 6: Write unit tests

**Files:**
- Create: `worker/__tests__/NotificationWorker.test.ts`

Tests cover:
1. Successful flow → approval link created, email sent, delivery recorded, outbox completed
2. Subscription pending_payment → markOutboxCompleted (notification worker skips pending_payment)
3. Existing delivery → idempotent skip, markOutboxCompleted
4. Orphaned link (link exists, no delivery) → old link revoked, new link created, email sent
5. Email send failure → throws for BullMQ retry

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted state ────────────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendApprovalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockTx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => {
    return Promise.resolve([]);
  });

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

  return {
    sqlReturnQueue,
    mockSql,
    mockTx,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendApprovalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/notifications/email', () => ({
  sendApprovalEmail: mockSendApprovalEmail,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handleSendNotification } from '../jobs/NotificationWorker';

function makeJob(): Job<SendNotificationPayload> {
  return {
    data: { response_id: 'resp-1', business_id: 'biz-1' },
    id: 'outbox-notif-1',
  } as Job<SendNotificationPayload>;
}

function mockResponseRow() {
  return {
    id: 'resp-1', response_text: 'Thank you, Jane!', review_id: 'rev-1',
    reviewer_name: 'Jane', star_rating: 5, review_text: 'Great place!', review_date: '2026-04-01',
  };
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    owner_email: 'owner@test.com', owner_name: 'Owner', name: 'Test Biz',
    subscription_status: 'active', updated_at: new Date(), ...overrides,
  };
}

describe('NotificationWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
  });

  it('sends approval email and completes outbox on success', async () => {
    sqlReturnQueue.push([mockResponseRow()]);   // response+review join
    sqlReturnQueue.push([mockBusinessRow()]);    // business
    sqlReturnQueue.push([]);                     // no existing delivery
    sqlReturnQueue.push([]);                     // no orphaned link
    // sql.begin for approval link insert
    // sendApprovalEmail resolves
    sqlReturnQueue.push([]);                     // delivery insert

    await handleSendNotification(makeJob());

    expect(mockSendApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@test.com',
        businessName: 'Test Biz',
        reviewerName: 'Jane',
        starRating: 5,
      }),
    );
    expect(mockSql.begin).toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });

  it('skips when subscription is pending_payment', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleSendNotification(makeJob());

    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });

  it('skips when delivery already exists (idempotent)', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([{ id: 'existing-delivery' }]);  // existing delivery found

    await handleSendNotification(makeJob());

    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });

  it('revokes orphaned link and creates new one on retry', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]);                              // no existing delivery
    sqlReturnQueue.push([{ id: 'orphaned-link-id' }]);   // orphaned link exists
    sqlReturnQueue.push([]);                              // revoke UPDATE
    // sql.begin for new approval link
    sqlReturnQueue.push([]);                              // delivery insert

    await handleSendNotification(makeJob());

    // Revoke was called (one of the sql calls includes 'orphaned-link-id')
    const allSqlArgs = mockSql.mock.calls.map((c: unknown[][]) => c.slice(1)).flat();
    expect(allSqlArgs).toContain('orphaned-link-id');
    expect(mockSendApprovalEmail).toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });

  it('throws on email send failure for BullMQ retry', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]);                     // no existing delivery
    sqlReturnQueue.push([]);                     // no orphaned link

    mockSendApprovalEmail.mockRejectedValueOnce(new Error('Resend 500'));

    await expect(handleSendNotification(makeJob())).rejects.toThrow('Resend 500');
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass

---

### Task 7: Final verification + tracking updates

- [ ] **Step 1: Full type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 3: Build check**

Run: `pnpm build`
Expected: Next.js build succeeds

- [ ] **Step 4: Update tracking files**

Update `.claude/CLAUDE.md` current status with Prompt 11 completion.
Append Prompt 11 entry to `docs/progresstracking.md`.
