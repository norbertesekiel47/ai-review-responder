import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────────────────
const { mockSendInternalEmail, mockRecordNotificationDelivery, mockMarkOutboxCompleted, mockMarkOutboxFailed } =
  vi.hoisted(() => ({
    mockSendInternalEmail: vi.fn(),
    mockRecordNotificationDelivery: vi.fn(),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
  }));

vi.mock('../../../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
}));
vi.mock('../../../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordNotificationDelivery,
}));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

import { sendAndRecordDrip, type SendAndRecordDripInput } from '../send-and-record';
import type { LocationId } from '../../../../src/lib/shared/ids';

// ── Helpers ─────────────────────────────────────────────────────────

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeSql() {
  const calls: string[] = [];
  const sql = vi.fn((strings: TemplateStringsArray) => {
    calls.push(strings.join(''));
    return Promise.resolve([]);
  });
  return { sql: sql as unknown as SendAndRecordDripInput['sql'], calls };
}

function baseInput(overrides: Partial<SendAndRecordDripInput> = {}): SendAndRecordDripInput {
  const { sql } = makeSql();
  return {
    sql,
    logger: makeLogger(),
    dripType: 'day_1',
    businessId: 'biz-1' as LocationId,
    accountId: 'acct-1',
    ownerEmail: 'owner@test.com',
    claimId: 'claim-1',
    outboxId: 'outbox-1',
    outboxAttempt: undefined,
    subject: 'subject',
    html: '<html/>',
    bodyVaries: false,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('sendAndRecordDrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInternalEmail.mockResolvedValue({ messageId: 'msg-1' });
  });

  // ── Constraint 1: keyed vs. no-key ──────────────────────────────────

  it('passes a provider idempotency key scoped to (businessId, dripType) when the body is stable', async () => {
    const input = baseInput({ bodyVaries: false, dripType: 'day_30', businessId: 'biz-2' as LocationId });

    await sendAndRecordDrip(input);

    expect(mockSendInternalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'onboarding_drip_day_30:biz-2' }),
    );
  });

  it('omits the idempotency key when the body varies per attempt', async () => {
    const { sql, calls } = makeSql();
    const input = baseInput({ sql, bodyVaries: true, dripType: 'day_7' });

    await sendAndRecordDrip(input);

    const sendArg = mockSendInternalEmail.mock.calls[0]![0] as { idempotencyKey?: string };
    expect(sendArg.idempotencyKey).toBeUndefined();
    expect(calls.some((text) => /UPDATE onboarding_drip_log SET sent_at/i.test(text))).toBe(true);
  });

  // ── Constraint 2: mark-before-send ordering ─────────────────────────

  it('marks sent_at BEFORE sending when the body varies', async () => {
    const { sql, calls } = makeSql();
    mockSendInternalEmail.mockImplementation(() => {
      expect(calls.some((text) => /UPDATE onboarding_drip_log SET sent_at/i.test(text))).toBe(true);
      return Promise.resolve({ messageId: 'msg-1' });
    });

    await sendAndRecordDrip(baseInput({ sql, bodyVaries: true }));
  });

  it('marks sent_at AFTER sending when the body is stable (keyed path)', async () => {
    const { sql, calls } = makeSql();
    mockSendInternalEmail.mockImplementation(() => {
      expect(calls.some((text) => /UPDATE onboarding_drip_log SET sent_at/i.test(text))).toBe(false);
      return Promise.resolve({ messageId: 'msg-1' });
    });

    await sendAndRecordDrip(baseInput({ sql, bodyVaries: false }));

    expect(calls.some((text) => /UPDATE onboarding_drip_log SET sent_at/i.test(text))).toBe(true);
  });

  // ── Constraint 3: rethrow vs. swallow ───────────────────────────────

  it('rethrows a send failure on the keyed path so BullMQ can retry', async () => {
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend 503'));

    await expect(sendAndRecordDrip(baseInput({ bodyVaries: false }))).rejects.toThrow('Resend 503');

    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('does not rethrow a send failure on the marked path — records it durably instead', async () => {
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend 503'));

    await expect(
      sendAndRecordDrip(baseInput({ bodyVaries: true, outboxAttempt: 3, outboxId: 'outbox-1' })),
    ).resolves.toBeUndefined();

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      expect.anything(),
      'outbox-1',
      'send failed after mark: Resend 503',
      3,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
  });

  // ── Constraint 4: the failure record is best-effort ─────────────────

  it('never escapes when recording the marked-path failure itself fails', async () => {
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend 503'));
    mockMarkOutboxFailed.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(sendAndRecordDrip(baseInput({ bodyVaries: true }))).resolves.toBeUndefined();

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // ── Idempotent replay ────────────────────────────────────────────────

  it('logs and still completes on an idempotent replay', async () => {
    mockSendInternalEmail.mockResolvedValueOnce({
      messageId: 'idempotent-replay:onboarding_drip_day_1:biz-1',
      idempotentReplay: true,
    });
    const logger = makeLogger();

    await sendAndRecordDrip(baseInput({ logger, bodyVaries: false }));

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('already delivered under its idempotency key'),
      expect.anything(),
    );
    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ externalMessageId: 'idempotent-replay:onboarding_drip_day_1:biz-1' }),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  // ── Success path ─────────────────────────────────────────────────────

  it('records the delivery and completes the outbox row on a normal send', async () => {
    const input = baseInput({ outboxId: 'outbox-9', outboxAttempt: 2, accountId: 'acct-9' });

    await sendAndRecordDrip(input);

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-9',
        businessId: 'biz-1',
        template: 'onboarding_drip_day_1',
        externalMessageId: 'msg-1',
      }),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(expect.anything(), 'outbox-9', 2);
  });
});
