import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn();
  return { mockSql: sqlFn };
});

const { mockWriteAccountAuditLog } = vi.hoisted(() => ({
  mockWriteAccountAuditLog: vi.fn(),
}));

const { mockEnqueueBillingSchedule } = vi.hoisted(() => ({
  mockEnqueueBillingSchedule: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('@/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('@/lib/shared/job-outbox-helpers', () => ({
  enqueueAccountOffboardingBillingSchedule: mockEnqueueBillingSchedule,
}));

import { retryCancelOnlyBillingSchedule } from '../retry-billing';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const OFFBOARDING_ID = 'bbbbbbbb-2222-7333-8444-555555555555';
const IDEMPOTENCY_KEY = 'retry-key-1';

interface QueryCall {
  text: string;
  values: unknown[];
}

function makeTx(options: { failedRow?: { id: string } | null; resetWins?: boolean } = {}) {
  const calls: QueryCall[] = [];
  const failedRow = options.failedRow === undefined ? { id: OFFBOARDING_ID } : options.failedRow;
  const resetWins = options.resetWins ?? true;
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });

    if (text.includes('FROM accounts') && text.includes('FOR UPDATE')) {
      return [{ id: ACCOUNT_ID }];
    }
    if (text.includes('UPDATE account_offboardings')) {
      return resetWins ? [{ id: OFFBOARDING_ID }] : [];
    }
    if (text.includes('FROM account_offboardings')) {
      return failedRow ? [failedRow] : [];
    }
    return [];
  });
  return { tx, calls };
}

function sqlText(calls: QueryCall[]): string {
  return calls.map((call) => call.text).join('\n');
}

describe('retryCancelOnlyBillingSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.begin.mockReset();
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    mockEnqueueBillingSchedule.mockResolvedValue('outbox-retry-1');
  });

  it('resets a failed/billing row to pending and re-enqueues the billing schedule in one tx', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await retryCancelOnlyBillingSchedule({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({
      ok: true,
      offboarding: { id: OFFBOARDING_ID, accountId: ACCOUNT_ID, mode: 'cancel_only', status: 'pending' },
    });

    const combined = sqlText(calls);
    expect(combined).toContain('FROM accounts');
    expect(combined).toContain('FOR UPDATE');
    expect(combined).toContain("status = 'failed'");
    expect(combined).toContain("failed_step = 'billing'");
    expect(combined).toContain("status = 'pending'");
    expect(combined).toContain("stripe_step = 'not_applicable'");

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: USER_ID,
        eventType: 'account_offboarding_billing_retry',
        entityType: 'account_offboarding',
        entityId: OFFBOARDING_ID,
      }),
      tx,
    );
    expect(mockEnqueueBillingSchedule).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ accountOffboardingId: OFFBOARDING_ID, accountId: ACCOUNT_ID }),
    );
  });

  it('returns not_retryable and enqueues nothing when no failed/billing row exists', async () => {
    const { tx, calls } = makeTx({ failedRow: null });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await retryCancelOnlyBillingSchedule({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: 'not_retryable' });
    expect(sqlText(calls)).not.toContain("status = 'pending'");
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueBillingSchedule).not.toHaveBeenCalled();
  });

  it('returns not_retryable when the reset loses a concurrency race', async () => {
    const { tx } = makeTx({ resetWins: false });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await retryCancelOnlyBillingSchedule({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: 'not_retryable' });
    expect(mockEnqueueBillingSchedule).not.toHaveBeenCalled();
  });
});
