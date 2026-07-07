// worker/__tests__/NotificationWorker-telegram.test.ts
//
// Phase 2 Telegram integration tests for the NotificationWorker dispatcher.
// Covers: flag-off short-circuit, blocked-recipient handling, chat-not-found handling.
//
// The main dispatcher behavior (multi-channel, subscription guard, idempotency)
// is covered in NotificationWorker.test.ts — this file is scoped to Telegram.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SendNotificationPayload } from '../../../../src/lib/shared/worker-types';

// ── Hoisted mocks ──────────────────────────────────────────────────────

// Shared Postgres.js mock — LAZY + fragment-flattening, so the deduped
// flipEnrollmentStatus helper's nested `sql`` fragments flatten into ONE
// recorded `sqlCalls[i].text`/`.values` (its `begin` runs the callback with the
// same tagged-template mock, so the transactional flip is captured here).
const {
  sqlReturnQueue,
  mockSql,
  sqlCalls,
  resetMockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockGetVerifiedEnrollments,
  mockGetChannel,
  mockEmailSend,
  mockTelegramSend,
  mockCreateApprovalLink,
  mockInsertPendingApprovalDelivery,
  mockFinalizeDeliverySent,
  mockFailDelivery,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
} = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');

  class TelegramRecipientBlockedError extends Error {
    constructor() {
      super('telegram_recipient_blocked');
      this.name = 'TelegramRecipientBlockedError';
    }
  }
  class TelegramChatNotFoundError extends Error {
    constructor() {
      super('telegram_chat_not_found');
      this.name = 'TelegramChatNotFoundError';
    }
  }

  return {
    ...createMockSql(),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockGetVerifiedEnrollments: vi.fn(),
    mockGetChannel: vi.fn(),
    mockEmailSend: vi.fn(),
    mockTelegramSend: vi.fn(),
    mockCreateApprovalLink: vi.fn(),
    mockInsertPendingApprovalDelivery: vi.fn(),
    mockFinalizeDeliverySent: vi.fn(),
    mockFailDelivery: vi.fn(),
    TelegramRecipientBlockedError,
    TelegramChatNotFoundError,
  };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({ outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback, attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined }),
}));

vi.mock('../../../../src/lib/notifications/resolve-channels', () => ({
  resolveChannels: mockGetVerifiedEnrollments,
  invalidateChannelCache: vi.fn().mockResolvedValue(undefined),
  safeInvalidateChannelCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(0),
  }),
}));

vi.mock('../../../../src/lib/notifications/channels', () => ({
  getChannel: mockGetChannel,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
}));

vi.mock('../../../../src/lib/notifications/delivery', () => ({
  insertPendingApprovalDelivery: mockInsertPendingApprovalDelivery,
  finalizeDeliverySent: mockFinalizeDeliverySent,
  failDelivery: mockFailDelivery,
}));

vi.mock('../../../../src/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));


vi.mock('uuid', () => ({
  v7: vi.fn(() => 'test-uuid'),
}));

// Import after mocks are wired
import { handleSendNotification } from '../NotificationWorker';

// ── Helpers ────────────────────────────────────────────────────────────

function makeJob(): Job<SendNotificationPayload> {
  return {
    data: { response_id: 'resp-1', business_id: 'biz-1' },
    id: 'outbox-notif-1',
  } as Job<SendNotificationPayload>;
}

function mockResponseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1',
    response_text: 'Thank you, Jane!',
    status: 'pending_approval',
    resp_business_id: 'biz-1',
    review_id: 'rev-1',
    reviewer_name: 'Jane',
    star_rating: 5,
    review_text: 'Great place!',
    review_date: '2026-04-01',
    ...overrides,
  };
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'acct-1',
    name: 'Test Biz',
    owner_email_bounced: false,
    archived_at: null,
    subscription_status: 'active',
    account_updated_at: new Date(),
    ...overrides,
  };
}

function stubBothChannels() {
  mockEmailSend.mockResolvedValue({ externalMessageId: 'resend-msg-1' });
  mockTelegramSend.mockResolvedValue({ externalMessageId: 'tg-chat:42' });
  mockGetChannel.mockImplementation((id: string) => {
    if (id === 'email') {
      return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockEmailSend };
    }
    if (id === 'telegram') {
      return { id: 'telegram', supportsInlineActions: true, requiresOptInHandshake: true, sendApprovalRequest: mockTelegramSend };
    }
    throw new Error(`channel ${id} not stubbed`);
  });
}

function resetAll() {
  resetMockSql();
  mockSql.mockClear();
  mockSql.begin.mockClear();
  mockMarkOutboxCompleted.mockReset();
  mockMarkOutboxFailed.mockReset();
  mockGetVerifiedEnrollments.mockReset();
  mockGetChannel.mockReset();
  mockEmailSend.mockReset();
  mockTelegramSend.mockReset();
  mockCreateApprovalLink.mockReset().mockResolvedValue({
    rawToken: 'raw-tok-fixture',
    tokenHash: 'hash-fixture',
    approvalLinkId: 'link-id-fixture',
  });
  mockInsertPendingApprovalDelivery.mockReset().mockResolvedValue('pending-delivery-1');
  mockFinalizeDeliverySent.mockReset().mockResolvedValue(undefined);
  mockFailDelivery.mockReset().mockResolvedValue(undefined);
  process.env.NEXT_PUBLIC_APP_URL = 'https://repworth.example.com';
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('NotificationWorker — Telegram flag gate', () => {
  beforeEach(resetAll);

  it('skips telegram enrollment when CHANNELS_TELEGRAM_ENABLED is not "true"; email still sends', async () => {
    // CHANNELS_TELEGRAM_ENABLED is undefined (deleted in resetAll)
    stubBothChannels();

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
      { channel: 'telegram', handle: '123456789', location_id: null },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],  // response+review
      [mockBusinessRow()],  // business
      [],                   // email idempotency — proceed
      // recordNotificationDelivery is mocked, no SQL row consumed for it
    );

    await handleSendNotification(mockSql as never, makeJob());

    // Telegram channel must NOT be contacted
    expect(mockGetChannel).not.toHaveBeenCalledWith('telegram');
    expect(mockTelegramSend).not.toHaveBeenCalled();

    // Email must still go through
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-notif-1', undefined);
  });
});

describe('NotificationWorker — Telegram blocked recipient', () => {
  beforeEach(resetAll);

  it('on TelegramRecipientBlockedError: flips enrollment to unsubscribed, records failed delivery, continues to email', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    stubBothChannels();
    mockTelegramSend.mockRejectedValue(new TelegramRecipientBlockedError());

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
      { channel: 'telegram', handle: '123456789', location_id: null },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],  // response+review
      [mockBusinessRow()],  // business
      [],                   // email idempotency — proceed
      [],                   // telegram idempotency — proceed
    );

    await handleSendNotification(mockSql as never, makeJob());

    // Telegram enrollment must be flipped to unsubscribed in a transaction —
    // and EXACTLY ONE statement runs in that tx (guards against a regression
    // adding a second write inside the flip transaction).
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(sqlCalls.filter((c) => c.text.includes('UPDATE channel_enrollments'))).toHaveLength(1);
    const enrollmentUpdate = sqlCalls.find((c) => c.text.includes('UPDATE channel_enrollments'));
    expect(enrollmentUpdate, 'expected a channel_enrollments UPDATE').toBeDefined();
    const updateSql = enrollmentUpdate!.text;
    expect(updateSql).toMatch(/UPDATE channel_enrollments/);
    expect(updateSql).toMatch(/SET status = /);
    expect(updateSql).toMatch(/unsubscribed/);
    expect(updateSql).toMatch(/unsubscribed_at/);
    expect(updateSql).toMatch(/archived_at IS NULL/);

    // Scoped by account_id + org-default location (location_id IS NULL),
    // never by the legacy business_id FK.
    expect(updateSql).toMatch(/account_id = /);
    expect(updateSql).toMatch(/channel = 'telegram'/);
    expect(updateSql).toMatch(/location_id IS NULL/);
    expect(updateSql).not.toMatch(/business_id/);
    const updateValues = enrollmentUpdate!.values;
    expect(updateValues).toContain('acct-1');
    expect(updateValues).not.toContain('biz-1');

    // Claimed delivery flipped to failed for telegram
    expect(mockFailDelivery).toHaveBeenCalledWith(mockSql, 'pending-delivery-1', 'telegram_blocked');

    // Email must still succeed after telegram failure
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockFinalizeDeliverySent).toHaveBeenCalledTimes(1);

    // Dispatcher must NOT throw — outbox completed
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-notif-1', undefined);
  });
});

describe('NotificationWorker — Telegram chat not found', () => {
  beforeEach(resetAll);

  it('on TelegramChatNotFoundError: flips enrollment to disabled, records failed delivery', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    stubBothChannels();
    mockTelegramSend.mockRejectedValue(new TelegramChatNotFoundError());

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
      { channel: 'telegram', handle: '123456789', location_id: null },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],  // response+review
      [mockBusinessRow()],  // business
      [],                   // email idempotency — proceed
      [],                   // telegram idempotency — proceed
    );

    await handleSendNotification(mockSql as never, makeJob());

    // Telegram enrollment must be flipped to disabled in a transaction —
    // and EXACTLY ONE statement runs in that tx (guards against a regression
    // adding a second write inside the flip transaction).
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(sqlCalls.filter((c) => c.text.includes('UPDATE channel_enrollments'))).toHaveLength(1);
    const enrollmentUpdate = sqlCalls.find((c) => c.text.includes('UPDATE channel_enrollments'));
    expect(enrollmentUpdate, 'expected a channel_enrollments UPDATE').toBeDefined();
    const updateSql = enrollmentUpdate!.text;
    expect(updateSql).toMatch(/UPDATE channel_enrollments/);
    expect(updateSql).toMatch(/SET status = /);
    expect(updateSql).toMatch(/disabled/);
    expect(updateSql).toMatch(/disabled_at/);
    expect(updateSql).toMatch(/archived_at IS NULL/);

    // Must NOT set unsubscribed fields
    expect(updateSql).not.toMatch(/unsubscribed_at/);
    expect(updateSql).not.toMatch(/unsubscribed_reason/);

    // Scoped by account_id + org-default location (location_id IS NULL),
    // never by the legacy business_id FK.
    expect(updateSql).toMatch(/account_id = /);
    expect(updateSql).toMatch(/channel = 'telegram'/);
    expect(updateSql).toMatch(/location_id IS NULL/);
    expect(updateSql).not.toMatch(/business_id/);
    const updateValues = enrollmentUpdate!.values;
    expect(updateValues).toContain('acct-1');
    expect(updateValues).not.toContain('biz-1');

    // Claimed delivery flipped to failed for telegram
    expect(mockFailDelivery).toHaveBeenCalledWith(mockSql, 'pending-delivery-1', 'telegram_chat_not_found');

    // Email must still succeed after telegram failure
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockFinalizeDeliverySent).toHaveBeenCalledTimes(1);

    // Dispatcher must NOT throw — outbox completed
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-notif-1', undefined);
  });
});
