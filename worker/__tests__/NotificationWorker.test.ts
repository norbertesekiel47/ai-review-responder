import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendApprovalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockTx = vi.fn(
    (_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => {
      return Promise.resolve([]);
    },
  );

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

// ── Module mocks (hoisted by vitest) ───────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

vi.mock('../../src/lib/notifications/email', () => ({
  sendApprovalEmail: mockSendApprovalEmail,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'test-uuid'),
}));

const {
  mockGetVerifiedEnrollments,
  mockGetChannel,
  mockChannelSend,
  mockReserveSmsCost,
  mockRefundSmsCost,
  DailySmsLimitExceededError,
  SmsRecipientUnsubscribedError,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
} = vi.hoisted(() => {
  class DailySmsLimitExceededError extends Error {
    constructor(public readonly scope: 'per_business' | 'global') {
      super(`sms_cap:${scope}`);
      this.name = 'DailySmsLimitExceededError';
    }
  }
  class SmsRecipientUnsubscribedError extends Error {
    constructor() {
      super('sms_recipient_unsubscribed');
      this.name = 'SmsRecipientUnsubscribedError';
    }
  }
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
    mockGetVerifiedEnrollments: vi.fn(),
    mockGetChannel: vi.fn(),
    mockChannelSend: vi.fn(),
    mockReserveSmsCost: vi.fn().mockResolvedValue('2026-04-21'),
    mockRefundSmsCost: vi.fn().mockResolvedValue(undefined),
    DailySmsLimitExceededError,
    SmsRecipientUnsubscribedError,
    TelegramRecipientBlockedError,
    TelegramChatNotFoundError,
  };
});

vi.mock('../../src/lib/notifications/enrollments', () => ({
  getVerifiedEnrollments: mockGetVerifiedEnrollments,
}));

vi.mock('../../src/lib/notifications/channels', () => ({
  getChannel: mockGetChannel,
  SmsRecipientUnsubscribedError,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
}));

vi.mock('../../src/lib/costs/sms-tracker', () => ({
  reserveSmsCost: mockReserveSmsCost,
  refundSmsCost: mockRefundSmsCost,
  DailySmsLimitExceededError,
}));

const { mockCreateApprovalLink } = vi.hoisted(() => ({
  mockCreateApprovalLink: vi.fn(),
}));

vi.mock('../../src/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));

// Do NOT mock subscription-guard — use the real implementation

// Import after mocks are wired
import { handleSendNotification } from '../jobs/NotificationWorker';

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
    updated_at: new Date(),
    ...overrides,
  };
}

function stubEmailChannel(messageId = 'resend-msg-123') {
  mockChannelSend.mockResolvedValue({ externalMessageId: messageId });
  mockGetChannel.mockImplementation((id: string) => {
    if (id === 'email') {
      return {
        id: 'email',
        supportsInlineActions: false,
        requiresOptInHandshake: false,
        sendApprovalRequest: mockChannelSend,
      };
    }
    throw new Error(`channel ${id} not stubbed`);
  });
}

function beforeEachSetup() {
  sqlReturnQueue.length = 0;
  mockSql.mockClear();
  mockTx.mockClear();
  mockMarkOutboxCompleted.mockReset();
  mockMarkOutboxFailed.mockReset();
  mockSendApprovalEmail.mockReset().mockResolvedValue({ messageId: 'msg-123' });
  mockGetVerifiedEnrollments.mockReset();
  mockGetChannel.mockReset();
  mockChannelSend.mockReset();
  mockReserveSmsCost.mockReset().mockResolvedValue('2026-04-21');
  mockRefundSmsCost.mockReset().mockResolvedValue(undefined);
  mockCreateApprovalLink.mockReset().mockResolvedValue({
    rawToken: 'raw-tok-fixture',
    tokenHash: 'hash-fixture',
    approvalLinkId: 'link-id-fixture',
  });
  process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@example.com>';
  process.env.NEXT_PUBLIC_APP_URL = 'https://repworth.example.com';
  process.env.CHANNELS_SMS_ENABLED = 'true';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG-test-sid';
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('NotificationWorker – handleSendNotification', () => {
  beforeEach(beforeEachSetup);

  // 1. Success flow
  it('creates approval link, sends email, records delivery, and completes outbox', async () => {
    stubEmailChannel();
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],  // 1: response+review SELECT
      [mockBusinessRow()],  // 2: business SELECT
      [],                   // 3: email idempotency check → none
      [],                   // 4: recordNotificationDelivery INSERT
    );

    await handleSendNotification(makeJob());

    expect(mockCreateApprovalLink).toHaveBeenCalledOnce();
    expect(mockChannelSend).toHaveBeenCalledOnce();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // 2. Subscription pending_payment blocks notification worker
  it('skips notification for pending_payment subscription', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow({ subscription_status: 'pending_payment' })],
    );

    await handleSendNotification(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
  });

  // 3. Existing delivery (idempotent skip)
  it('completes outbox without sending when delivery already exists', async () => {
    stubEmailChannel();
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [{ id: 'existing-delivery-1' }], // email idempotency check → found
    );

    await handleSendNotification(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
  });

  // 4. Email send failure — throws for BullMQ retry (all channels fail)
  it('throws when channel send fails and no channels succeed', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
    ]);
    mockChannelSend.mockRejectedValue(new Error('Resend API timeout'));
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // idempotency check — proceed
      [],  // failed_at insert (catch branch)
    );

    await expect(handleSendNotification(makeJob())).rejects.toThrow(/All 1 channel send/);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // ── Failover mode tests ───────────────────────────────────────────

  // 5. Failover skips when delivery already succeeded
  it('failover: completes without sending when delivered_at exists', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'all_deliveries_failed' as const };

    stubEmailChannel();
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],             // 1: response+review
      [mockBusinessRow()],             // 2: business
      [{ id: 'delivered-1' }],         // 3: failover idempotency check → delivered already
    );

    await handleSendNotification(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
  });

  // 6. Failover re-sends even when old sent_at delivery exists (the key distinction)
  it('failover: re-sends when sent_at exists but no delivered_at', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'all_deliveries_failed' as const };

    stubEmailChannel();
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],   // 1: response+review
      [mockBusinessRow()],   // 2: business
      [],                    // 3: failover idempotency check → no delivered_at → proceed
      [],                    // 4: recordNotificationDelivery INSERT
    );

    await handleSendNotification(job);

    expect(mockCreateApprovalLink).toHaveBeenCalledOnce();
    expect(mockChannelSend).toHaveBeenCalledOnce();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });

  // 7. Failover respects subscription guard
  it('failover: skips for cancelled subscription', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'all_deliveries_failed' as const };

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow({ subscription_status: 'cancelled' })],
    );

    await handleSendNotification(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockChannelSend).not.toHaveBeenCalled();
  });
});

describe('NotificationWorker — dispatcher (multi-channel)', () => {
  beforeEach(beforeEachSetup);

  it('sends on every verified enrollment sequentially', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'sms', handle: '+15551234567' },
    ]);
    const smsSend = vi.fn().mockResolvedValue({ externalMessageId: 'twi-msg-1' });
    mockChannelSend.mockResolvedValue({ externalMessageId: 'resend-msg-1' });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      if (id === 'sms') return { id: 'sms', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: smsSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // email idempotency check
      [],  // email delivery insert
      [],  // sms idempotency check
      [],  // sms delivery insert
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).toHaveBeenCalledTimes(1);
    expect(smsSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it('throws (for BullMQ retry) when ALL attempted channels fail', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([{ channel: 'email', handle: 'owner@example.com' }]);
    mockChannelSend.mockRejectedValue(new Error('Resend 500'));
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // idempotency check — proceed
      [],  // failed_at insert (catch branch)
    );

    await expect(handleSendNotification(makeJob())).rejects.toThrow(/All 1 channel send/);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('continues to other channels when one channel send throws', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'sms', handle: '+15551234567' },
    ]);
    const smsSend = vi.fn().mockRejectedValue(new Error('Twilio 500'));
    mockChannelSend.mockResolvedValue({ externalMessageId: 'resend-msg-1' });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      if (id === 'sms') return { id: 'sms', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: smsSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // email idempotency
      [],  // email delivery insert (succeeds)
      [],  // sms idempotency
      [],  // sms failed_at insert (catch branch)
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).toHaveBeenCalledTimes(1);
    expect(smsSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('skips channel when a prior successful delivery already exists (per-channel idempotency)', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([{ channel: 'email', handle: 'owner@example.com' }]);
    stubEmailChannel();

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [{ id: 'delivery-already-exists' }],  // idempotency check HITS
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it('skips email channel when owner_email_bounced is true, but still sends on other channels', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'sms', handle: '+15551234567' },
    ]);
    const smsSend = vi.fn().mockResolvedValue({ externalMessageId: 'twi-msg-1' });
    mockChannelSend.mockResolvedValue({ externalMessageId: 'resend-msg-1' });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      if (id === 'sms') return { id: 'sms', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: smsSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow({ owner_email_bounced: true })],
      // email is skipped entirely — no idempotency check, no delivery insert
      [],  // sms idempotency
      [],  // sms delivery insert
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(smsSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });
});
