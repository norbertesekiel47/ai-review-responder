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
// Shared Postgres.js mock — LAZY + fragment-flattening, so the deduped
// flipEnrollmentStatus helper's nested `sql`` fragments flatten into ONE
// recorded `sqlCalls[i].text`/`.values` (exactly how Postgres.js composes them
// at runtime). A non-flattening mock would split the composed UPDATE across
// several recorded calls and hide the channel/status/location literals.
const {
  sqlReturnQueue,
  mockSql,
  sqlCalls,
  resetMockSql,
  mockInsertFailedDelivery,
  mockRecordNotificationDelivery,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockCheckSubscription,
  mockGetVerifiedEnrollments,
  mockGetChannel,
  mockCreateApprovalLink,
} = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return {
    ...createMockSql(),
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
  sql: mockSql,
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
  sqlReturnQueue.push([{
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
  sqlReturnQueue.push([{
    name: 'Acme Corp',
    owner_email_bounced: false,
    archived_at: null,
    subscription_status: 'active',
    account_updated_at: new Date('2026-04-01'),
    account_id: ACCOUNT_ID,
  }]);
}

function seedNoExistingDelivery() {
  sqlReturnQueue.push([]);
}

function findEnrollmentUpdate() {
  return sqlCalls.find(
    (c) => c.text.includes('UPDATE') && c.text.includes('channel_enrollments'),
  );
}

beforeEach(() => {
  resetMockSql();

  mockSql.mockClear();
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

    await expect(handleSendNotification(mockSql as unknown as Sql, makeJob())).rejects.toThrow();

    const update = findEnrollmentUpdate();
    expect(update, 'expected a channel_enrollments UPDATE').toBeDefined();

    // Must NOT key by business_id any more.
    expect(update!.text).not.toMatch(/business_id/);
    expect(update!.values).not.toContain(CTX_BUSINESS_ID);

    // Must be account-scoped (bound value) + channel literal + handle bound.
    expect(update!.text).toMatch(/account_id = /);
    expect(update!.values).toContain(ACCOUNT_ID);
    expect(update!.text).toMatch(/channel = 'whatsapp'/);
    expect(update!.values).toContain('+15550000001');

    // Org-default location scope is a literal IS NULL, not a bound value.
    expect(update!.text).toMatch(/location_id IS NULL/);
    expect(update!.text).toMatch(/archived_at IS NULL/);

    expect(update!.text).toMatch(/status = 'unsubscribed'/);
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

    await expect(handleSendNotification(mockSql as unknown as Sql, makeJob())).rejects.toThrow();

    const update = findEnrollmentUpdate();
    expect(update, 'expected a channel_enrollments UPDATE').toBeDefined();

    expect(update!.text).not.toMatch(/business_id/);
    expect(update!.values).not.toContain(CTX_BUSINESS_ID);

    expect(update!.text).toMatch(/account_id = /);
    expect(update!.values).toContain(ACCOUNT_ID);
    expect(update!.text).toMatch(/channel = 'whatsapp'/);
    expect(update!.values).toContain('+15550000002');

    // Per-location override binds the location id (cast to uuid in SQL text).
    expect(update!.text).toMatch(/location_id = /);
    expect(update!.text).toMatch(/::uuid/);
    expect(update!.text).not.toMatch(/location_id IS NULL/);
    expect(update!.values).toContain(OVERRIDE_LOCATION_ID);

    expect(update!.text).toMatch(/status = 'disabled'/);
  });
});
