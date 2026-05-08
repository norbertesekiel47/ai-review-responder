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

const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockGetVerifiedEnrollments,
  mockGetChannel,
  mockEmailSend,
  mockTelegramSend,
  mockCreateApprovalLink,
  mockRecordDelivery,
  mockInsertFailedDelivery,
  mockReserveSmsCost,
  mockRefundSmsCost,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
} = vi.hoisted(() => {
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

  const sqlReturnQueue: unknown[] = [];
  const mockTx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => Promise.resolve([]));
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
    mockGetVerifiedEnrollments: vi.fn(),
    mockGetChannel: vi.fn(),
    mockEmailSend: vi.fn(),
    mockTelegramSend: vi.fn(),
    mockCreateApprovalLink: vi.fn(),
    mockRecordDelivery: vi.fn(),
    mockInsertFailedDelivery: vi.fn(),
    mockReserveSmsCost: vi.fn(),
    mockRefundSmsCost: vi.fn(),
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

vi.mock('../../../../src/lib/notifications/enrollments', () => ({
  getVerifiedEnrollments: mockGetVerifiedEnrollments,
}));

vi.mock('../../../../src/lib/notifications/channels', () => ({
  getChannel: mockGetChannel,
  SmsRecipientUnsubscribedError: class SmsRecipientUnsubscribedError extends Error {
    constructor() { super('sms_recipient_unsubscribed'); this.name = 'SmsRecipientUnsubscribedError'; }
  },
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
}));

vi.mock('../../../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordDelivery,
  insertFailedDelivery: mockInsertFailedDelivery,
}));

vi.mock('../../../../src/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));

vi.mock('../../../../src/lib/costs/sms-tracker', () => ({
  reserveSmsCost: mockReserveSmsCost,
  refundSmsCost: mockRefundSmsCost,
  DailySmsLimitExceededError: class DailySmsLimitExceededError extends Error {
    constructor(public readonly scope: 'per_business' | 'global') {
      super(`sms_cap:${scope}`);
      this.name = 'DailySmsLimitExceededError';
    }
  },
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
    name: 'Test Biz',
    owner_email_bounced: false,
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
  sqlReturnQueue.length = 0;
  mockSql.mockClear();
  mockTx.mockClear();
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
  mockRecordDelivery.mockReset().mockResolvedValue(undefined);
  mockInsertFailedDelivery.mockReset().mockResolvedValue(undefined);
  mockReserveSmsCost.mockReset();
  mockRefundSmsCost.mockReset().mockResolvedValue(undefined);
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
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'telegram', handle: '123456789' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],  // response+review
      [mockBusinessRow()],  // business
      [],                   // email idempotency — proceed
      // recordNotificationDelivery is mocked, no SQL row consumed for it
    );

    await handleSendNotification(makeJob());

    // Telegram channel must NOT be contacted
    expect(mockGetChannel).not.toHaveBeenCalledWith('telegram');
    expect(mockTelegramSend).not.toHaveBeenCalled();

    // Email must still go through
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
  });
});

describe('NotificationWorker — Telegram blocked recipient', () => {
  beforeEach(resetAll);

  it('on TelegramRecipientBlockedError: flips enrollment to unsubscribed, records failed delivery, continues to email', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    stubBothChannels();
    mockTelegramSend.mockRejectedValue(new TelegramRecipientBlockedError());

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'telegram', handle: '123456789' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],  // response+review
      [mockBusinessRow()],  // business
      [],                   // email idempotency — proceed
      [],                   // telegram idempotency — proceed
    );

    await handleSendNotification(makeJob());

    // Telegram enrollment must be flipped to unsubscribed in a transaction
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(mockTx).toHaveBeenCalledTimes(1);
    const updateSql = (mockTx.mock.calls[0]?.[0] as readonly string[] | undefined)?.join('?') ?? '';
    expect(updateSql).toMatch(/UPDATE channel_enrollments/);
    expect(updateSql).toMatch(/SET status = /);
    expect(updateSql).toMatch(/unsubscribed/);
    expect(updateSql).toMatch(/unsubscribed_at/);
    expect(updateSql).toMatch(/archived_at IS NULL/);

    // Failed delivery recorded for telegram
    expect(mockInsertFailedDelivery).toHaveBeenCalledWith(
      'biz-1',
      'resp-1',
      'telegram',
      '123456789',
      'telegram_blocked',
    );

    // Email must still succeed after telegram failure
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockRecordDelivery).toHaveBeenCalledTimes(1);

    // Dispatcher must NOT throw — outbox completed
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
  });
});

describe('NotificationWorker — Telegram chat not found', () => {
  beforeEach(resetAll);

  it('on TelegramChatNotFoundError: flips enrollment to disabled, records failed delivery', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    stubBothChannels();
    mockTelegramSend.mockRejectedValue(new TelegramChatNotFoundError());

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'telegram', handle: '123456789' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],  // response+review
      [mockBusinessRow()],  // business
      [],                   // email idempotency — proceed
      [],                   // telegram idempotency — proceed
    );

    await handleSendNotification(makeJob());

    // Telegram enrollment must be flipped to disabled in a transaction
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(mockTx).toHaveBeenCalledTimes(1);
    const updateSql = (mockTx.mock.calls[0]?.[0] as readonly string[] | undefined)?.join('?') ?? '';
    expect(updateSql).toMatch(/UPDATE channel_enrollments/);
    expect(updateSql).toMatch(/SET status = /);
    expect(updateSql).toMatch(/disabled/);
    expect(updateSql).toMatch(/disabled_at/);
    expect(updateSql).toMatch(/archived_at IS NULL/);

    // Must NOT set unsubscribed fields
    expect(updateSql).not.toMatch(/unsubscribed_at/);
    expect(updateSql).not.toMatch(/unsubscribed_reason/);

    // Failed delivery recorded for telegram
    expect(mockInsertFailedDelivery).toHaveBeenCalledWith(
      'biz-1',
      'resp-1',
      'telegram',
      '123456789',
      'telegram_chat_not_found',
    );

    // Email must still succeed after telegram failure
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockRecordDelivery).toHaveBeenCalledTimes(1);

    // Dispatcher must NOT throw — outbox completed
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
  });
});
