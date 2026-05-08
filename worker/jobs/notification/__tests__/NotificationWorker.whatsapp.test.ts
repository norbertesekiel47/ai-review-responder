// worker/jobs/__tests__/NotificationWorker.whatsapp.test.ts
//
// Unit tests for the WhatsApp error-branch logic in NotificationWorker.
// Uses mock SQL + mock channel factory — no real DB connection required.
//
// THE CONFIG-ERROR REGRESSION GUARD (test #3) is the single most critical
// test in this file. It MUST verify that WhatsAppTemplateConfigError leaves
// enrollment status UNCHANGED (still 'verified'). Without it, a future
// "catch all WhatsApp errors and flip unsubscribed" patch would silently
// break every paying WhatsApp customer whenever Meta pauses the template.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// 1. Hoist all mutable state so vi.mock factories can close over it.
// ---------------------------------------------------------------------------
const {
  sqlQueue,
  consume,
  sqlCalls,
  insertFailedDeliveryCalls,
  mockInsertFailedDelivery,
  mockRecordNotificationDelivery,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockCheckSubscription,
  mockGetVerifiedEnrollments,
  mockGetChannel,
  mockCreateApprovalLink,
} = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];

  // sql tag fn — records call and returns next queued value
  const consume = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ template: strings.join('?'), values });
    const next = sqlQueue.shift();
    return Promise.resolve(Array.isArray(next) ? next : []);
  });

  const insertFailedDeliveryCalls: Array<Parameters<typeof mockInsertFailedDelivery>> = [];
  const mockInsertFailedDelivery = vi.fn((...args: unknown[]) => {
    insertFailedDeliveryCalls.push(args as any);
    return Promise.resolve();
  });

  const mockRecordNotificationDelivery = vi.fn(() => Promise.resolve());
  const mockMarkOutboxCompleted = vi.fn(() => Promise.resolve());
  const mockMarkOutboxFailed = vi.fn(() => Promise.resolve());
  const mockCheckSubscription = vi.fn(() => ({ allowed: true, reason: '' }));
  const mockGetVerifiedEnrollments = vi.fn(() =>
    Promise.resolve([{ channel: 'whatsapp' as const, handle: '+15550000001' }]),
  );
  const mockGetChannel = vi.fn();
  const mockCreateApprovalLink = vi.fn(() =>
    Promise.resolve({ rawToken: 'raw-tok', tokenHash: 'hash', approvalLinkId: 'link-1' }),
  );

  return {
    sqlQueue,
    consume,
    sqlCalls,
    insertFailedDeliveryCalls,
    mockInsertFailedDelivery,
    mockRecordNotificationDelivery,
    mockMarkOutboxCompleted,
    mockMarkOutboxFailed,
    mockCheckSubscription,
    mockGetVerifiedEnrollments,
    mockGetChannel,
    mockCreateApprovalLink,
  };
});

// ---------------------------------------------------------------------------
// 2. Module-level mocks (must be before any import of the module under test).
// ---------------------------------------------------------------------------

// NotificationWorker.ts uses relative paths to src/ — match the resolved module IDs
// by using the @/ alias which vitest resolves to the same files.
vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, {
    begin: async (fn: (tx: typeof consume) => Promise<unknown>) => fn(consume),
  }),
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/notifications/delivery', () => ({
  insertFailedDelivery: mockInsertFailedDelivery,
  recordNotificationDelivery: mockRecordNotificationDelivery,
}));

vi.mock('@/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: d && typeof d.outbox_id === 'string' ? d.outbox_id : fallback,
    attempt: d && typeof d.outbox_attempt === 'number' ? d.outbox_attempt : undefined,
  }),
}));

vi.mock('@/lib/shared/subscription-guard', () => ({
  checkSubscription: mockCheckSubscription,
}));

vi.mock('@/lib/notifications/enrollments', () => ({
  getVerifiedEnrollments: mockGetVerifiedEnrollments,
}));

vi.mock('@/lib/notifications/channels', async () => {
  // Re-export the real error classes so instanceof checks work in the worker.
  const actual = await vi.importActual<typeof import('@/lib/notifications/channels')>(
    '@/lib/notifications/channels',
  );
  return {
    ...actual,
    getChannel: mockGetChannel,
  };
});

vi.mock('@/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));

// SMS cost helpers — not exercised by WhatsApp tests but imported by the worker.
vi.mock('@/lib/costs/sms-tracker', () => ({
  reserveSmsCost: vi.fn(() => Promise.resolve('2026-04-23')),
  refundSmsCost: vi.fn(() => Promise.resolve()),
  DailySmsLimitExceededError: class extends Error {},
}));

// ---------------------------------------------------------------------------
// 3. Import the module under test AFTER all vi.mock calls.
// ---------------------------------------------------------------------------
import { handleSendNotification } from '../NotificationWorker';
import {
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
  WhatsAppTemplateConfigError,
  WhatsAppSessionWindowError,
  WhatsAppRateLimitError,
} from '@/lib/notifications/channels';

// ---------------------------------------------------------------------------
// 4. Test helpers.
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<{ response_id: string; business_id: string; outbox_id: string }> = {}): Job<any> {
  return {
    id: 'job-1',
    data: {
      response_id: overrides.response_id ?? 'resp-1',
      business_id: overrides.business_id ?? 'biz-1',
      outbox_id: overrides.outbox_id ?? 'outbox-1',
      correlation_id: 'corr-1',
    },
  } as unknown as Job<any>;
}

/**
 * Seed the SQL queue with the two rows every successful "get past guards" flow
 * requires: response lookup JOIN reviews, and business lookup.
 */
function seedResponseAndBusiness() {
  // Row 1: responses JOIN reviews
  sqlQueue.push([{
    id: 'resp-1',
    response_text: 'Thanks for your review!',
    status: 'pending_approval',
    resp_business_id: 'biz-1',
    review_id: 'rev-1',
    reviewer_name: 'Jane Doe',
    star_rating: 4,
    review_text: 'Great place',
    review_date: '2026-04-20',
  }]);
  // Row 2: business
  sqlQueue.push([{
    name: 'Acme Corp',
    owner_email_bounced: false,
    subscription_status: 'active',
    account_updated_at: new Date('2026-04-01'),
  }]);
}

/**
 * Queue the "no existing delivery" row (normal mode skips if sent_at IS NOT NULL AND failed_at IS NULL).
 * An empty array means no such delivery found — proceed to send.
 */
function seedNoExistingDelivery() {
  sqlQueue.push([]); // SELECT from notification_deliveries — no prior successful delivery
}

beforeEach(() => {
  // Reset all state between tests.
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  insertFailedDeliveryCalls.length = 0;

  consume.mockClear();
  mockInsertFailedDelivery.mockClear();
  mockRecordNotificationDelivery.mockClear();
  mockMarkOutboxCompleted.mockClear();
  mockMarkOutboxFailed.mockClear();
  mockGetVerifiedEnrollments.mockClear();
  mockGetChannel.mockClear();
  mockCreateApprovalLink.mockClear();

  // Default: single whatsapp enrollment.
  mockGetVerifiedEnrollments.mockResolvedValue([
    { channel: 'whatsapp', handle: '+15550000001' },
  ]);

  // Default: subscription allowed.
  mockCheckSubscription.mockReturnValue({ allowed: true, reason: '' });

  process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
  process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
});

// ---------------------------------------------------------------------------
// 5. Tests.
// ---------------------------------------------------------------------------

describe('NotificationWorker — WhatsApp error branches', () => {
  // -------------------------------------------------------------------------
  // Test 1: OWNER-INTENT — RecipientBlocked → unsubscribed
  // -------------------------------------------------------------------------
  it('WhatsAppRecipientBlockedError: flips enrollment to unsubscribed and records failed delivery', async () => {
    seedResponseAndBusiness();
    seedNoExistingDelivery();

    const mockSendApprovalRequest = vi.fn().mockRejectedValueOnce(
      new WhatsAppRecipientBlockedError(63014),
    );
    mockGetChannel.mockReturnValue({ sendApprovalRequest: mockSendApprovalRequest });

    // All channels failed → the worker throws so BullMQ can retry.
    // But the enrollment flip + failed delivery must be recorded before the throw.
    await expect(handleSendNotification(makeJob())).rejects.toThrow();

    // Enrollment UPDATE must have been executed via sql.begin
    const enrollmentUpdate = sqlCalls.find(
      (c) => c.template.includes('channel_enrollments') && c.template.includes("status = 'unsubscribed'"),
    );
    expect(enrollmentUpdate, 'expected channel_enrollments UPDATE to unsubscribed').toBeDefined();
    expect(enrollmentUpdate!.template).toMatch(/unsubscribed_reason/);

    // Channel is a literal in the SQL template, handle is a bound value.
    expect(enrollmentUpdate!.template).toMatch(/channel = 'whatsapp'/);
    expect(enrollmentUpdate!.values).toContain('+15550000001');

    // Failed delivery must be recorded with reason 'whatsapp_blocked'
    expect(mockInsertFailedDelivery).toHaveBeenCalledOnce();
    const [_biz, _resp, channel, handle, reason] = mockInsertFailedDelivery.mock.calls[0]!;
    expect(channel).toBe('whatsapp');
    expect(handle).toBe('+15550000001');
    expect(reason).toBe('whatsapp_blocked');
  });

  // -------------------------------------------------------------------------
  // Test 2: OWNER-INTENT — InvalidRecipient → disabled
  // -------------------------------------------------------------------------
  it('WhatsAppInvalidRecipientError: flips enrollment to disabled and records failed delivery', async () => {
    seedResponseAndBusiness();
    seedNoExistingDelivery();

    mockGetChannel.mockReturnValue({
      sendApprovalRequest: vi.fn().mockRejectedValueOnce(
        new WhatsAppInvalidRecipientError(63024),
      ),
    });

    await expect(handleSendNotification(makeJob())).rejects.toThrow();

    // Enrollment UPDATE must set status='disabled' and disabled_at
    const enrollmentUpdate = sqlCalls.find(
      (c) => c.template.includes('channel_enrollments') && c.template.includes("status = 'disabled'"),
    );
    expect(enrollmentUpdate, 'expected channel_enrollments UPDATE to disabled').toBeDefined();
    expect(enrollmentUpdate!.template).toMatch(/disabled_at/);
    // Channel is a literal in the SQL template, handle is a bound value.
    expect(enrollmentUpdate!.template).toMatch(/channel = 'whatsapp'/);
    expect(enrollmentUpdate!.values).toContain('+15550000001');

    expect(mockInsertFailedDelivery).toHaveBeenCalledOnce();
    const [, , channel, handle, reason] = mockInsertFailedDelivery.mock.calls[0]!;
    expect(channel).toBe('whatsapp');
    expect(handle).toBe('+15550000001');
    expect(reason).toBe('whatsapp_invalid_recipient');
  });

  // -------------------------------------------------------------------------
  // Test 3: CONFIG-ERROR REGRESSION GUARD — TemplateConfigError
  //
  // THIS IS THE MOST CRITICAL TEST IN THE FILE.
  //
  // WhatsAppTemplateConfigError is a RepWorth-side ops problem (Meta paused /
  // misconfigured our template). It is NOT the owner's choice to stop receiving
  // WhatsApp notifications. Flipping enrollment to 'unsubscribed' here would
  // silently break every paying WhatsApp customer when Meta pauses the template.
  //
  // Assert: NO UPDATE is issued to channel_enrollments for this error.
  // -------------------------------------------------------------------------
  it('CONFIG-ERROR GUARD — WhatsAppTemplateConfigError: enrollment status UNCHANGED, only failed delivery recorded', async () => {
    seedResponseAndBusiness();
    seedNoExistingDelivery();

    mockGetChannel.mockReturnValue({
      sendApprovalRequest: vi.fn().mockRejectedValueOnce(
        new WhatsAppTemplateConfigError(63040),
      ),
    });

    await expect(handleSendNotification(makeJob())).rejects.toThrow();

    // CRITICAL: NO channel_enrollments UPDATE should have been issued.
    const enrollmentUpdates = sqlCalls.filter((c) =>
      c.template.includes('channel_enrollments') &&
      (c.template.includes('UPDATE') || c.template.includes("status = '")),
    );
    expect(
      enrollmentUpdates,
      'CONFIG-ERROR regression: channel_enrollments must NOT be updated for WhatsAppTemplateConfigError',
    ).toHaveLength(0);

    // Failed delivery MUST be recorded with a reason prefixed whatsapp_template_config:
    expect(mockInsertFailedDelivery).toHaveBeenCalledOnce();
    const [, , channel, handle, reason] = mockInsertFailedDelivery.mock.calls[0]!;
    expect(channel).toBe('whatsapp');
    expect(handle).toBe('+15550000001');
    expect(reason).toMatch(/^whatsapp_template_config:/);
  });

  // -------------------------------------------------------------------------
  // Test 4: CONFIG-ERROR — SessionWindowError → same as TemplateConfigError
  // -------------------------------------------------------------------------
  it('CONFIG-ERROR — WhatsAppSessionWindowError: enrollment UNCHANGED, failed delivery with whatsapp_session_window: prefix', async () => {
    seedResponseAndBusiness();
    seedNoExistingDelivery();

    mockGetChannel.mockReturnValue({
      sendApprovalRequest: vi.fn().mockRejectedValueOnce(
        new WhatsAppSessionWindowError(63016),
      ),
    });

    await expect(handleSendNotification(makeJob())).rejects.toThrow();

    // No enrollment mutation
    const enrollmentUpdates = sqlCalls.filter((c) =>
      c.template.includes('channel_enrollments') &&
      (c.template.includes('UPDATE') || c.template.includes("status = '")),
    );
    expect(
      enrollmentUpdates,
      'CONFIG-ERROR regression: channel_enrollments must NOT be updated for WhatsAppSessionWindowError',
    ).toHaveLength(0);

    expect(mockInsertFailedDelivery).toHaveBeenCalledOnce();
    const [, , channel, handle, reason] = mockInsertFailedDelivery.mock.calls[0]!;
    expect(channel).toBe('whatsapp');
    expect(handle).toBe('+15550000001');
    expect(reason).toMatch(/^whatsapp_session_window:/);
  });

  // -------------------------------------------------------------------------
  // Test 5: TRANSIENT — RateLimitError → enrollment UNCHANGED
  // -------------------------------------------------------------------------
  it('WhatsAppRateLimitError: enrollment UNCHANGED, failed delivery with whatsapp_rate_limit: prefix', async () => {
    seedResponseAndBusiness();
    seedNoExistingDelivery();

    mockGetChannel.mockReturnValue({
      sendApprovalRequest: vi.fn().mockRejectedValueOnce(
        new WhatsAppRateLimitError(63017),
      ),
    });

    await expect(handleSendNotification(makeJob())).rejects.toThrow();

    // No enrollment mutation
    const enrollmentUpdates = sqlCalls.filter((c) =>
      c.template.includes('channel_enrollments') &&
      (c.template.includes('UPDATE') || c.template.includes("status = '")),
    );
    expect(enrollmentUpdates, 'TRANSIENT: channel_enrollments must NOT be updated for rate limit').toHaveLength(0);

    expect(mockInsertFailedDelivery).toHaveBeenCalledOnce();
    const [, , channel, handle, reason] = mockInsertFailedDelivery.mock.calls[0]!;
    expect(channel).toBe('whatsapp');
    expect(handle).toBe('+15550000001');
    expect(reason).toMatch(/^whatsapp_rate_limit:/);
  });

  // -------------------------------------------------------------------------
  // Test 6: Flag off — dispatcher skips whatsapp entirely
  // -------------------------------------------------------------------------
  it('CHANNELS_WHATSAPP_ENABLED=false: dispatcher skips whatsapp enrollment, no sendApprovalRequest call', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'false';

    // Business has only a whatsapp enrollment — but with the flag off the
    // dispatcher should skip it and mark outbox completed (0 attempted).
    seedResponseAndBusiness();
    // No delivery-check row needed because we skip before that query.

    await handleSendNotification(makeJob());

    // getChannel / sendApprovalRequest must NEVER have been called.
    expect(mockGetChannel).not.toHaveBeenCalled();

    // No failed delivery row.
    expect(mockInsertFailedDelivery).not.toHaveBeenCalled();

    // No successful delivery row either.
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();

    // Outbox must be completed (0 attempted → no throw path).
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });
});
