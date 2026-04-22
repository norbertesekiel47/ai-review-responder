// worker/__tests__/NotificationWorker-sms.test.ts
//
// Phase 1 SMS integration tests for the NotificationWorker dispatcher.
// Covers: flag-off short-circuit, cost reserve/refund lifecycle,
// cap-rejection handling, and sender-wide 21610 fan-out.
//
// The main dispatcher behavior (multi-channel, subscription guard, idempotency)
// is covered in NotificationWorker.test.ts — this file is scoped to SMS.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

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
  mockSmsSend,
  mockCreateApprovalLink,
  mockRecordDelivery,
  mockInsertFailedDelivery,
  mockReserveSmsCost,
  mockRefundSmsCost,
  DailySmsLimitExceededError,
  SmsRecipientUnsubscribedError,
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
    mockSmsSend: vi.fn(),
    mockCreateApprovalLink: vi.fn(),
    mockRecordDelivery: vi.fn(),
    mockInsertFailedDelivery: vi.fn(),
    mockReserveSmsCost: vi.fn(),
    mockRefundSmsCost: vi.fn(),
    DailySmsLimitExceededError,
    SmsRecipientUnsubscribedError,
  };
});

vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

vi.mock('../../src/lib/notifications/enrollments', () => ({
  getVerifiedEnrollments: mockGetVerifiedEnrollments,
}));

vi.mock('../../src/lib/notifications/channels', () => ({
  getChannel: mockGetChannel,
  SmsRecipientUnsubscribedError,
}));

vi.mock('../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordDelivery,
  insertFailedDelivery: mockInsertFailedDelivery,
}));

vi.mock('../../src/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));

vi.mock('../../src/lib/costs/sms-tracker', () => ({
  reserveSmsCost: mockReserveSmsCost,
  refundSmsCost: mockRefundSmsCost,
  DailySmsLimitExceededError,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'test-uuid'),
}));

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

function stubBothChannels() {
  mockEmailSend.mockResolvedValue({ externalMessageId: 'resend-msg-1' });
  mockSmsSend.mockResolvedValue({ externalMessageId: 'twi-msg-1' });
  mockGetChannel.mockImplementation((id: string) => {
    if (id === 'email') {
      return { id: 'email', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockEmailSend };
    }
    if (id === 'sms') {
      return { id: 'sms', supportsInlineActions: false, requiresOptInHandshake: false, sendApprovalRequest: mockSmsSend };
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
  mockSmsSend.mockReset();
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
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG-test-sid';
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('NotificationWorker — SMS flag gate', () => {
  beforeEach(resetAll);

  it('skips SMS enrollment entirely when CHANNELS_SMS_ENABLED is not "true"; email still sends', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    stubBothChannels();

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'sms', handle: '+15551234567' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],   // response+review
      [mockBusinessRow()],   // business
      [],                    // email idempotency — proceed
      // recordNotificationDelivery is mocked, so no SQL row consumed for it
    );

    await handleSendNotification(makeJob());

    expect(mockReserveSmsCost).not.toHaveBeenCalled();
    expect(mockSmsSend).not.toHaveBeenCalled();
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });
});

describe('NotificationWorker — SMS happy path', () => {
  beforeEach(resetAll);

  it('reserves SMS cost, sends via Twilio, records delivery, does NOT refund', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    stubBothChannels();
    mockReserveSmsCost.mockResolvedValue('2026-04-21');

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'sms', handle: '+15551234567' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],  // response+review
      [mockBusinessRow()],  // business
      [],                   // sms idempotency — proceed
    );

    await handleSendNotification(makeJob());

    expect(mockReserveSmsCost).toHaveBeenCalledWith('biz-1');
    expect(mockSmsSend).toHaveBeenCalledTimes(1);
    expect(mockRecordDelivery).toHaveBeenCalledTimes(1);
    expect(mockRefundSmsCost).not.toHaveBeenCalled();
    expect(mockInsertFailedDelivery).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });
});

describe('NotificationWorker — SMS cap rejection', () => {
  beforeEach(resetAll);

  it('records failed delivery and does NOT call Twilio when daily cap exceeded', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    stubBothChannels();
    mockReserveSmsCost.mockRejectedValue(new DailySmsLimitExceededError('per_business'));

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'sms', handle: '+15551234567' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],                    // sms idempotency — proceed
    );

    // Single enrollment, all fail → dispatcher throws for BullMQ retry.
    await expect(handleSendNotification(makeJob())).rejects.toThrow(/All 1 channel send/);

    expect(mockSmsSend).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
    expect(mockRefundSmsCost).not.toHaveBeenCalled();
    expect(mockInsertFailedDelivery).toHaveBeenCalledWith(
      'biz-1',
      'resp-1',
      'sms',
      '+15551234567',
      'daily_sms_limit_exceeded:per_business',
    );
  });
});

describe('NotificationWorker — SMS refund on failure', () => {
  beforeEach(resetAll);

  it('refunds reservation when createApprovalLink throws after reserve', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    stubBothChannels();
    mockReserveSmsCost.mockResolvedValue('2026-04-21');
    mockCreateApprovalLink.mockRejectedValue(new Error('DB down'));

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'sms', handle: '+15551234567' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // sms idempotency
    );

    // createApprovalLink throws inside try{}, finally refunds, then propagates.
    await expect(handleSendNotification(makeJob())).rejects.toThrow(/DB down/);

    expect(mockRefundSmsCost).toHaveBeenCalledWith('biz-1', '2026-04-21');
    expect(mockSmsSend).not.toHaveBeenCalled();
  });

  it('refunds reservation + records failed delivery on generic Twilio send error', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    stubBothChannels();
    mockReserveSmsCost.mockResolvedValue('2026-04-21');
    mockSmsSend.mockRejectedValue(new Error('Twilio 500'));

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'sms', handle: '+15551234567' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // sms idempotency
    );

    await expect(handleSendNotification(makeJob())).rejects.toThrow(/All 1 channel send/);

    expect(mockRefundSmsCost).toHaveBeenCalledWith('biz-1', '2026-04-21');
    expect(mockInsertFailedDelivery).toHaveBeenCalledWith(
      'biz-1',
      'resp-1',
      'sms',
      '+15551234567',
      'send_error:Twilio 500',
    );
    // Twilio-level 21610 block tables MUST NOT fire for a generic error.
    expect(mockSql.begin).not.toHaveBeenCalled();
  });
});

describe('NotificationWorker — SMS sender-wide 21610 handling', () => {
  beforeEach(resetAll);

  it('UPSERTs opt-out, inserts audit event, flips all active enrollments, records failed delivery, and refunds', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    stubBothChannels();
    mockReserveSmsCost.mockResolvedValue('2026-04-21');
    mockSmsSend.mockRejectedValue(new SmsRecipientUnsubscribedError());

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'sms', handle: '+15551234567' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // sms idempotency
    );

    await expect(handleSendNotification(makeJob())).rejects.toThrow(/All 1 channel send/);

    // All three writes happen in a single sql.begin transaction.
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(mockTx).toHaveBeenCalledTimes(3);

    const calls = mockTx.mock.calls;
    const upsertSql = (calls[0]?.[0] as readonly string[] | undefined)?.join('?') ?? '';
    const eventSql = (calls[1]?.[0] as readonly string[] | undefined)?.join('?') ?? '';
    const updateSql = (calls[2]?.[0] as readonly string[] | undefined)?.join('?') ?? '';

    expect(upsertSql).toMatch(/INSERT INTO sms_sender_opt_outs/);
    expect(upsertSql).toMatch(/ON CONFLICT[\s\S]*DO UPDATE/);
    expect(eventSql).toMatch(/INSERT INTO sms_sender_opt_out_events/);
    expect(eventSql).toMatch(/21610_at_send/);
    expect(updateSql).toMatch(/UPDATE channel_enrollments/);
    expect(updateSql).toMatch(/SET status = /);
    expect(updateSql).toMatch(/archived_at IS NULL/);

    expect(mockInsertFailedDelivery).toHaveBeenCalledWith(
      'biz-1',
      'resp-1',
      'sms',
      '+15551234567',
      'twilio_21610_at_send',
    );
    expect(mockRefundSmsCost).toHaveBeenCalledWith('biz-1', '2026-04-21');
  });
});

describe('NotificationWorker — post-send recordDelivery failure', () => {
  beforeEach(resetAll);

  it('does NOT refund when Twilio succeeded but recordNotificationDelivery throws', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    stubBothChannels();
    mockReserveSmsCost.mockResolvedValue('2026-04-21');
    mockRecordDelivery.mockRejectedValue(new Error('PG down'));

    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: 'sms', handle: '+15551234567' },
    ]);

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],  // sms idempotency
    );

    await expect(handleSendNotification(makeJob())).rejects.toThrow(/PG down/);

    // Twilio was invoked and returned a SID — cost is committed.
    expect(mockSmsSend).toHaveBeenCalledTimes(1);
    expect(mockRefundSmsCost).not.toHaveBeenCalled();
  });
});
