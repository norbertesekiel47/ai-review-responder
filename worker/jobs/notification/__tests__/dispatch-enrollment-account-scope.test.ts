// worker/jobs/notification/__tests__/dispatch-enrollment-account-scope.test.ts
//
// Regression guard for the dispatcher failure-handling enrollment-write scoping
// contract (was: "writes still key by business_id").
//
// The four send-failure branches that flip channel_enrollments.status
// (telegram_blocked, telegram_chat_not_found, whatsapp_blocked,
// whatsapp_invalid_recipient) must scope the UPDATE by account_id + the
// enrollment's location scope, NOT by business_id. An org-default row
// (location_id IS NULL) on a multi-location account carries a legacy
// business_id from its original INSERT, so a WHERE business_id = ctx.businessId
// can MISS it. The fix keys org-default rows by account_id + location_id IS NULL
// and per-location overrides by account_id + location_id = <id>.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';

// ---------------------------------------------------------------------------
// Hoisted mutable state for the mock SQL recorder + collaborator mocks.
// ---------------------------------------------------------------------------
const {
  sqlQueue,
  consume,
  sqlCalls,
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

  const consume = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ template: strings.join('?'), values });
    const next = sqlQueue.shift();
    return Promise.resolve(Array.isArray(next) ? next : []);
  });

  return {
    sqlQueue,
    consume,
    sqlCalls,
    mockInsertFailedDelivery: vi.fn(() => Promise.resolve()),
    mockRecordNotificationDelivery: vi.fn(() => Promise.resolve()),
    mockMarkOutboxCompleted: vi.fn(() => Promise.resolve()),
    mockMarkOutboxFailed: vi.fn(() => Promise.resolve()),
    mockCheckSubscription: vi.fn(() => ({ allowed: true, reason: '' })),
    mockGetVerifiedEnrollments: vi.fn(),
    mockGetChannel: vi.fn(),
    mockCreateApprovalLink: vi.fn(() =>
      Promise.resolve({ rawToken: 'raw-tok', tokenHash: 'hash', approvalLinkId: 'link-1' }),
    ),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, {
    begin: async (fn: (tx: typeof consume) => Promise<unknown>) => fn(consume),
  }),
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/notifications/delivery', () => ({
  insertFailedDelivery: mockInsertFailedDelivery,
  recordNotificationDelivery: mockRecordNotificationDelivery,
  insertPendingApprovalDelivery: vi.fn(() => Promise.resolve('pending-delivery-1')),
  finalizeDeliverySent: vi.fn(() => Promise.resolve()),
  failDelivery: vi.fn(() => Promise.resolve()),
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

vi.mock('@/lib/notifications/resolve-channels', () => ({
  resolveChannels: mockGetVerifiedEnrollments,
  invalidateChannelCache: vi.fn().mockResolvedValue(undefined),
  safeInvalidateChannelCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(0),
  }),
}));

vi.mock('@/lib/notifications/channels', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications/channels')>(
    '@/lib/notifications/channels',
  );
  return { ...actual, getChannel: mockGetChannel };
});

vi.mock('@/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));


import { handleSendNotification } from '../NotificationWorker';
import {
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
} from '@/lib/notifications/channels';

// ---------------------------------------------------------------------------
// Fixtures. The org-default row's business_id (ctx.businessId) differs from the
// value that would have been written into channel_enrollments.business_id on
// the original INSERT, which is exactly the scenario that breaks a
// business_id-keyed UPDATE on a multi-location account.
// ---------------------------------------------------------------------------
const ACCOUNT_ID = 'acct-multiloc';
const CTX_BUSINESS_ID = 'biz-location-B';
const OVERRIDE_LOCATION_ID = '0190b0c0-0000-7000-8000-000000000abc';

function makeJob(): Job<any> {
  return {
    id: 'job-1',
    data: {
      response_id: 'resp-1',
      business_id: CTX_BUSINESS_ID,
      outbox_id: 'outbox-1',
      correlation_id: 'corr-1',
    },
  } as unknown as Job<any>;
}

function seedResponseAndBusiness() {
  sqlQueue.push([{
    id: 'resp-1',
    response_text: 'Thanks for your review!',
    status: 'pending_approval',
    resp_business_id: CTX_BUSINESS_ID,
    review_id: 'rev-1',
    reviewer_name: 'Jane Doe',
    star_rating: 4,
    review_text: 'Great place',
    review_date: '2026-04-20',
  }]);
  sqlQueue.push([{
    name: 'Acme Corp',
    owner_email_bounced: false,
    archived_at: null,
    subscription_status: 'active',
    account_updated_at: new Date('2026-04-01'),
    account_id: ACCOUNT_ID,
  }]);
}

function seedNoExistingDelivery() {
  sqlQueue.push([]);
}

function findEnrollmentUpdate() {
  return sqlCalls.find(
    (c) => c.template.includes('UPDATE') && c.template.includes('channel_enrollments'),
  );
}

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;

  consume.mockClear();
  mockInsertFailedDelivery.mockClear();
  mockRecordNotificationDelivery.mockClear();
  mockMarkOutboxCompleted.mockClear();
  mockMarkOutboxFailed.mockClear();
  mockGetVerifiedEnrollments.mockClear();
  mockGetChannel.mockClear();
  mockCreateApprovalLink.mockClear();

  mockCheckSubscription.mockReturnValue({ allowed: true, reason: '' });

  process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
  process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
  process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
});

describe('dispatcher failure writes — account + location scoping', () => {
  it('org-default row (location_id IS NULL): scopes UPDATE by account_id + location_id IS NULL, never by business_id', async () => {
    // Org-default enrollment: location_id null. ctx.businessId is a DIFFERENT
    // location than whatever business_id the row was inserted under.
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'whatsapp', handle: '+15550000001', location_id: null },
    ]);

    seedResponseAndBusiness();
    seedNoExistingDelivery();

    mockGetChannel.mockReturnValue({
      sendApprovalRequest: vi.fn().mockRejectedValueOnce(new WhatsAppRecipientBlockedError(63014)),
    });

    await expect(handleSendNotification(consume as unknown as Sql, makeJob())).rejects.toThrow();

    const update = findEnrollmentUpdate();
    expect(update, 'expected a channel_enrollments UPDATE').toBeDefined();

    // Must NOT key by business_id any more.
    expect(update!.template).not.toMatch(/business_id/);
    expect(update!.values).not.toContain(CTX_BUSINESS_ID);

    // Must be account-scoped (bound value) + channel literal + handle bound.
    expect(update!.template).toMatch(/account_id = /);
    expect(update!.values).toContain(ACCOUNT_ID);
    expect(update!.template).toMatch(/channel = 'whatsapp'/);
    expect(update!.values).toContain('+15550000001');

    // Org-default location scope is a literal IS NULL, not a bound value.
    expect(update!.template).toMatch(/location_id IS NULL/);
    expect(update!.template).toMatch(/archived_at IS NULL/);

    expect(update!.template).toMatch(/status = 'unsubscribed'/);
  });

  it('per-location override (location_id set): scopes UPDATE by account_id + location_id = <id>::uuid', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'whatsapp', handle: '+15550000002', location_id: OVERRIDE_LOCATION_ID },
    ]);

    seedResponseAndBusiness();
    seedNoExistingDelivery();

    mockGetChannel.mockReturnValue({
      sendApprovalRequest: vi.fn().mockRejectedValueOnce(new WhatsAppInvalidRecipientError(63024)),
    });

    await expect(handleSendNotification(consume as unknown as Sql, makeJob())).rejects.toThrow();

    const update = findEnrollmentUpdate();
    expect(update, 'expected a channel_enrollments UPDATE').toBeDefined();

    expect(update!.template).not.toMatch(/business_id/);
    expect(update!.values).not.toContain(CTX_BUSINESS_ID);

    expect(update!.template).toMatch(/account_id = /);
    expect(update!.values).toContain(ACCOUNT_ID);
    expect(update!.template).toMatch(/channel = 'whatsapp'/);
    expect(update!.values).toContain('+15550000002');

    // Per-location override binds the location id (cast to uuid in SQL text).
    expect(update!.template).toMatch(/location_id = /);
    expect(update!.template).toMatch(/::uuid/);
    expect(update!.template).not.toMatch(/location_id IS NULL/);
    expect(update!.values).toContain(OVERRIDE_LOCATION_ID);

    expect(update!.template).toMatch(/status = 'disabled'/);
  });
});
