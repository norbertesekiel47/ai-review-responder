import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { AccountOffboardingEmailPayload } from '../../../../src/lib/shared/worker-types';

const {
  sqlCalls,
  sqlReturnQueue,
  mockSql,
  mockSendInternalEmail,
  mockBuildAccountOffboardingEmailHtml,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
} = vi.hoisted(() => {
  const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(sqlReturnQueue.shift() ?? []);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));

  return {
    sqlCalls,
    sqlReturnQueue,
    mockSql,
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-offboarding-1' }),
    mockBuildAccountOffboardingEmailHtml: vi.fn(() => '<html>offboarding</html>'),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (data: { outbox_id?: string; outbox_attempt?: number }, fallback: string) => ({
    outboxId: data.outbox_id ?? fallback,
    attempt: data.outbox_attempt,
  }),
}));

vi.mock('../../../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildAccountOffboardingEmailHtml: mockBuildAccountOffboardingEmailHtml,
}));

import {
  accountOffboardingDeliveryId,
  handleAccountOffboardingEmail,
} from '../AccountOffboardingEmailWorker';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OFFBOARDING_ID = '22222222-2222-4222-8222-222222222222';
const LOCATION_ID = '33333333-3333-4333-8333-333333333333';

function makeJob(
  overrides: Partial<AccountOffboardingEmailPayload> = {},
): Job<AccountOffboardingEmailPayload> {
  return {
    id: 'outbox-email-1',
    data: {
      account_id: ACCOUNT_ID,
      account_offboarding_id: OFFBOARDING_ID,
      email_type: 'cancel_only_confirmation',
      idempotency_key_hash: 'idem-hash-1',
      correlation_id: 'corr-1',
      outbox_id: 'outbox-email-1',
      outbox_attempt: 4,
      ...overrides,
    },
  } as Job<AccountOffboardingEmailPayload>;
}

function offboardingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OFFBOARDING_ID,
    account_id: ACCOUNT_ID,
    mode: 'cancel_only',
    status: 'scheduled',
    access_ends_at: new Date('2027-01-01T00:00:00.000Z'),
    recipient_email: 'snapshot-owner@example.com',
    location_ids: [LOCATION_ID],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  sqlReturnQueue.length = 0;
});

describe('AccountOffboardingEmailWorker', () => {
  it('sends cancel-only confirmation to the offboarding snapshot recipient without loading active businesses', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([{ id: accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation') }]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(makeJob());

    expect(mockBuildAccountOffboardingEmailHtml).toHaveBeenCalledWith({
      accessEndsAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'snapshot-owner@example.com',
      subject: 'Your RepWorth cancellation is scheduled',
      bodyHtml: '<html>offboarding</html>',
      category: 'transactional',
    });
    const sqlText = sqlCalls.map((call) => call.text).join('\n');
    expect(sqlText).not.toContain('FROM businesses');
    expect(sqlText).not.toContain('subscription_status');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-email-1', 4);
  });

  it('sends cancel-only reactivation confirmation for a terminal reactivated offboarding', async () => {
    sqlReturnQueue.push([offboardingRow({
      status: 'reactivated',
      terminal_at: new Date('2026-06-06T12:00:00.000Z'),
      access_ends_at: null,
    })]);
    sqlReturnQueue.push([{
      id: accountOffboardingDeliveryId(
        OFFBOARDING_ID,
        'cancel_only_reactivation_confirmation',
      ),
    }]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(makeJob({
      email_type: 'cancel_only_reactivation_confirmation',
    }));

    expect(mockBuildAccountOffboardingEmailHtml).toHaveBeenCalledWith({
      emailType: 'cancel_only_reactivation_confirmation',
      accessEndsAt: null,
    });
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'snapshot-owner@example.com',
      subject: 'Your RepWorth subscription is active again',
      bodyHtml: '<html>offboarding</html>',
      category: 'transactional',
    });
    const claimCall = sqlCalls.find((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(claimCall?.values).toContain(
      accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_reactivation_confirmation'),
    );
    expect(claimCall?.values).toContain('account_offboarding_cancel_only_reactivation_confirmation');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-email-1', 4);
  });

  it('dedupes by deterministic delivery id and completes the outbox without sending', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(makeJob());

    const claimCall = sqlCalls.find((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(claimCall?.values).toContain(accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation'));
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-email-1', 4);
  });

  it('rolls back an unsent claim on send failure so BullMQ can retry', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([{ id: accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation') }]);
    sqlReturnQueue.push([]);
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend unavailable'));

    await expect(handleAccountOffboardingEmail(makeJob())).rejects.toThrow('Resend unavailable');

    const rollbackCall = sqlCalls.find((call) => call.text.includes('DELETE FROM notification_deliveries'));
    expect(rollbackCall?.text).toContain('external_message_id IS NULL');
    expect(rollbackCall?.values).toContain(accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation'));
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('does not send the scheduled confirmation while billing is still pending', async () => {
    sqlReturnQueue.push([offboardingRow({ status: 'pending', access_ends_at: null })]);

    await handleAccountOffboardingEmail(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-email-1',
      'account_offboarding_status_not_emailable:pending',
      4,
    );
  });

  it('does not send the reactivation confirmation before the row is terminal reactivated', async () => {
    sqlReturnQueue.push([offboardingRow({ status: 'scheduled' })]);

    await handleAccountOffboardingEmail(makeJob({
      email_type: 'cancel_only_reactivation_confirmation',
    }));

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-email-1',
      'account_offboarding_status_not_reactivated:scheduled',
      4,
    );
  });
});
