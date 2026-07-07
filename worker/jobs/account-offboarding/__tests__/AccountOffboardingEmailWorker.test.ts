import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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

vi.mock('../../../../src/lib/shared/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/shared/outbox')>();
  return {
    ...actual,
    markOutboxCompleted: mockMarkOutboxCompleted,
    markOutboxFailed: mockMarkOutboxFailed,
    extractOutboxHandle: (data: { outbox_id?: string; outbox_attempt?: number }, fallback: string) => ({
      outboxId: data.outbox_id ?? fallback,
      attempt: data.outbox_attempt,
    }),
  };
});

vi.mock('../../../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildAccountOffboardingEmailHtml: mockBuildAccountOffboardingEmailHtml,
}));

import { accountOffboardingDeliveryId } from '../../../../src/lib/account-offboarding/email-dedup';
import { handleAccountOffboardingEmail } from '../AccountOffboardingEmailWorker';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';
import { resetServerConfigForTests } from '../../../../src/lib/config/server';

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
    purge_after: null,
    purge_started_at: null,
    purge_cancelled_at: null,
    terminal_at: null,
    recipient_email: 'snapshot-owner@example.com',
    location_ids: [LOCATION_ID],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
  process.env.SESSION_COOKIE_SECRET = 'test-session-cookie-secret-at-least-32-chars';
  sqlCalls.length = 0;
  sqlReturnQueue.length = 0;
  // The worker reads NEXT_PUBLIC_APP_URL via the memoized getWorkerConfig(); clear
  // the memo so the per-test `delete process.env.NEXT_PUBLIC_APP_URL` is re-parsed
  // on the handler's first read (Stage-3 #6).
  resetWorkerConfigForTests();
  // tokens.ts → session-cookie-secret.ts now reads SESSION_COOKIE_SECRET via the
  // SERVER-lane getServerConfig() (it's a shared src/lib module). Clear that memo
  // too so the `delete process.env.SESSION_COOKIE_SECRET` token-secret-missing
  // case is re-parsed on the handler's first read (Stage-3 #6).
  resetServerConfigForTests();
});

describe('AccountOffboardingEmailWorker', () => {
  it('sends cancel-only confirmation to the offboarding snapshot recipient without loading active businesses', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([{ id: accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation') }]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(mockSql, makeJob());

    expect(mockBuildAccountOffboardingEmailHtml).toHaveBeenCalledWith({
      accessEndsAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'snapshot-owner@example.com',
      subject: 'Your RepWorth cancellation is scheduled',
      bodyHtml: '<html>offboarding</html>',
      category: 'transactional',
      idempotencyKey: `repworth:account-offboarding-email-send:v1:${accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation')}`,
    });
    const sqlText = sqlCalls.map((call) => call.text).join('\n');
    expect(sqlText).not.toContain('FROM businesses');
    expect(sqlText).not.toContain('subscription_status');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('completes a terminal-row email retry after the recipient was scrubbed post-send instead of failing it (M3)', async () => {
    // Retry of an already-delivered keep-my-data email: the row is terminal and its
    // recipient_email was nulled by the post-send scrub. Dedup on the persisted send
    // must run BEFORE validation so the outbox completes rather than spuriously failing
    // on the missing recipient.
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'churned',
      terminal_at: new Date('2026-06-06T12:00:00.000Z'),
      purge_cancelled_at: new Date('2026-06-06T11:00:00.000Z'),
      recipient_email: null,
    })]);
    sqlReturnQueue.push([{ sent_at: new Date('2026-06-06T12:00:00.000Z'), external_message_id: 'msg-sent-1' }]);

    await handleAccountOffboardingEmail(mockSql, makeJob({ email_type: 'keep_my_data_confirmation' }));

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
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

    await handleAccountOffboardingEmail(mockSql, makeJob({
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
      idempotencyKey: `repworth:account-offboarding-email-send:v1:${accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_reactivation_confirmation')}`,
    });
    const claimCall = sqlCalls.find((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(claimCall?.values).toContain(
      accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_reactivation_confirmation'),
    );
    expect(claimCall?.values).toContain('account_offboarding_cancel_only_reactivation_confirmation');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('sends delete-data confirmation with a hashed keep-my-data token created at send time', async () => {
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })]);
    sqlReturnQueue.push([{
      id: accountOffboardingDeliveryId(OFFBOARDING_ID, 'delete_data_confirmation'),
    }]);
    sqlReturnQueue.push([{ id: '44444444-4444-4444-8444-444444444444' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }));

    expect(mockBuildAccountOffboardingEmailHtml).toHaveBeenCalledWith({
      emailType: 'delete_data_confirmation',
      accessEndsAt: null,
      purgeAfter: new Date('2026-07-06T00:00:00.000Z'),
      keepMyDataUrl: expect.stringMatching(
        /^https:\/\/app\.repworth\.com\/api\/account\/offboarding\/keep-my-data\?token=/,
      ),
    });
    const templateCall = sqlCalls.find((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(templateCall?.values).toContain('account_offboarding_delete_data_confirmation');

    const tokenInsert = sqlCalls.find((call) => call.text.includes('INSERT INTO account_offboarding_tokens'));
    expect(tokenInsert?.text).toContain('token_hash');
    const buildCalls = (mockBuildAccountOffboardingEmailHtml as unknown as {
      mock: { calls: Array<[{ keepMyDataUrl: string }]> };
    }).mock.calls;
    const emailParams = buildCalls[0]?.[0];
    expect(emailParams).toBeDefined();
    const rawToken = new URL(emailParams!.keepMyDataUrl).searchParams.get('token');
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(tokenInsert?.values)).not.toContain(rawToken);
    expect(tokenInsert?.values).toContain(
      createHash('sha256').update(rawToken!).digest('hex'),
    );
    expect(tokenInsert?.values).toContainEqual(new Date('2026-07-06T00:00:00.000Z'));
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'snapshot-owner@example.com',
      subject: 'Your RepWorth data deletion is scheduled',
      bodyHtml: '<html>offboarding</html>',
      category: 'transactional',
      idempotencyKey: `repworth:account-offboarding-email-send:v1:${accountOffboardingDeliveryId(OFFBOARDING_ID, 'delete_data_confirmation')}`,
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('sends keep-my-data confirmation after a delete-data purge is cancelled', async () => {
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'purge_scheduled',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
      purge_cancelled_at: new Date('2026-06-20T12:00:00.000Z'),
    })]);
    sqlReturnQueue.push([{
      id: accountOffboardingDeliveryId(OFFBOARDING_ID, 'keep_my_data_confirmation'),
    }]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'keep_my_data_confirmation',
    }));

    expect(mockBuildAccountOffboardingEmailHtml).toHaveBeenCalledWith({
      emailType: 'keep_my_data_confirmation',
      accessEndsAt: null,
    });
    const claimCall = sqlCalls.find((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(claimCall?.values).toContain(
      accountOffboardingDeliveryId(OFFBOARDING_ID, 'keep_my_data_confirmation'),
    );
    expect(claimCall?.values).toContain('account_offboarding_keep_my_data_confirmation');
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'snapshot-owner@example.com',
      subject: 'Your RepWorth data will be kept',
      bodyHtml: '<html>offboarding</html>',
      category: 'transactional',
      idempotencyKey: `repworth:account-offboarding-email-send:v1:${accountOffboardingDeliveryId(OFFBOARDING_ID, 'keep_my_data_confirmation')}`,
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('reclaims a stale unsent keep-my-data delivery claim before sending confirmation', async () => {
    const deliveryId = accountOffboardingDeliveryId(OFFBOARDING_ID, 'keep_my_data_confirmation');
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'purge_scheduled',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
      purge_cancelled_at: new Date('2026-06-20T12:00:00.000Z'),
    })]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ sent_at: null, external_message_id: null }]);
    sqlReturnQueue.push([{ id: deliveryId }]);
    sqlReturnQueue.push([{ id: deliveryId }]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'keep_my_data_confirmation',
    }));

    const claimCalls = sqlCalls.filter((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(claimCalls).toHaveLength(2);
    const staleDeleteCall = sqlCalls.find((call) => call.text.includes('DELETE FROM notification_deliveries'));
    expect(staleDeleteCall?.text).toContain('created_at < NOW() -');
    expect(staleDeleteCall?.values).toContain(deliveryId);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO account_offboarding_tokens'))).toBe(false);
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'snapshot-owner@example.com',
      subject: 'Your RepWorth data will be kept',
      bodyHtml: '<html>offboarding</html>',
      category: 'transactional',
      idempotencyKey: `repworth:account-offboarding-email-send:v1:${deliveryId}`,
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('dedupes by deterministic delivery id and completes the outbox without sending', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ sent_at: new Date('2026-06-06T12:00:00.000Z'), external_message_id: 'msg-sent-1' }]);

    await handleAccountOffboardingEmail(mockSql, makeJob());

    const claimCall = sqlCalls.find((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(claimCall?.values).toContain(accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation'));
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it.each([
    ['cancel_only_confirmation', offboardingRow()],
    ['cancel_only_reactivation_confirmation', offboardingRow({
      status: 'reactivated',
      terminal_at: new Date('2026-06-06T12:00:00.000Z'),
    })],
    ['delete_data_confirmation', offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })],
    ['keep_my_data_confirmation', offboardingRow({
      mode: 'delete_data',
      status: 'purge_scheduled',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
      purge_cancelled_at: new Date('2026-06-20T12:00:00.000Z'),
    })],
  ] as const)('dedupes sent %s deliveries without sending again', async (emailType, row) => {
    sqlReturnQueue.push([row]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ sent_at: new Date('2026-06-06T12:00:00.000Z'), external_message_id: null }]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: emailType,
    }));

    const claimCall = sqlCalls.find((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(claimCall?.values).toContain(accountOffboardingDeliveryId(OFFBOARDING_ID, emailType));
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('sends a purge receipt and atomically completes + scrubs the payload in one outbox update (M2)', async () => {
    mockSendInternalEmail.mockResolvedValueOnce({ messageId: 'msg-purge-receipt-1' });

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'purge_receipt' as AccountOffboardingEmailPayload['email_type'],
      recipient_email: 'owner@example.com',
      purged_at: '2026-07-06T00:00:00.000Z',
    }));

    expect(mockSendInternalEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'owner@example.com',
      subject: 'Your RepWorth data has been deleted',
      category: 'transactional',
    }));
    // No row load and no notification_deliveries claim for the post-purge receipt.
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO notification_deliveries'))).toBe(false);
    expect(sqlCalls.some((call) => call.text.includes('FROM account_offboardings'))).toBe(false);

    // Completion and PII scrub happen in ONE outbox update — no window where the
    // outbox is marked done while the raw recipient still sits in the payload, and
    // no best-effort scrub that could leave permanent residue past purged_at.
    const outboxUpdates = sqlCalls.filter((call) => call.text.includes('UPDATE job_outbox'));
    expect(outboxUpdates).toHaveLength(1);
    expect(outboxUpdates[0]!.text).toContain("status = 'completed'");
    expect(outboxUpdates[0]!.text).toContain("payload = '{}'::jsonb");
    // Must NOT complete via the generic helper, which would leave the scrub as a
    // separate, best-effort step.
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('fails the purge receipt when the outbox payload carries no recipient', async () => {
    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'purge_receipt' as AccountOffboardingEmailPayload['email_type'],
    }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-email-1',
      'account_offboarding_purge_receipt_missing_recipient',
      4,
    );
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('does not create a keep-my-data token on delete-data email dedupe', async () => {
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ sent_at: new Date('2026-06-06T12:00:00.000Z'), external_message_id: 'msg-sent-1' }]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }));

    const sqlText = sqlCalls.map((call) => call.text).join('\n');
    expect(sqlText).not.toContain('INSERT INTO account_offboarding_tokens');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('retries instead of completing when a delete-data delivery claim exists but is not sent', async () => {
    const deliveryId = accountOffboardingDeliveryId(OFFBOARDING_ID, 'delete_data_confirmation');
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ sent_at: null, external_message_id: null }]);
    sqlReturnQueue.push([]);

    await expect(handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }))).rejects.toThrow(`account_offboarding_email_claim_in_progress:${deliveryId}`);

    const sqlText = sqlCalls.map((call) => call.text).join('\n');
    expect(sqlText).toContain('SELECT sent_at, external_message_id');
    expect(sqlText).toContain('created_at < NOW() -');
    expect(sqlText).not.toContain('INSERT INTO account_offboarding_tokens');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('reclaims a stale unsent delete-data delivery claim before creating a keep-my-data token', async () => {
    const deliveryId = accountOffboardingDeliveryId(OFFBOARDING_ID, 'delete_data_confirmation');
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ sent_at: null, external_message_id: null }]);
    sqlReturnQueue.push([{ id: deliveryId }]);
    sqlReturnQueue.push([{ id: deliveryId }]);
    sqlReturnQueue.push([{ id: '44444444-4444-4444-8444-444444444444' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }));

    const claimCalls = sqlCalls.filter((call) => call.text.includes('INSERT INTO notification_deliveries'));
    expect(claimCalls).toHaveLength(2);
    const staleDeleteCall = sqlCalls.find((call) => call.text.includes('DELETE FROM notification_deliveries'));
    expect(staleDeleteCall?.text).toContain('created_at < NOW() -');
    expect(staleDeleteCall?.values).toContain(deliveryId);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO account_offboarding_tokens'))).toBe(true);
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'snapshot-owner@example.com',
      subject: 'Your RepWorth data deletion is scheduled',
      bodyHtml: '<html>offboarding</html>',
      category: 'transactional',
      idempotencyKey: `repworth:account-offboarding-email-send:v1:${deliveryId}`,
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('reclaims a stale unsent delete-data claim and reuses the deterministic token row', async () => {
    const deliveryId = accountOffboardingDeliveryId(OFFBOARDING_ID, 'delete_data_confirmation');
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ sent_at: null, external_message_id: null }]);
    sqlReturnQueue.push([{ id: deliveryId }]);
    sqlReturnQueue.push([{ id: deliveryId }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }));

    const sqlText = sqlCalls.map((call) => call.text).join('\n');
    expect(sqlText).toContain('ON CONFLICT (token_hash) DO NOTHING');
    expect(sqlText).toContain('FROM account_offboarding_tokens');
    expect(sqlText).toContain('created_at < NOW() -');
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'snapshot-owner@example.com',
      subject: 'Your RepWorth data deletion is scheduled',
      bodyHtml: '<html>offboarding</html>',
      category: 'transactional',
      idempotencyKey: `repworth:account-offboarding-email-send:v1:${deliveryId}`,
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-email-1', 4);
  });

  it('rolls back an unsent claim on send failure so BullMQ can retry', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([{ id: accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation') }]);
    sqlReturnQueue.push([]);
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend unavailable'));

    await expect(handleAccountOffboardingEmail(mockSql, makeJob())).rejects.toThrow('Resend unavailable');

    const rollbackCall = sqlCalls.find((call) => call.text.includes('DELETE FROM notification_deliveries'));
    expect(rollbackCall?.text).toContain('external_message_id IS NULL');
    expect(rollbackCall?.values).toContain(accountOffboardingDeliveryId(OFFBOARDING_ID, 'cancel_only_confirmation'));
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('rolls back an unsent delete-data token and claim on send failure', async () => {
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })]);
    sqlReturnQueue.push([{
      id: accountOffboardingDeliveryId(OFFBOARDING_ID, 'delete_data_confirmation'),
    }]);
    sqlReturnQueue.push([{ id: '44444444-4444-4444-8444-444444444444' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend unavailable'));

    await expect(handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }))).rejects.toThrow('Resend unavailable');

    const tokenRollbackCall = sqlCalls.find((call) => call.text.includes('DELETE FROM account_offboarding_tokens'));
    expect(tokenRollbackCall?.text).toContain('consumed_at IS NULL');
    expect(tokenRollbackCall?.text).toContain('revoked_at IS NULL');
    const deliveryRollbackCall = sqlCalls.find((call) => call.text.includes('DELETE FROM notification_deliveries'));
    expect(deliveryRollbackCall?.text).toContain('external_message_id IS NULL');
    expect(deliveryRollbackCall?.values).toContain(
      accountOffboardingDeliveryId(OFFBOARDING_ID, 'delete_data_confirmation'),
    );
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('does not send the scheduled confirmation while billing is still pending', async () => {
    sqlReturnQueue.push([offboardingRow({ status: 'pending', access_ends_at: null })]);

    await handleAccountOffboardingEmail(mockSql, makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-email-1',
      'account_offboarding_status_not_emailable:pending',
      4,
    );
  });

  it('does not send the reactivation confirmation before the row is terminal reactivated', async () => {
    sqlReturnQueue.push([offboardingRow({ status: 'scheduled' })]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'cancel_only_reactivation_confirmation',
    }));

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-email-1',
      'account_offboarding_status_not_reactivated:scheduled',
      4,
    );
  });

  it('fails delete-data confirmation before sending when the app URL is missing', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }));

    const sqlText = sqlCalls.map((call) => call.text).join('\n');
    expect(sqlText).not.toContain('INSERT INTO notification_deliveries');
    expect(sqlText).not.toContain('INSERT INTO account_offboarding_tokens');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-email-1',
      'NEXT_PUBLIC_APP_URL not configured',
      4,
    );
  });

  it('fails delete-data confirmation before claiming delivery when the token secret is missing', async () => {
    delete process.env.SESSION_COOKIE_SECRET;
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
    })]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }));

    const sqlText = sqlCalls.map((call) => call.text).join('\n');
    expect(sqlText).not.toContain('INSERT INTO notification_deliveries');
    expect(sqlText).not.toContain('INSERT INTO account_offboarding_tokens');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-email-1',
      'SESSION_COOKIE_SECRET not configured',
      4,
    );
  });

  it('does not send delete-data confirmation after purge has started', async () => {
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'purge_scheduled',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
      purge_started_at: new Date('2026-07-06T00:00:01.000Z'),
    })]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'delete_data_confirmation',
    }));

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-email-1',
      'account_offboarding_purge_already_started',
      4,
    );
  });

  it('fails keep-my-data confirmation when purge cancellation is missing', async () => {
    sqlReturnQueue.push([offboardingRow({
      mode: 'delete_data',
      status: 'purge_scheduled',
      access_ends_at: null,
      purge_after: new Date('2026-07-06T00:00:00.000Z'),
      purge_cancelled_at: null,
    })]);

    await handleAccountOffboardingEmail(mockSql, makeJob({
      email_type: 'keep_my_data_confirmation',
    }));

    const sqlText = sqlCalls.map((call) => call.text).join('\n');
    expect(sqlText).not.toContain('INSERT INTO notification_deliveries');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-email-1',
      'account_offboarding_missing_purge_cancelled_at',
      4,
    );
  });
});
