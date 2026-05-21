# Prompt 20d: Email Deliverability + Hard Bounce Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve inbox placement and stop sending owner-directed emails to hard-bounced addresses. Adds email categories (transactional/marketing/internal), List-Unsubscribe headers on marketing emails, Resend per-email tags, hard-bounce detection that flags `businesses.owner_email_bounced`, and defensive skip-if-bounced guards across all owner-directed workers.

**Architecture:** A new `EmailCategory` type + `getEmailHeaders()` helper drives category-specific headers. `sendApprovalEmail` becomes transactional (no unsubscribe), `sendInternalEmail` grows an optional `category` parameter. The Resend webhook handler defensively extracts bounce type from `data.bounce.type` / `data.reason` / `data.status`, sets `owner_email_bounced=true` on hard/permanent bounces, and notifies the admin once. Four owner-directed workers (Notification, WeeklySummary, MonthlyImpact, OnboardingDrip) and EngagementAlert's owner_nudge branch check the flag before sending. Internal/partner alerts keep flowing regardless.

**Tech Stack:** TypeScript, Resend SDK (already installed), Postgres.js, Vitest. No new dependencies.

**Prerequisite:** Migration 017 adds `businesses.owner_email_bounced` column. Already on disk in `supabase/migrations/017_sprint6_scale.sql`. Must be applied to Supabase before production testing.

**Spec:** `docs/Final_Implementation_Plan.md` Prompt 20d.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/lib/shared/__tests__/email-headers.test.ts` | Unit tests for `EmailCategory` + `getEmailHeaders()` |
| `src/lib/notifications/__tests__/email-send.test.ts` | Unit tests asserting `sendApprovalEmail` + `sendInternalEmail` pass correct headers/tags to Resend |
| `worker/__tests__/bounced-skip.test.ts` | Per-worker tests verifying bounced businesses are skipped |
| `worker/__tests__/resend-webhook-bounce.test.ts` | Extended Resend webhook tests covering bounce-type extraction + business flagging |
| `docs/email-deliverability.md` | DNS auth checklist + warmup schedule + monitoring + troubleshooting |

### Modified Files
| File | Change |
|------|--------|
| `src/lib/notifications/email.ts` | Add `EmailCategory` type, `getEmailHeaders()` helper, `category` param on send functions, Resend tags |
| `worker/ingress/resend.ts` | Defensive bounce-type extraction, set `owner_email_bounced=true` on hard bounces, send admin alert |
| `worker/jobs/NotificationWorker.ts` | SELECT `owner_email_bounced`, skip if true |
| `worker/jobs/WeeklySummaryWorker.ts` | SELECT `owner_email_bounced`, skip + pass `category: 'marketing'` |
| `worker/jobs/MonthlyImpactWorker.ts` | SELECT `owner_email_bounced`, skip + pass `category: 'marketing'` |
| `worker/jobs/OnboardingDripWorker.ts` | SELECT `owner_email_bounced`, skip + pass `category: 'marketing'` |
| `worker/jobs/EngagementAlertWorker.ts` | `handleOwnerNudge` checks `owner_email_bounced` + passes `category: 'marketing'`; partner/satisfaction alerts pass `category: 'internal'` |
| `worker/jobs/EngagementMonitorPoller.ts` | Skip `owner_nudge` rule for bounced businesses at query time |
| `worker/jobs/ResponsePublisherWorker.ts` | Manual-post email passes `category: 'internal'` |
| `worker/jobs/AdminExceptionWorker.ts` | Exception alert passes `category: 'internal'` |
| `worker/jobs/NotificationFailoverPoller.ts` | Admin alert passes `category: 'internal'` |
| `src/app/api/admin/overview/route.ts` | Add `emailHealth` query + field to systemHealth response |
| `src/app/admin/overview/page.tsx` | Add "Email Health" card to system health bar |
| `src/app/api/admin/businesses/[id]/route.ts` | Return `ownerEmailBounced` in GET response |
| `src/app/admin/businesses/[id]/page.tsx` | Add bounced-email warning banner + admin "clear flag" action |

---

## Task 1: Email Categories + List-Unsubscribe Headers

**Files:**
- Modify: `src/lib/notifications/email.ts`
- Create: `src/lib/shared/__tests__/email-headers.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// src/lib/shared/__tests__/email-headers.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEmailHeaders, getEmailTags } from '../../notifications/email';

describe('getEmailHeaders', () => {
  const originalListUnsub = process.env.LIST_UNSUBSCRIBE_EMAIL;
  const originalFromEmail = process.env.RESEND_FROM_EMAIL;

  beforeEach(() => {
    delete process.env.LIST_UNSUBSCRIBE_EMAIL;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.example>';
  });

  afterEach(() => {
    if (originalListUnsub !== undefined) process.env.LIST_UNSUBSCRIBE_EMAIL = originalListUnsub;
    if (originalFromEmail !== undefined) process.env.RESEND_FROM_EMAIL = originalFromEmail;
  });

  it('returns List-Unsubscribe headers for marketing emails', () => {
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBeDefined();
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:/);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('returns empty headers for transactional emails (approval links are not marketing)', () => {
    const headers = getEmailHeaders('transactional');
    expect(headers).toEqual({});
  });

  it('returns empty headers for internal emails (admin-facing, not customer-directed)', () => {
    const headers = getEmailHeaders('internal');
    expect(headers).toEqual({});
  });

  it('uses LIST_UNSUBSCRIBE_EMAIL when set', () => {
    process.env.LIST_UNSUBSCRIBE_EMAIL = 'unsubscribe@repworth.example';
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsubscribe@repworth.example>');
  });

  it('derives unsubscribe mailbox from RESEND_FROM_EMAIL when LIST_UNSUBSCRIBE_EMAIL missing', () => {
    // RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.example>' — extract notifications@...
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:notifications@repworth.example>');
  });

  it('derives unsubscribe mailbox from bare RESEND_FROM_EMAIL (no display name)', () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.example';
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:notifications@repworth.example>');
  });

  it('falls back to generic unsubscribe when neither env var is set', () => {
    delete process.env.RESEND_FROM_EMAIL;
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsubscribe@repworth.example.com>');
  });
});

describe('getEmailTags', () => {
  it('returns a single Resend tag with the category name', () => {
    expect(getEmailTags('transactional')).toEqual([{ name: 'category', value: 'transactional' }]);
    expect(getEmailTags('marketing')).toEqual([{ name: 'category', value: 'marketing' }]);
    expect(getEmailTags('internal')).toEqual([{ name: 'category', value: 'internal' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/lib/shared/__tests__/email-headers.test.ts`
Expected: FAIL — `getEmailHeaders` and `getEmailTags` not exported from `email.ts`.

- [ ] **Step 3: Add the types and helpers to `src/lib/notifications/email.ts`**

Insert this block AFTER the `getResend()` helper (after line 14, before `export interface ApprovalEmailParams`):

```typescript
// ── Email categorization (deliverability + compliance) ──────────────────
//
// Resend tags + List-Unsubscribe headers are per-category.
// - transactional: one-to-one user-initiated (approval emails). No unsubscribe —
//   these are necessary for service operation, not marketing.
// - marketing: recurring owner reports + nudges (weekly/monthly/drips/owner_nudge).
//   Gmail/Outlook bulk-sender rules require List-Unsubscribe one-click for these.
// - internal: admin/sales-partner alerts (manual-post instructions, exceptions,
//   partner engagement alerts). Not customer-facing, no unsubscribe needed.

export type EmailCategory = 'transactional' | 'marketing' | 'internal';

/**
 * Extracts a mailbox from RESEND_FROM_EMAIL, supporting both "Display <addr>"
 * and bare "addr" formats. Returns null if no valid mailbox can be extracted.
 */
function extractMailbox(fromEmail: string | undefined): string | null {
  if (!fromEmail) return null;
  const angleMatch = fromEmail.match(/<([^>]+)>/);
  if (angleMatch && angleMatch[1] && angleMatch[1].includes('@')) return angleMatch[1].trim();
  const trimmed = fromEmail.trim();
  if (trimmed.includes('@') && !trimmed.includes('<')) return trimmed;
  return null;
}

/**
 * Returns additional email headers for a given category.
 * Only 'marketing' emails get List-Unsubscribe headers — required by
 * Gmail/Outlook bulk-sender compliance rules.
 */
export function getEmailHeaders(category: EmailCategory): Record<string, string> {
  if (category !== 'marketing') return {};

  const explicit = process.env.LIST_UNSUBSCRIBE_EMAIL?.trim();
  const derived = extractMailbox(process.env.RESEND_FROM_EMAIL);
  const mailbox = explicit || derived || 'unsubscribe@repworth.example.com';

  return {
    'List-Unsubscribe': `<mailto:${mailbox}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Returns Resend tags for a given category. Lets the Resend dashboard
 * filter/aggregate deliveries by category.
 */
export function getEmailTags(category: EmailCategory): Array<{ name: string; value: string }> {
  return [{ name: 'category', value: category }];
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test -- src/lib/shared/__tests__/email-headers.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/email.ts src/lib/shared/__tests__/email-headers.test.ts
git commit -m "feat(20d): add EmailCategory + getEmailHeaders/Tags helpers"
```

---

## Task 2: Update `sendApprovalEmail` and `sendInternalEmail` to Pass Headers + Tags

**Files:**
- Modify: `src/lib/notifications/email.ts`
- Create: `src/lib/notifications/__tests__/email-send.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/notifications/__tests__/email-send.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => mockSend(...args) },
  })),
}));

vi.mock('@/lib/shared/mock-mode', () => ({
  isMockMode: vi.fn().mockReturnValue(false),
}));

import { sendApprovalEmail, sendInternalEmail } from '../email';

describe('sendApprovalEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
    process.env.RESEND_API_KEY = 'test';
  });

  it('sends with NO List-Unsubscribe header (transactional)', async () => {
    await sendApprovalEmail({
      to: 'owner@example.com',
      from: 'RepWorth <notifications@repworth.example>',
      businessName: 'Test Biz',
      reviewerName: 'Jane',
      starRating: 5,
      reviewText: 'Great!',
      reviewDate: '2026-04-17',
      responsePreview: 'Thanks Jane!',
      approvalUrl: 'https://app.example/approve/xxx',
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.headers).toBeUndefined(); // or empty object
    // Still tags the email as transactional for Resend dashboard filtering
    expect(arg.tags).toEqual([{ name: 'category', value: 'transactional' }]);
  });
});

describe('sendInternalEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: 'msg-2' }, error: null });
    process.env.RESEND_API_KEY = 'test';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.example>';
  });

  it('defaults to internal category (no List-Unsubscribe)', async () => {
    await sendInternalEmail({
      to: 'admin@example.com',
      subject: 'Test',
      bodyHtml: '<p>hi</p>',
    });
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.headers).toBeUndefined();
    expect(arg.tags).toEqual([{ name: 'category', value: 'internal' }]);
  });

  it('sends marketing emails with List-Unsubscribe header', async () => {
    await sendInternalEmail({
      to: 'owner@example.com',
      subject: 'Your weekly report',
      bodyHtml: '<p>report</p>',
      category: 'marketing',
    });
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    const headers = arg.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toBeDefined();
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(arg.tags).toEqual([{ name: 'category', value: 'marketing' }]);
  });

  it('sends explicit internal category with no List-Unsubscribe', async () => {
    await sendInternalEmail({
      to: 'admin@example.com',
      subject: 'Exception alert',
      bodyHtml: '<p>alert</p>',
      category: 'internal',
    });
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.headers).toBeUndefined();
    expect(arg.tags).toEqual([{ name: 'category', value: 'internal' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/lib/notifications/__tests__/email-send.test.ts`
Expected: FAIL — current implementations don't pass `headers` or `tags`.

- [ ] **Step 3: Update `sendApprovalEmail` in `src/lib/notifications/email.ts`**

Replace the existing `sendApprovalEmail` (lines 99-123) with:

```typescript
export async function sendApprovalEmail(
  params: ApprovalEmailParams,
): Promise<{ messageId: string }> {
  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Approval email to=${params.to} subject="New review for ${params.businessName} — response ready" messageId=${mockId}\n  → /approve/[redacted]`);
    return { messageId: mockId };
  }

  const resend = getResend();
  const html = buildApprovalEmailHtml(params);

  // Approval emails are transactional: no List-Unsubscribe header. They are
  // necessary for service operation, not marketing, so bulk-sender rules
  // don't require (and shouldn't include) an unsubscribe link.
  const category: EmailCategory = 'transactional';
  const { data, error } = await resend.emails.send({
    from: params.from,
    to: params.to,
    subject: `New review for ${params.businessName} — response ready`,
    html,
    tags: getEmailTags(category),
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
```

Note: transactional category has no headers (empty object), so we DON'T spread `headers: getEmailHeaders('transactional')` — the underlying Resend call should not receive `headers` at all. Confirm this matches the test expectation `expect(arg.headers).toBeUndefined()`.

- [ ] **Step 4: Update `InternalEmailParams` + `sendInternalEmail`**

Find the `InternalEmailParams` interface (around line 187) and `sendInternalEmail` (around line 193). Replace both with:

```typescript
export interface InternalEmailParams {
  to: string;
  subject: string;
  bodyHtml: string;
  /**
   * Email category for headers + Resend tags. Defaults to 'internal'
   * (admin-facing, no List-Unsubscribe). Use 'marketing' for owner-
   * directed recurring emails (weekly reports, drips, nudges).
   */
  category?: EmailCategory;
}

export async function sendInternalEmail(
  params: InternalEmailParams,
): Promise<{ messageId: string }> {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) throw new Error('RESEND_FROM_EMAIL not configured');

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Internal email to=${params.to} subject="${params.subject}" category=${params.category ?? 'internal'} messageId=${mockId}`);
    return { messageId: mockId };
  }

  const category: EmailCategory = params.category ?? 'internal';
  const headers = getEmailHeaders(category);

  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.bodyHtml,
    tags: getEmailTags(category),
    // Only pass headers when non-empty — empty object still adds no value
    // but avoids passing an unused property to Resend's JSON body.
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test -- src/lib/notifications/__tests__/email-send.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 6: Run full suite to confirm no regressions**

Run: `pnpm test`
Expected: 660 pre-existing + 8 new header tests + 4 new send tests = 672 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/notifications/email.ts src/lib/notifications/__tests__/email-send.test.ts
git commit -m "feat(20d): sendApprovalEmail + sendInternalEmail pass category tags and marketing headers"
```

---

## Task 3: Update Call Sites to Pass Correct Category

Each worker's `sendInternalEmail` call must now pass the right `category`. Transactional is implicit (only `sendApprovalEmail` uses it). Internal is the default (no change needed where internal is correct). Marketing must be explicit.

**Files:**
- Modify: `worker/jobs/WeeklySummaryWorker.ts` → marketing
- Modify: `worker/jobs/MonthlyImpactWorker.ts` → marketing
- Modify: `worker/jobs/OnboardingDripWorker.ts` → marketing
- Modify: `worker/jobs/EngagementAlertWorker.ts` → owner_nudge is marketing; partner/satisfaction are internal (already default, but pass explicitly for clarity)
- Modify: `worker/jobs/ResponsePublisherWorker.ts` → internal (explicit for clarity)
- Modify: `worker/jobs/AdminExceptionWorker.ts` → internal (explicit for clarity)
- Modify: `worker/jobs/NotificationFailoverPoller.ts` → internal (explicit for clarity)

- [ ] **Step 1: Update WeeklySummaryWorker.ts**

Find the `sendInternalEmail` call (around line 297). Add `category: 'marketing'`:

```typescript
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Weekly Value Report — ${business.name} (${weekLabel})`,
      bodyHtml: html,
      category: 'marketing',
    });
    messageId = result.messageId;
```

- [ ] **Step 2: Update MonthlyImpactWorker.ts**

Find the `sendInternalEmail` call (around line 282). Add `category: 'marketing'`:

```typescript
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Monthly Impact Report — ${business.name} (${monthLabel})`,
      bodyHtml: html,
      category: 'marketing',
    });
    messageId = result.messageId;
```

- [ ] **Step 3: Update OnboardingDripWorker.ts**

Find every `sendInternalEmail` call in this file (there are 3 — one per drip type). Add `category: 'marketing'` to each.

For example, the day_1 call:
```typescript
    const { messageId } = await sendInternalEmail({
      to: business.owner_email,
      subject: 'Welcome to RepWorth — here\'s how it works',
      bodyHtml,
      category: 'marketing',
    });
```

Repeat for day_7 and day_30 sends.

- [ ] **Step 4: Update EngagementAlertWorker.ts — owner_nudge is marketing**

Find the `sendInternalEmail` call inside `handleOwnerNudge` (around line 166):

```typescript
  const { messageId } = await sendInternalEmail({
    to: business.owner_email,
    subject,
    bodyHtml,
    category: 'marketing',
  });
```

For the `handlePartnerAlert` function's `sendInternalEmail` call (around line 245), pass explicit `category: 'internal'`:

```typescript
  const { messageId } = await sendInternalEmail({
    to: adminEmail,
    subject,
    bodyHtml,
    category: 'internal',
  });
```

Also update `handleSatisfactionAlert` the same way — find its `sendInternalEmail` call and add `category: 'internal'`.

- [ ] **Step 5: Update ResponsePublisherWorker.ts**

Find the `sendInternalEmail` call (around line 191):

```typescript
  const { messageId } = await sendInternalEmail({
    to: adminEmail,
    subject: `Manual post needed: ${businessName}`,
    bodyHtml,
    category: 'internal',
  });
```

- [ ] **Step 6: Update AdminExceptionWorker.ts**

Find the `sendInternalEmail` call (around line 75):

```typescript
    await sendInternalEmail({
      to: adminEmail,
      subject: `Review exception: ${exception.business_name} — ${exception.type}`,
      bodyHtml,
      category: 'internal',
    });
```

- [ ] **Step 7: Update NotificationFailoverPoller.ts**

Find the admin alert `sendInternalEmail` call (around line 77):

```typescript
            const { messageId } = await sendInternalEmail({
              to: adminEmail,
              subject: `Notification failure: ${row.business_name} — all delivery attempts failed`,
              bodyHtml: `<p>All approval email delivery attempts have failed ...</p>`,
              category: 'internal',
            });
```

- [ ] **Step 8: Run tests**

Run: `pnpm test`
Expected: All tests still pass. Some worker tests may assert on `sendInternalEmail` call args — if they fail due to the new `category` field, update the test expectations to include `category: 'marketing'` or `category: 'internal'`.

- [ ] **Step 9: Commit**

```bash
git add worker/jobs/
git commit -m "feat(20d): worker call-sites pass explicit email category"
```

---

## Task 4: Hard Bounce Handling in Resend Webhook

**Files:**
- Modify: `worker/ingress/resend.ts`
- Create: `worker/__tests__/resend-webhook-bounce.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// worker/__tests__/resend-webhook-bounce.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlReturnQueue, mockSql, mockSendInternalEmail } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(Array.isArray(result) ? result : [result]);
  }) as unknown as ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise<unknown>) & { count?: number };
  const mockSendInternalEmail = vi.fn().mockResolvedValue({ messageId: 'mock' });
  return { sqlReturnQueue, mockSql, mockSendInternalEmail };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: (...args: unknown[]) => mockSendInternalEmail(...args),
}));

import { handleResendWebhook } from '../ingress/resend';

// Helper: construct a minimal Fastify-like request/reply
function makeReq(body: unknown, headers: Record<string, string | undefined> = {}) {
  return {
    body,
    headers: {
      'svix-id': 'msg_test',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,ignored',
      ...headers,
    },
    rawBody: JSON.stringify(body),
  } as unknown as import('fastify').FastifyRequest;
}

function makeReply() {
  const captured: { status?: number; body?: unknown } = {};
  const reply = {
    status: (code: number) => {
      captured.status = code;
      return reply;
    },
    send: (body: unknown) => {
      captured.body = body;
    },
  } as unknown as import('fastify').FastifyReply;
  return { reply, captured };
}

describe('handleResendWebhook — bounce handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.MOCK_EXTERNAL_APIS = 'true'; // bypass signature verification
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@example.com';
  });

  it('sets owner_email_bounced=true on hard bounce (data.bounce.type=permanent)', async () => {
    sqlReturnQueue.push({ count: 1 }); // inbound_events INSERT (not duplicate)
    sqlReturnQueue.push([{ business_id: 'biz-1' }]); // lookup via notification_deliveries
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE businesses SET owner_email_bounced
    sqlReturnQueue.push([]); // UPDATE inbound_events SET status = 'processed'

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Permanent' } },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);

    // Find the SQL call that UPDATEd businesses.owner_email_bounced
    const stringArgs = mockSql.mock.calls.flatMap((c) =>
      (c[0] as TemplateStringsArray).raw.map((s) => s),
    );
    const joinedSql = stringArgs.join(' ');
    expect(joinedSql).toContain('owner_email_bounced');
    expect(joinedSql).toContain('UPDATE businesses');

    // Admin got an alert
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const alertArgs = mockSendInternalEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(alertArgs.to).toBe('admin@example.com');
    expect(String(alertArgs.subject)).toMatch(/hard bounce/i);
    expect(alertArgs.category).toBe('internal');
  });

  it('does not flag business for soft bounces (data.bounce.type=transient)', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1' }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Transient' } },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    // No UPDATE businesses ... owner_email_bounced = true should occur
    const stringArgs = mockSql.mock.calls.flatMap((c) =>
      (c[0] as TemplateStringsArray).raw.map((s) => s),
    );
    const joinedSql = stringArgs.join(' ');
    expect(joinedSql).not.toContain('owner_email_bounced = TRUE');
    expect(joinedSql).not.toContain('owner_email_bounced = true');

    // No admin alert
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('falls back to unknown bounce type when payload has no type hints', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc' }, // no bounce field at all
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    // Unknown bounce type is NOT treated as hard — business not flagged, no admin alert
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('accepts alternative payload shapes (data.reason="permanent_failure")', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', reason: 'permanent_failure' },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
  });

  it('records complained status and does not flag business as bounced', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.complained',
      data: { email_id: 'msg-abc' },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);

    const stringArgs = mockSql.mock.calls.flatMap((c) =>
      (c[0] as TemplateStringsArray).raw.map((s) => s),
    );
    const joinedSql = stringArgs.join(' ');
    expect(joinedSql).toContain('failure_reason');
    expect(joinedSql).not.toContain('owner_email_bounced');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- worker/__tests__/resend-webhook-bounce.test.ts`
Expected: FAIL — current handler doesn't extract bounce type or flag businesses.

- [ ] **Step 3: Update `worker/ingress/resend.ts`**

Replace the bounce/complained handling block (lines 113-122) with the expanded version. Find:

```typescript
        case 'email.bounced':
        case 'email.complained': {
          const reason = eventType === 'email.bounced' ? 'bounced' : 'complained';
          await sql`
            UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = ${reason}
            WHERE external_message_id = ${emailId}
          `;
          break;
        }
```

Replace with:

```typescript
        case 'email.complained': {
          await sql`
            UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = 'complained'
            WHERE external_message_id = ${emailId}
          `;
          break;
        }

        case 'email.bounced': {
          // Defensively extract bounce type from multiple possible payload shapes.
          // Resend has documented `data.bounce.type` but some older/test payloads
          // use `data.reason` or `data.status`. Default to 'unknown' — which is
          // NOT treated as hard, so the business flag is not set on ambiguity.
          const bounceType = extractBounceType(body.data);
          const isHardBounce = isHardBounceType(bounceType);

          // Look up the business_id via notification_deliveries BEFORE updating
          // the delivery row (the UPDATE target is the same row).
          const [delivery] = await sql<{ business_id: string }[]>`
            SELECT business_id FROM notification_deliveries
            WHERE external_message_id = ${emailId}
            LIMIT 1
          `;

          await sql`
            UPDATE notification_deliveries
            SET failed_at = NOW(), failure_reason = ${`bounced:${bounceType}`}
            WHERE external_message_id = ${emailId}
          `;

          if (isHardBounce && delivery?.business_id) {
            // Flag the business so owner-directed workers stop sending.
            // Partner/internal alerts still reach the admin.
            await sql`
              UPDATE businesses
              SET owner_email_bounced = TRUE, updated_at = NOW()
              WHERE id = ${delivery.business_id}
            `;

            // Notify admin once per hard bounce. idempotency is not strict —
            // Resend may send the bounce multiple times, but inbound_events
            // dedup already prevents repeated webhook processing.
            const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
            if (adminEmail) {
              try {
                await sendInternalEmail({
                  to: adminEmail,
                  subject: `Hard bounce detected — business flagged`,
                  bodyHtml: `<p>A hard bounce (type: <code>${escapeHtml(bounceType)}</code>) was reported by Resend for business ID <code>${escapeHtml(delivery.business_id)}</code>.</p><p>The business has been flagged (<code>owner_email_bounced=true</code>) and owner-directed emails (approval, weekly, monthly, drips, nudges) will be skipped until an admin verifies/updates the address and clears the flag.</p><p>Partner/admin alerts are unaffected.</p>`,
                  category: 'internal',
                });
              } catch (alertErr) {
                console.error(`${LOG_PREFIX} Failed to send admin hard-bounce alert:`, alertErr);
              }
            }
          }
          break;
        }
```

At the top of the file (after existing imports), add:

```typescript
import { sendInternalEmail } from '../../src/lib/notifications/email';
import { escapeHtml } from '../../src/lib/shared/html';
```

Below the `verifySignature` function, add the two helpers:

```typescript
/**
 * Extracts the bounce type string from a Resend email.bounced payload.
 * Supports multiple payload shapes defensively:
 *   - data.bounce.type     (Resend documented shape)
 *   - data.reason          (legacy/alternate)
 *   - data.status          (legacy/alternate)
 * Returns lowercase string, or 'unknown' if nothing matches.
 */
function extractBounceType(data: unknown): string {
  if (!data || typeof data !== 'object') return 'unknown';
  const d = data as Record<string, unknown>;
  const bounce = d.bounce;
  if (bounce && typeof bounce === 'object') {
    const t = (bounce as Record<string, unknown>).type;
    if (typeof t === 'string' && t.length > 0) return t.toLowerCase();
  }
  if (typeof d.reason === 'string' && d.reason.length > 0) return d.reason.toLowerCase();
  if (typeof d.status === 'string' && d.status.length > 0) return d.status.toLowerCase();
  return 'unknown';
}

/**
 * Returns true if the bounce type indicates a hard/permanent failure.
 * 'unknown' is treated as soft to avoid flagging businesses on ambiguity.
 */
function isHardBounceType(type: string): boolean {
  const t = type.toLowerCase();
  return (
    t === 'permanent' ||
    t === 'hard' ||
    t === 'hardbounce' ||
    t === 'permanent_failure' ||
    t.includes('permanent')
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- worker/__tests__/resend-webhook-bounce.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/ingress/resend.ts worker/__tests__/resend-webhook-bounce.test.ts
git commit -m "feat(20d): hard bounce detection flags business + alerts admin"
```

---

## Task 5: Skip Bounced Businesses in Owner-Directed Workers

Each owner-directed worker must SELECT `owner_email_bounced` and skip if true. Internal/partner alerts are NOT affected.

**Files:**
- Modify: `worker/jobs/NotificationWorker.ts`
- Modify: `worker/jobs/WeeklySummaryWorker.ts`
- Modify: `worker/jobs/MonthlyImpactWorker.ts`
- Modify: `worker/jobs/OnboardingDripWorker.ts`
- Modify: `worker/jobs/EngagementAlertWorker.ts` (owner_nudge branch only)
- Create: `worker/__tests__/bounced-skip.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// worker/__tests__/bounced-skip.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlReturnQueue, mockSql, mockTx, mockSendApprovalEmail, mockSendInternalEmail, mockMarkOutboxCompleted, mockMarkOutboxFailed } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockTx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => Promise.resolve([]));
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(Array.isArray(result) ? result : [result]);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
  return {
    sqlReturnQueue, mockSql, mockTx,
    mockSendApprovalEmail: vi.fn().mockResolvedValue({ messageId: 'ok' }),
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'ok' }),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/notifications/email', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/notifications/email')>(
    '../../src/lib/notifications/email',
  );
  return {
    ...actual,
    sendApprovalEmail: (...a: unknown[]) => mockSendApprovalEmail(...a),
    sendInternalEmail: (...a: unknown[]) => mockSendInternalEmail(...a),
  };
});
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('uuid', () => ({ v7: () => 'test-uuid' }));

function bouncedBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    name: 'Test Biz',
    owner_name: 'Jane',
    owner_email: 'bounced@example.com',
    owner_email_bounced: true,
    subscription_status: 'active',
    updated_at: new Date(),
    ...overrides,
  };
}

function normalBusiness(overrides: Record<string, unknown> = {}) {
  return { ...bouncedBusiness(overrides), owner_email_bounced: false };
}

// NotificationWorker — approval email skip
describe('NotificationWorker skips bounced owners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('skips approval email when owner_email_bounced is true', async () => {
    sqlReturnQueue.push([bouncedBusiness()]);
    const { handleSendNotification } = await import('../jobs/NotificationWorker');
    await handleSendNotification({
      id: 'job-1',
      data: { response_id: 'resp-1', business_id: 'biz-1', outbox_id: 'out-1' },
    } as any);
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-1');
  });
});

// WeeklySummaryWorker — marketing email skip
describe('WeeklySummaryWorker skips bounced owners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('skips weekly report when owner_email_bounced is true', async () => {
    sqlReturnQueue.push([{ ...bouncedBusiness(), initial_review_count: 0, initial_responded_count: 0, baseline_captured_at: null, subscription_tier: 'standard' }]);
    const { handleWeeklySummary } = await import('../jobs/WeeklySummaryWorker');
    await handleWeeklySummary({
      id: 'job-2',
      data: { business_id: 'biz-1', week_start_date: '2026-04-13', outbox_id: 'out-2' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-2');
  });
});

// MonthlyImpactWorker — marketing email skip
describe('MonthlyImpactWorker skips bounced owners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('skips monthly impact when owner_email_bounced is true', async () => {
    sqlReturnQueue.push([{ ...bouncedBusiness(), initial_review_count: 0, initial_responded_count: 0, baseline_captured_at: null, subscription_tier: 'standard' }]);
    const { handleMonthlyImpact } = await import('../jobs/MonthlyImpactWorker');
    await handleMonthlyImpact({
      id: 'job-3',
      data: { business_id: 'biz-1', month_start_date: '2026-04-01', outbox_id: 'out-3' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-3');
  });
});

// OnboardingDripWorker — marketing email skip
describe('OnboardingDripWorker skips bounced owners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('skips drip when owner_email_bounced is true', async () => {
    sqlReturnQueue.push([{ ...bouncedBusiness(), subscription_activated_at: new Date() }]);
    const { handleOnboardingDrip } = await import('../jobs/OnboardingDripWorker');
    await handleOnboardingDrip({
      id: 'job-4',
      data: { business_id: 'biz-1', drip_type: 'day_1', outbox_id: 'out-4' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-4');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- worker/__tests__/bounced-skip.test.ts`
Expected: FAIL — no bounce check exists yet.

- [ ] **Step 3: Update NotificationWorker.ts**

Find the business SELECT (around lines 59-65). Add `owner_email_bounced` to the SELECT list AND to the result type:

```typescript
  const [business] = await sql<{
    owner_email: string;
    owner_name: string;
    name: string;
    owner_email_bounced: boolean;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT owner_email, owner_name, name, owner_email_bounced, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;
```

Then, immediately after the subscription guard check (after `await markOutboxCompleted(outboxId); return;` for the subscription denied case), add:

```typescript
  // ── Step 2.5: Hard bounce check ──────────────────────────────────
  // Skip approval emails when the owner's email has hard-bounced. Admin will
  // verify and clear owner_email_bounced manually from the business detail page.
  if (business.owner_email_bounced) {
    logger.log(`Business ${business_id} owner email bounced — skipping approval notification`);
    await markOutboxCompleted(outboxId);
    return;
  }
```

- [ ] **Step 4: Update WeeklySummaryWorker.ts**

Find the business SELECT (around lines 20-35). Add `owner_email_bounced` to both the type and SELECT list.

After the subscription guard (search for `checkSubscription` call), add the bounce check:

```typescript
  if (business.owner_email_bounced) {
    logger.log(`Business ${business_id} owner email bounced — skipping weekly summary`);
    await markOutboxCompleted(outboxId);
    return;
  }
```

- [ ] **Step 5: Update MonthlyImpactWorker.ts**

Same pattern as WeeklySummaryWorker. Add `owner_email_bounced` to SELECT + type, add skip check after subscription guard.

- [ ] **Step 6: Update OnboardingDripWorker.ts**

Add `owner_email_bounced` to SELECT + type. Add skip check immediately after business load (drip worker has no separate subscription-active guard since `OnboardingDripScheduler` already filters to active businesses).

- [ ] **Step 7: Update EngagementAlertWorker.ts — owner_nudge branch only**

Find the main handler that loads the business. The existing business SELECT must include `owner_email_bounced`. At the top of `handleOwnerNudge` (after config validation), add:

```typescript
  if (business.owner_email_bounced) {
    logger.log(`Business ${businessId} owner email bounced — skipping owner nudge`);
    await markOutboxCompleted(outboxId);
    return;
  }
```

Note: the `business` object type passed to `handleOwnerNudge` currently has `{ name: string; owner_email: string }`. Extend that type to include `owner_email_bounced: boolean` and ensure the caller's SELECT includes the field.

DO NOT add this check to `handlePartnerAlert` or `handleSatisfactionAlert` — those go to admin, not the owner.

- [ ] **Step 8: Run tests**

Run: `pnpm test -- worker/__tests__/bounced-skip.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 9: Run full suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add worker/jobs/
git commit -m "feat(20d): owner-directed workers skip bounced businesses"
```

---

## Task 6: Skip owner_nudge Queuing for Bounced Businesses in EngagementMonitorPoller

Adding a guard at the worker level (Task 5) is defensive, but we should ALSO avoid queuing these jobs in the first place — saves outbox cycles and eliminates the edge case where the flag flips between queuing and processing.

**Files:**
- Modify: `worker/jobs/EngagementMonitorPoller.ts`

- [ ] **Step 1: Update the candidate query**

Find the `active_biz` CTE (around line 82-83):

```typescript
      WITH active_biz AS (
        SELECT id FROM businesses WHERE subscription_status = 'active'
      ),
```

Change to:

```typescript
      WITH active_biz AS (
        SELECT id FROM businesses
        WHERE subscription_status = 'active'
          AND owner_email_bounced = FALSE
      ),
```

Wait — this would ALSO exclude bounced businesses from partner_engagement/partner_escalation/partner_low_engagement alerts, which is wrong (those alerts notify the admin about the customer). We want to keep those flowing.

Instead, add the bounce check only to the owner_nudge rule. Find the section that decides which alert type to create (search for `'owner_nudge'` in this file) — it's a per-row decision after the SQL runs.

The logic structure typically looks like:
```typescript
if (pendingCount > 0 && activityAgeDays >= 3) {
  // create owner_nudge outbox entry
}
```

Modify the candidate query to also fetch `owner_email_bounced`:

```typescript
      WITH active_biz AS (
        SELECT id, owner_email_bounced FROM businesses WHERE subscription_status = 'active'
      ),
```

Update the SELECT at the bottom to include it:

```typescript
      SELECT
        ab.id AS business_id,
        ab.owner_email_bounced,
        EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.last_approval)::int AS days_since_approval,
        COALESCE(rm.pending_count, 0) AS pending_count,
        ...
```

Update the `BusinessMetrics` type in the file to include `owner_email_bounced: boolean`.

Then in the rule evaluation, wrap the owner_nudge creation:

```typescript
if (
  !row.owner_email_bounced &&
  activityAgeDays >= 3 &&
  row.pending_count > 0
) {
  // ... create owner_nudge outbox entry
}
```

Keep partner_engagement / partner_escalation / partner_low_engagement rules unchanged — those should fire regardless of bounce state.

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass. The existing `EngagementMonitorPoller.test.ts` may have tests that mock BusinessMetrics — those need updated mock objects with `owner_email_bounced: false`.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/EngagementMonitorPoller.ts
git commit -m "feat(20d): EngagementMonitorPoller skips owner_nudge for bounced businesses"
```

---

## Task 7: Email Health Metrics on Admin Overview

**Files:**
- Modify: `src/app/api/admin/overview/route.ts`
- Modify: `src/app/admin/overview/page.tsx`
- Modify: `src/app/api/admin/overview/__tests__/route.test.ts` (if it exists — update for new field)

- [ ] **Step 1: Update the overview API route**

In `src/app/api/admin/overview/route.ts`, find the `SystemHealth` interface / response shape (around lines 28-34). Add an `emailHealth` object:

```typescript
export interface OverviewData {
  systemHealth: {
    pendingOutbox: number;
    failedJobs: number;
    todayCostUsd: number;
    notificationFailures24h: number;
    emailHealth: {
      sent24h: number;
      delivered24h: number;
      bounces7d: number;
      complaints7d: number;
      hardBounces7d: number;
      deliveryRate24h: number; // 0-100
      redState: boolean;
    };
  };
  businesses: BusinessRow[];
  totalBusinesses: number;
}
```

Then find the `Promise.all` block that runs the system health queries. Add an emailHealth query AFTER `notifFailureRows`:

```typescript
      sql<{
        sent_24h: number;
        delivered_24h: number;
        bounces_7d: number;
        hard_bounces_7d: number;
        complaints_7d: number;
      }[]>`
        SELECT
          COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '24 hours')::int AS sent_24h,
          COUNT(*) FILTER (WHERE delivered_at IS NOT NULL AND sent_at >= NOW() - INTERVAL '24 hours')::int AS delivered_24h,
          COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS bounces_7d,
          COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:permanent%' OR failure_reason LIKE 'bounced:hard%' OR failure_reason LIKE 'bounced:permanent_failure%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS hard_bounces_7d,
          COUNT(*) FILTER (WHERE failure_reason = 'complained' AND failed_at >= NOW() - INTERVAL '7 days')::int AS complaints_7d
        FROM notification_deliveries
      `,
```

Destructure the result alongside the other rows, and build the emailHealth object:

```typescript
    const eh = emailHealthRows[0];
    const sent24h = eh?.sent_24h ?? 0;
    const delivered24h = eh?.delivered_24h ?? 0;
    const deliveryRate24h = sent24h > 0 ? Math.round((delivered24h / sent24h) * 100) : 100;
    const bounces7d = eh?.bounces_7d ?? 0;
    const hardBounces7d = eh?.hard_bounces_7d ?? 0;
    const complaints7d = eh?.complaints_7d ?? 0;

    // Red state: delivery rate < 95% with at least 5 sends, OR any complaint in 7d, OR any hard bounce in 7d.
    const redState =
      (sent24h >= 5 && deliveryRate24h < 95) ||
      complaints7d > 0 ||
      hardBounces7d > 0;

    const data: OverviewData = {
      systemHealth: {
        pendingOutbox: pendingOutboxRows[0]?.count ?? 0,
        failedJobs: failedJobsRows[0]?.count ?? 0,
        todayCostUsd: todayCostRows[0]?.total ?? 0,
        notificationFailures24h: notifFailureRows[0]?.count ?? 0,
        emailHealth: {
          sent24h,
          delivered24h,
          bounces7d,
          complaints7d,
          hardBounces7d,
          deliveryRate24h,
          redState,
        },
      },
      // ...
    };
```

- [ ] **Step 2: Update overview page UI**

In `src/app/admin/overview/page.tsx`, find the system health bar section (look for `<HealthCard`). Add an Email Health card:

```tsx
      <div className={`rounded-lg p-4 ${data.systemHealth.emailHealth.redState ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'}`}>
        <p className="text-sm font-medium text-gray-600">Email Health</p>
        <p className={`text-2xl font-bold ${data.systemHealth.emailHealth.redState ? 'text-red-700' : 'text-green-700'}`}>
          {data.systemHealth.emailHealth.deliveryRate24h}%
        </p>
        <p className="text-xs text-gray-500">
          {data.systemHealth.emailHealth.sent24h} sent (24h) ·{' '}
          {data.systemHealth.emailHealth.hardBounces7d} hard bounces ·{' '}
          {data.systemHealth.emailHealth.complaints7d} complaints (7d)
        </p>
      </div>
```

- [ ] **Step 3: Run tests + build**

Run: `pnpm tsc --noEmit && pnpm test && pnpm build`
Expected: No errors. If `src/app/api/admin/overview/__tests__/route.test.ts` exists and tests the response shape, update it to include the new `emailHealth` field in mock SQL results and response assertions.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/overview/route.ts src/app/admin/overview/page.tsx
git commit -m "feat(20d): admin overview shows email health card with delivery rate + bounces"
```

---

## Task 8: Business Detail Bounced-Email Warning Banner + Clear-Flag Action

**Files:**
- Modify: `src/app/api/admin/businesses/[id]/route.ts` (GET returns `ownerEmailBounced`, PATCH accepts `ownerEmailBounced`)
- Modify: `src/app/admin/businesses/[id]/page.tsx` (warning banner + clear button)
- Modify: `src/lib/shared/schemas.ts` (UpdateBusinessSchema accepts `ownerEmailBounced`)

- [ ] **Step 1: Add ownerEmailBounced to GET response**

In `src/app/api/admin/businesses/[id]/route.ts`, find the SELECT in the GET handler. Add `owner_email_bounced` to the column list. In the response mapping, add `ownerEmailBounced: row.owner_email_bounced ?? false`.

- [ ] **Step 2: Allow clearing the flag via PATCH**

In the same file, find the `FIELD_TO_COLUMN` constant. Add:

```typescript
const FIELD_TO_COLUMN: Record<string, string> = {
  // ... existing ...
  website: 'website',
  ownerEmailBounced: 'owner_email_bounced',
};
```

In `src/lib/shared/schemas.ts`, add to `UpdateBusinessSchema`:

```typescript
    ownerEmailBounced: z.boolean().optional(),
```

- [ ] **Step 3: Add warning banner + clear button to business detail page**

In `src/app/admin/businesses/[id]/page.tsx`:

1. Add `ownerEmailBounced: boolean` to `BusinessDetail` interface.
2. After the business header (find the `<h1>` with `{business.name}`), insert:

```tsx
      {business.ownerEmailBounced && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-800">
            ⚠ Owner email is bouncing
          </p>
          <p className="mt-1 text-sm text-red-700">
            Approval emails, weekly reports, monthly impact, drip emails, and owner nudges
            are skipped for <code className="px-1 bg-red-100 rounded">{business.ownerEmail}</code>.
            Partner/admin alerts still send.
          </p>
          <p className="mt-2 text-sm text-red-700">
            Verify the email address with the owner. Update it above if needed, then clear
            this flag below. See <code>docs/email-deliverability.md</code> for the full
            runbook.
          </p>
          <button
            type="button"
            onClick={async () => {
              if (!confirm('Clear the bounce flag? Only do this after verifying the address is valid.')) return;
              const res = await fetch(`/api/admin/businesses/${business.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ownerEmailBounced: false }),
              });
              if (res.ok) {
                queryClient.invalidateQueries({ queryKey: ['business-detail', business.id] });
              } else {
                alert('Failed to clear flag. See console.');
              }
            }}
            className="mt-3 rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
          >
            Clear bounce flag (after verifying address)
          </button>
        </div>
      )}
```

Note: `queryClient` comes from the existing `useQueryClient()` hook usage in this file.

- [ ] **Step 4: Run tests + build**

Run: `pnpm tsc --noEmit && pnpm test && pnpm build`
Expected: No errors. Existing business detail tests may need the new field in mock responses.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/businesses/\[id\]/route.ts src/app/admin/businesses/\[id\]/page.tsx src/lib/shared/schemas.ts
git commit -m "feat(20d): business detail shows bounce warning + admin clear-flag action"
```

---

## Task 9: Email Deliverability Documentation

**Files:**
- Create: `docs/email-deliverability.md`

- [ ] **Step 1: Write the doc**

Create `docs/email-deliverability.md`:

```markdown
# Email Deliverability Runbook

Operational guide for getting approval emails and owner reports into inboxes
(not spam) at RepWorth's scale (10-20 customers in first month).

## DNS Authentication

All three MUST be published before sending to real customers.

### SPF
Resend handles this automatically via their Amazon SES infrastructure.
Verify in Resend dashboard: **Domains → your-domain → SPF → green check**.

### DKIM
Resend provides 3 CNAME records during domain verification. Publish all 3.
Verify: `dig CNAME <key>._domainkey.your-domain.com` resolves.

### DMARC
Add a TXT record at `_dmarc.your-domain.com`:

```
v=DMARC1; p=none; rua=mailto:dmarc@your-domain.com
```

- Start with `p=none` (monitor only) for 2 weeks.
- After aggregate reports show clean sends, tighten to `p=quarantine`.
- Move to `p=reject` after another 2-4 weeks of clean reports.

## Warmup Schedule

New sending domains need a ramp. Sending 100 emails from a cold domain on
day one is a reliable way to get the domain blacklisted.

| Week | Daily volume | Source |
|------|-------------|--------|
| 1 | 5-10 emails | Internal test accounts + demo businesses with your own email |
| 2 | 20-30 emails | First 2-3 real customers |
| 3+ | Organic | Natural volume from customer activity |

**Hard rule:** Stagger onboarding to 2-3 customers per week during the first month.
Do NOT onboard 10 customers in one day — the email burst will hurt reputation.

## Monitoring

### Daily (2 minutes)
- Admin overview → Email Health card
- Delivery rate >95%? No complaints this week? If both yes: green. Move on.

### Weekly (5 minutes)
- Resend dashboard → Domains → delivery rate, bounces, complaints
- Check admin overview for hard bounces. Each hard bounce should correspond
  to an `admin@...` alert email (see Hard Bounce section below).

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Email went to spam | Recipient's spam folder | Ask recipient to mark as "not spam". Verify SPF/DKIM/DMARC are all green. |
| Hard bounce | Recipient email is invalid | Business flagged automatically (`owner_email_bounced=true`). Verify address with owner. Update in admin. Clear flag. |
| Soft bounce | Mailbox full / temporarily unavailable | No action — notification failover poller retries. |
| Complaint | Recipient marked as spam | Check email content + frequency. Admin overview → Email Health card goes red. Consider manual reach-out. |

## Hard Bounce Flow

When Resend reports `email.bounced` with `bounce.type = permanent`:

1. Webhook handler (`worker/ingress/resend.ts`) sets `businesses.owner_email_bounced = true`.
2. Admin receives an internal email alert at `ADMIN_NOTIFICATION_EMAIL`.
3. Owner-directed workers skip this business:
   - Approval emails (`NotificationWorker`)
   - Weekly value reports (`WeeklySummaryWorker`)
   - Monthly impact reports (`MonthlyImpactWorker`)
   - Onboarding drips (`OnboardingDripWorker`)
   - Owner nudges (`EngagementAlertWorker`)
4. Partner/admin alerts still flow (manual-post instructions, exceptions, partner
   engagement alerts). Those go to the admin, not the owner.

### Clearing the Flag

Once the address is verified/updated:

1. Open `/admin/businesses/[id]`
2. Update the `ownerEmail` if needed.
3. Click "Clear bounce flag (after verifying address)" in the red warning banner.
4. Next owner-directed event (approval, weekly report, etc.) will send normally.

## Env Vars

| Var | Required? | Purpose |
|-----|-----------|---------|
| `RESEND_API_KEY` | Yes | Resend SDK auth |
| `RESEND_WEBHOOK_SECRET` | Yes in prod | Svix signature verification for delivery webhooks |
| `RESEND_FROM_EMAIL` | Yes | `RepWorth <notifications@your-domain.com>` — verified sender |
| `LIST_UNSUBSCRIBE_EMAIL` | No | Defaults to mailbox extracted from `RESEND_FROM_EMAIL` |
| `ADMIN_NOTIFICATION_EMAIL` | Yes | Admin recipient for hard bounce / exception / partner alerts |

## List-Unsubscribe Compliance

Gmail and Outlook (Feb 2024) require bulk senders to provide one-click
unsubscribe. Our implementation:

- Marketing emails (weekly/monthly/drip/nudge) include:
  - `List-Unsubscribe: <mailto:unsubscribe@...>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- Transactional emails (approval) do NOT — these are necessary for service
  operation, not marketing. Bulk-sender rules don't apply.
- Internal emails (partner alerts, admin exceptions) do NOT — these go to
  the admin, not to customers.
```

- [ ] **Step 2: Commit**

```bash
git add -f docs/email-deliverability.md
git commit -m "docs(20d): email deliverability runbook + warmup schedule + troubleshooting"
```

---

## Task 10: Final Verification + Tracking Docs

- [ ] **Step 1: Full test + build verification**

```bash
pnpm test          # Expected: ~680+ tests pass
pnpm tsc --noEmit  # Expected: no errors
pnpm build         # Expected: success
```

- [ ] **Step 2: Manual smoke test (optional, requires Resend account + applied migration)**

1. In Supabase SQL editor, verify `businesses.owner_email_bounced` column exists (migration 017 applied).
2. Manually flag a test business: `UPDATE businesses SET owner_email_bounced = true WHERE id = '<test-biz>';`
3. Trigger an approval email flow for that business. Verify NotificationWorker logs "owner email bounced — skipping".
4. Clear the flag via the admin UI banner. Trigger again. Email should send.

- [ ] **Step 3: Update `.claude/CLAUDE.md` Sprint 6 status**

Append to the Sprint 6 entry:

```markdown
  - Prompt 20d (Email Deliverability + Hard Bounce Handling): COMPLETE (2026-04-17) — `EmailCategory` type + `getEmailHeaders`/`getEmailTags` helpers. `sendApprovalEmail` is transactional (no List-Unsubscribe); `sendInternalEmail` has optional `category` param, marketing sends get List-Unsubscribe + List-Unsubscribe-Post headers. All owner-directed workers (Notification, WeeklySummary, MonthlyImpact, OnboardingDrip, EngagementAlert owner_nudge) pass `category: 'marketing'` and skip businesses with `owner_email_bounced=true`. Partner/internal alerts pass `category: 'internal'`. Resend webhook defensively extracts bounce type from `data.bounce.type` / `data.reason` / `data.status`; hard bounces set `owner_email_bounced=true` + notify admin. EngagementMonitorPoller skips owner_nudge rule for bounced businesses. Admin overview shows Email Health card (delivery rate 24h, bounces/hard-bounces/complaints 7d, red state < 95% with 5+ sends or any complaint/hard-bounce in 7d). Business detail page shows bounced-email warning banner + admin Clear-Flag action. `docs/email-deliverability.md` covers DNS auth, warmup schedule, monitoring, troubleshooting. Test count: TBD after implementation.
```

Also update the test count (will be ~680+ by end of this prompt).

- [ ] **Step 4: Update `docs/progresstracking.md`**

Add a section under Sprint 6:

```markdown
### Prompt 20d — Email Deliverability + Hard Bounce Handling (2026-04-17)

**Status:** COMPLETE

**Email categorization:**
- New `EmailCategory` type: `'transactional' | 'marketing' | 'internal'`.
- `getEmailHeaders(category)`: marketing gets `List-Unsubscribe: <mailto:...>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Others get empty headers.
- `getEmailTags(category)`: always a single `[{ name: 'category', value: category }]` for Resend dashboard filtering.
- `sendApprovalEmail`: transactional. No unsubscribe header (not marketing).
- `sendInternalEmail(params: { ..., category? })`: defaults to internal. Pass explicit `category: 'marketing'` for owner-directed recurring emails.

**Hard bounce handling:**
- `worker/ingress/resend.ts` defensively extracts bounce type from `data.bounce.type`, `data.reason`, or `data.status`. Falls back to `'unknown'` (not treated as hard).
- Hard bounces (`permanent`, `hard`, `hardbounce`, `permanent_failure`, or anything containing `permanent`) set `businesses.owner_email_bounced = true` and send a one-time admin alert to `ADMIN_NOTIFICATION_EMAIL`.
- `notification_deliveries.failure_reason` set to `bounced:<type>` for attribution.
- Complaints set `failure_reason = 'complained'` but do NOT flag the business.

**Skip-if-bounced guards:**
- `NotificationWorker`, `WeeklySummaryWorker`, `MonthlyImpactWorker`, `OnboardingDripWorker`, `EngagementAlertWorker.handleOwnerNudge` check `owner_email_bounced` and complete outbox + return if true.
- `EngagementMonitorPoller` excludes bounced businesses from the owner_nudge rule at query time (partner rules still fire).
- Partner alerts (`partner_engagement_alert`, `partner_escalation_alert`, `partner_low_engagement`, `partner_satisfaction_alert`) go to admin — unaffected by bounce.
- Manual-post instructions + exception alerts go to admin — unaffected.

**Admin visibility:**
- Admin overview shows "Email Health" card: 24h delivery rate (% color-coded), 24h sent count, 7d hard-bounce count, 7d complaint count. Red state when delivery rate < 95% (with ≥5 sends) OR any complaint in 7d OR any hard bounce in 7d.
- Business detail page shows a red warning banner when `owner_email_bounced = true` with explanation and a "Clear bounce flag" button that PATCHes `ownerEmailBounced: false`.

**Documentation:**
- `docs/email-deliverability.md` covers DNS auth (SPF, DKIM, DMARC), warmup schedule (week 1-3+), daily/weekly monitoring, troubleshooting table, hard bounce flow, env vars, List-Unsubscribe compliance rationale.

**Tests:** ~20 new tests across `email-headers.test.ts` (8), `email-send.test.ts` (4), `resend-webhook-bounce.test.ts` (5), `bounced-skip.test.ts` (4).

**Migration prerequisite:** `017_sprint6_scale.sql` must be applied to Supabase (adds `businesses.owner_email_bounced`). Already on disk.

**Commits:** TBD after implementation.
```

- [ ] **Step 5: Final commit**

```bash
git add .claude/CLAUDE.md && git add -f docs/progresstracking.md
git commit -m "docs: track Prompt 20d completion"
```
