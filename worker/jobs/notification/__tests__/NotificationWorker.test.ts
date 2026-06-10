import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SendNotificationPayload } from '../../../../src/lib/shared/worker-types';

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
vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({ outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback, attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined }),
}));

vi.mock('../../../../src/lib/notifications/email', () => ({
  sendApprovalEmail: mockSendApprovalEmail,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'test-uuid'),
}));

const {
  mockGetVerifiedEnrollments,
  mockGetChannel,
  mockChannelSend,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
  WhatsAppTemplateConfigError,
  WhatsAppSessionWindowError,
  WhatsAppRateLimitError,
  WhatsAppTimeoutError,
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
  class WhatsAppRecipientBlockedError extends Error {
    readonly code: number;
    constructor(code = 63014) { super(`whatsapp_blocked:${code}`); this.name = 'WhatsAppRecipientBlockedError'; this.code = code; }
  }
  class WhatsAppInvalidRecipientError extends Error {
    readonly code: number;
    constructor(code = 63024) { super(`whatsapp_invalid_recipient:${code}`); this.name = 'WhatsAppInvalidRecipientError'; this.code = code; }
  }
  class WhatsAppTemplateConfigError extends Error {
    readonly code: number;
    constructor(code = 63040) { super(`whatsapp_template_config:${code}`); this.name = 'WhatsAppTemplateConfigError'; this.code = code; }
  }
  class WhatsAppSessionWindowError extends Error {
    readonly code: number;
    constructor(code = 63016) { super(`whatsapp_session_window:${code}`); this.name = 'WhatsAppSessionWindowError'; this.code = code; }
  }
  class WhatsAppRateLimitError extends Error {
    readonly code: number | 'HTTP_429';
    constructor(code: number | 'HTTP_429' = 63017) { super(`whatsapp_rate_limit:${code}`); this.name = 'WhatsAppRateLimitError'; this.code = code; }
  }
  class WhatsAppTimeoutError extends Error {
    readonly code = 'TIMEOUT' as const;
    constructor() { super('whatsapp_timeout'); this.name = 'WhatsAppTimeoutError'; }
  }
  return {
    mockGetVerifiedEnrollments: vi.fn(),
    mockGetChannel: vi.fn(),
    mockChannelSend: vi.fn(),
    TelegramRecipientBlockedError,
    TelegramChatNotFoundError,
    WhatsAppRecipientBlockedError,
    WhatsAppInvalidRecipientError,
    WhatsAppTemplateConfigError,
    WhatsAppSessionWindowError,
    WhatsAppRateLimitError,
    WhatsAppTimeoutError,
  };
});

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
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
  WhatsAppTemplateConfigError,
  WhatsAppSessionWindowError,
  WhatsAppRateLimitError,
  WhatsAppTimeoutError,
}));

const { mockCreateApprovalLink } = vi.hoisted(() => ({
  mockCreateApprovalLink: vi.fn(),
}));

vi.mock('../../../../src/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));

// Do NOT mock subscription-guard — use the real implementation

// Import after mocks are wired
import { handleSendNotification } from '../NotificationWorker';
import { dispatchAll } from '../dispatch';
import type { DispatchContext } from '../dispatch';

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
  mockCreateApprovalLink.mockReset().mockResolvedValue({
    rawToken: 'raw-tok-fixture',
    tokenHash: 'hash-fixture',
    approvalLinkId: 'link-id-fixture',
  });
  process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@example.com>';
  process.env.NEXT_PUBLIC_APP_URL = 'https://repworth.example.com';
  process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('NotificationWorker – handleSendNotification', () => {
  beforeEach(beforeEachSetup);

  // 1. Success flow
  it('creates approval link, sends email, records delivery, and completes outbox', async () => {
    stubEmailChannel();
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
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
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // 2. Subscription pending_payment blocks notification worker
  it('skips notification for pending_payment subscription', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow({ subscription_status: 'pending_payment' })],
    );

    await handleSendNotification(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
  });

  // 3. Existing delivery (idempotent skip)
  it('completes outbox without sending when delivery already exists', async () => {
    stubEmailChannel();
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [{ id: 'existing-delivery-1' }], // email idempotency check → found
    );

    await handleSendNotification(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
  });

  // 4. Email send failure — throws for BullMQ retry (all channels fail)
  it('throws when channel send fails and no channels succeed', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
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
      { channel: 'email', handle: 'owner@example.com', location_id: null },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],             // 1: response+review
      [mockBusinessRow()],             // 2: business
      [{ id: 'delivered-1' }],         // 3: failover idempotency check → delivered already
    );

    await handleSendNotification(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
  });

  // 6. Failover re-sends even when old sent_at delivery exists (the key distinction)
  it('failover: re-sends when sent_at exists but no delivered_at', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'all_deliveries_failed' as const };

    stubEmailChannel();
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
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
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
  });

  // 7. Failover respects subscription guard
  it('failover: skips for cancelled subscription', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'all_deliveries_failed' as const };

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow({ subscription_status: 'cancelled' })],
    );

    await handleSendNotification(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1', undefined);
    expect(mockChannelSend).not.toHaveBeenCalled();
  });
});

describe('NotificationWorker — stale channel guard (dispatch layer)', () => {
  beforeEach(beforeEachSetup);

  // Defense-in-depth: channel_enrollments.channel is a TEXT column.
  // A stale 'sms' row that survived the migration must NOT create an approval
  // link or reach getChannel() — only supported channels proceed.
  //
  // This test calls dispatchAll directly (bypassing eligibility.ts) so it
  // exercises the dispatch-layer guard specifically, not the eligibility filter.
  it('skips a stale unsupported channel row before approval-link creation', async () => {
    stubEmailChannel();

    const ctx: DispatchContext = {
      responseId: 'resp-1',
      businessId: 'biz-1',
      accountId: 'acct-1',
      isFailover: false,
      appUrl: 'https://repworth.example.com',
      business: { name: 'Test Biz', displayLabel: null, owner_email_bounced: false },
      review: {
        reviewerName: 'Jane',
        starRating: 5,
        reviewText: 'Great place!',
        reviewDate: '2026-04-01',
        responsePreview: 'Thank you, Jane!',
      },
    };

    const enrollments = [
      // Stale 'sms' row injected via cast — simulates a TEXT column value
      // that predates the SMS removal migration.
      { channel: 'sms' as never, handle: '+15551234567', location_id: null },
      { channel: 'email' as const, handle: 'owner@example.com', location_id: null },
    ];

    sqlReturnQueue.push(
      [],  // email idempotency check
      [],  // email delivery INSERT
    );

    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // Must not throw even though 'sms' is not a valid channel
    await expect(dispatchAll(ctx, enrollments, logger)).resolves.toBeDefined();

    // createApprovalLink must NOT have been called with 'sms'
    const approvalLinkCalls = mockCreateApprovalLink.mock.calls;
    const smsCalls = approvalLinkCalls.filter(
      (call) => (call[0] as { channel: string }).channel === 'sms',
    );
    expect(smsCalls).toHaveLength(0);

    // createApprovalLink WAS called for 'email'
    const emailCalls = approvalLinkCalls.filter(
      (call) => (call[0] as { channel: string }).channel === 'email',
    );
    expect(emailCalls).toHaveLength(1);
  });
});

describe('NotificationWorker — dispatcher (multi-channel)', () => {
  beforeEach(beforeEachSetup);

  it('sends on every verified enrollment sequentially', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
      { channel: 'telegram', handle: '123456789', location_id: null },
    ]);
    const telegramSend = vi.fn().mockResolvedValue({ externalMessageId: 'tg-chat:42' });
    mockChannelSend.mockResolvedValue({ externalMessageId: 'resend-msg-1' });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      if (id === 'telegram') return { id: 'telegram', supportsInlineActions: true, requiresOptInHandshake: true, sendApprovalRequest: telegramSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // email idempotency check
      [],  // email delivery insert
      [],  // telegram idempotency check
      [],  // telegram delivery insert
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).toHaveBeenCalledTimes(1);
    expect(telegramSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it('dispatches unordered enrollments in canonical channel order without dropping duplicates', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'telegram', handle: 'tg-222', location_id: null },
      { channel: 'email', handle: 'owner@example.com', location_id: null },
      { channel: 'telegram', handle: 'tg-111', location_id: null },
    ]);
    const sendOrder: string[] = [];
    mockChannelSend.mockImplementation(async ({ handle }: { handle: string }) => {
      sendOrder.push(`email:${handle}`);
      return { externalMessageId: 'resend-msg-1' };
    });
    const telegramSend = vi.fn().mockImplementation(async ({ handle }: { handle: string }) => {
      sendOrder.push(`telegram:${handle}`);
      return { externalMessageId: `tg-${handle}` };
    });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      if (id === 'telegram') return { id: 'telegram', supportsInlineActions: true, requiresOptInHandshake: true, sendApprovalRequest: telegramSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // email idempotency
      [],  // email delivery insert
      [],  // first telegram idempotency
      [],  // first telegram delivery insert
      [],  // second telegram idempotency
      [],  // second telegram delivery insert
    );

    await handleSendNotification(makeJob());

    expect(sendOrder).toEqual([
      'email:owner@example.com',
      'telegram:tg-222',
      'telegram:tg-111',
    ]);
    expect(mockChannelSend).toHaveBeenCalledTimes(1);
    expect(telegramSend).toHaveBeenCalledTimes(2);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it('throws (for BullMQ retry) when ALL attempted channels fail', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([{ channel: 'email', handle: 'owner@example.com', location_id: null }]);
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
      { channel: 'email', handle: 'owner@example.com', location_id: null },
      { channel: 'telegram', handle: '123456789', location_id: null },
    ]);
    const telegramSend = vi.fn().mockRejectedValue(new Error('Telegram 500'));
    mockChannelSend.mockResolvedValue({ externalMessageId: 'resend-msg-1' });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      if (id === 'telegram') return { id: 'telegram', supportsInlineActions: true, requiresOptInHandshake: true, sendApprovalRequest: telegramSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // email idempotency
      [],  // email delivery insert (succeeds)
      [],  // telegram idempotency
      [],  // telegram failed_at insert (catch branch)
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).toHaveBeenCalledTimes(1);
    expect(telegramSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('skips channel when a prior successful delivery already exists (per-channel idempotency)', async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([{ channel: 'email', handle: 'owner@example.com', location_id: null }]);
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
      { channel: 'email', handle: 'owner@example.com', location_id: null },
      { channel: 'telegram', handle: '123456789', location_id: null },
    ]);
    const telegramSend = vi.fn().mockResolvedValue({ externalMessageId: 'tg-chat:42' });
    mockChannelSend.mockResolvedValue({ externalMessageId: 'resend-msg-1' });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === 'email') return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockChannelSend };
      if (id === 'telegram') return { id: 'telegram', supportsInlineActions: true, requiresOptInHandshake: true, sendApprovalRequest: telegramSend };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow({ owner_email_bounced: true })],
      // email is skipped entirely — no idempotency check, no delivery insert
      [],  // telegram idempotency
      [],  // telegram delivery insert
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(telegramSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });
});
