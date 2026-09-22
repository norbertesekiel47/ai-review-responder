import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  mockSendInternalEmail,
  mockRecordNotificationDelivery,
  mockInsertFailedDelivery,
  mockMarkOutboxCompleted,
} = vi.hoisted(() => ({
  mockSendInternalEmail: vi.fn(),
  mockRecordNotificationDelivery: vi.fn(),
  mockInsertFailedDelivery: vi.fn(),
  mockMarkOutboxCompleted: vi.fn(),
}));

vi.mock('../../../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
}));
vi.mock('../../../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordNotificationDelivery,
  insertFailedDelivery: mockInsertFailedDelivery,
}));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
}));

import { sendAndRecordOwnerNudge, type SendAndRecordOwnerNudgeInput } from '../send-and-record-nudge';

// ── Helpers ─────────────────────────────────────────────────────────

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function baseInput(overrides: Partial<SendAndRecordOwnerNudgeInput> = {}): SendAndRecordOwnerNudgeInput {
  return {
    sql: vi.fn() as unknown as SendAndRecordOwnerNudgeInput['sql'],
    logger: makeLogger(),
    outboxId: 'outbox-1',
    outboxAttempt: undefined,
    businessId: 'biz-1',
    accountId: 'acct-1',
    ownerEmail: 'owner@test.com',
    subject: 'subject',
    bodyHtml: '<html/>',
    totalPending: 3,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('sendAndRecordOwnerNudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInternalEmail.mockResolvedValue({ messageId: 'msg-nudge-1' });
  });

  // ── Constraint 1: no provider idempotency key ───────────────────────

  it('sends with no idempotency key (fresh approval tokens vary the body per attempt)', async () => {
    await sendAndRecordOwnerNudge(baseInput());

    const sendArg = mockSendInternalEmail.mock.calls[0]![0] as { idempotencyKey?: string };
    expect(sendArg.idempotencyKey).toBeUndefined();
  });

  // ── Constraint 2: mark-before-send ──────────────────────────────────

  it('completes the outbox row BEFORE sending', async () => {
    let outboxCompletedBeforeSend = false;
    mockSendInternalEmail.mockImplementation(() => {
      outboxCompletedBeforeSend = mockMarkOutboxCompleted.mock.calls.length > 0;
      return Promise.resolve({ messageId: 'msg-nudge-1' });
    });

    await sendAndRecordOwnerNudge(baseInput({ outboxId: 'outbox-7', outboxAttempt: 1 }));

    expect(outboxCompletedBeforeSend).toBe(true);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(expect.anything(), 'outbox-7', 1);
    // No second completion call after the send — the row was already closed.
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  // ── Constraint 3: never rethrows ────────────────────────────────────

  it('never rethrows a send failure — the outbox row is already completed', async () => {
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend 503'));

    await expect(sendAndRecordOwnerNudge(baseInput())).resolves.toBeUndefined();

    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
  });

  it('records a failed delivery when the send fails, with recipient/reason in the right positions', async () => {
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend 503'));

    await sendAndRecordOwnerNudge(
      baseInput({ businessId: 'biz-nudge-1', accountId: 'acct-nudge-1', ownerEmail: 'owner@nudge.com' }),
    );

    expect(mockInsertFailedDelivery).toHaveBeenCalledWith(
      expect.anything(),
      'acct-nudge-1',
      'biz-nudge-1',
      null,
      'email',
      'owner@nudge.com',
      'Resend 503',
      'owner_nudge',
    );
  });

  // ── Constraint 4: the failure record is best-effort ─────────────────

  it('never escapes when recording the failed delivery itself fails', async () => {
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend 503'));
    mockInsertFailedDelivery.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(sendAndRecordOwnerNudge(baseInput())).resolves.toBeUndefined();
  });

  // ── Success path ─────────────────────────────────────────────────────

  it('records the delivery on a successful send and does not re-complete the outbox row', async () => {
    await sendAndRecordOwnerNudge(baseInput({ accountId: 'acct-2', businessId: 'biz-2', ownerEmail: 'o@test.com' }));

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-2',
        businessId: 'biz-2',
        recipient: 'o@test.com',
        template: 'owner_nudge',
        externalMessageId: 'msg-nudge-1',
      }),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });
});
