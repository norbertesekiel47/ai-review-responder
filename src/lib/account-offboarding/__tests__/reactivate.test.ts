import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockJsonb, mockStripeSubscriptionsUpdate } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn();
  sqlFn.json = vi.fn((value: unknown) => value);
  return {
    mockSql: sqlFn,
    mockJsonb: vi.fn((value: unknown) => value),
    mockStripeSubscriptionsUpdate: vi.fn(),
  };
});

const { mockWriteAccountAuditLog } = vi.hoisted(() => ({
  mockWriteAccountAuditLog: vi.fn(),
}));

const { mockEnqueueOffboardingReactivated } = vi.hoisted(() => ({
  mockEnqueueOffboardingReactivated: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: mockJsonb,
}));

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

vi.mock('../analytics', () => ({
  enqueueOffboardingReactivated: mockEnqueueOffboardingReactivated,
}));

vi.mock('stripe', () => ({
  default: class FakeStripe {
    subscriptions = {
      update: mockStripeSubscriptionsUpdate,
    };
  },
}));

import { reactivateCancelOnlyOffboarding } from '../reactivate';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const OFFBOARDING_ID = '22222222-2222-7333-8444-555555555555';
const IDEMPOTENCY_KEY = 'reactivate-key-1';
const IDEMPOTENCY_KEY_HASH = createHash('sha256').update(IDEMPOTENCY_KEY).digest('hex');

interface QueryCall {
  text: string;
  values: unknown[];
}

interface TxOptions {
  active?: {
    id: string;
    mode: string;
    status: string;
    teardown_started_at: Date | string | null;
    terminal_at: Date | string | null;
    reactivated_at: Date | string | null;
    last_error: string | null;
    stripe_subscription_id: string | null;
  } | null;
  idempotentReactivated?: {
    id: string;
    mode: 'cancel_only';
    status: 'reactivated';
  } | null;
  updateWins?: boolean;
  claimWins?: boolean;
  terminalReactivated?: boolean;
}

function makeTx(options: TxOptions = {}) {
  const calls: QueryCall[] = [];
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });

    if (text.includes('FROM account_offboardings') && text.includes('FOR UPDATE')) {
      return options.active === null
        ? []
        : [options.active ?? activeRow()];
    }

    if (text.includes('FROM account_offboardings ao') && text.includes('account_offboarding_reactivated')) {
      return options.idempotentReactivated ? [options.idempotentReactivated] : [];
    }

    if (
      text.includes('FROM account_offboardings')
      && text.includes("status = 'reactivated'")
      && text.includes('terminal_at IS NOT NULL')
    ) {
      return options.terminalReactivated ? [{ id: OFFBOARDING_ID }] : [];
    }

    if (text.includes('UPDATE account_offboardings') && text.includes('SET reactivated_at = NOW()')) {
      return options.claimWins === false ? [] : [{ id: OFFBOARDING_ID }];
    }

    if (text.includes('UPDATE account_offboardings') && text.includes("status = 'reactivated'")) {
      return options.updateWins === false ? [] : [{ id: OFFBOARDING_ID }];
    }

    return [];
  });

  mockSql.mockImplementation(tx);
  return { tx, calls };
}

function activeRow(overrides: Partial<TxOptions['active']> = {}) {
  return {
    id: OFFBOARDING_ID,
    mode: 'cancel_only',
    status: 'scheduled',
    teardown_started_at: null,
    terminal_at: null,
    reactivated_at: null,
    last_error: null,
    stripe_subscription_id: 'sub_snapshot_123',
    ...overrides,
  };
}

function sqlText(calls: QueryCall[]): string {
  return calls.map((call) => call.text).join('\n');
}

describe('reactivateCancelOnlyOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockReset();
    mockSql.begin.mockReset();
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    mockEnqueueOffboardingReactivated.mockResolvedValue(undefined);
    mockStripeSubscriptionsUpdate.mockResolvedValue({
      id: 'sub_snapshot_123',
      cancel_at_period_end: false,
      status: 'active',
    });
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  });

  it('locks the active scheduled cancel-only row, reverses Stripe, and terminalizes with audit and email outbox in one transaction', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      requestId: 'req-1',
      ip: '203.0.113.10',
      userAgent: 'vitest',
    });

    expect(result).toEqual({
      ok: true,
      status: 'reactivated',
      offboarding: {
        id: OFFBOARDING_ID,
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'reactivated',
      },
    });
    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith(
      'sub_snapshot_123',
      { cancel_at_period_end: false },
      {
        idempotencyKey:
          `account-offboarding-reactivate:22222222-2222-7333-8444-555555555555:aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee:${IDEMPOTENCY_KEY_HASH}`,
      },
    );

    const combinedSql = sqlText(calls);
    expect(combinedSql).toContain('FOR UPDATE');
    expect(combinedSql).toContain("mode = 'cancel_only'");
    expect(combinedSql).toContain("status = 'scheduled'");
    expect(combinedSql).toContain('teardown_started_at IS NULL');
    expect(combinedSql).toContain('terminal_at IS NULL');
    expect(combinedSql).toContain("status = 'reactivated'");
    expect(combinedSql).toContain('reactivated_at = NOW()');
    expect(combinedSql).toContain('terminal_at = NOW()');

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: USER_ID,
        eventType: 'account_offboarding_reactivated',
        entityType: 'account_offboarding',
        entityId: OFFBOARDING_ID,
        ip: '203.0.113.10',
        userAgent: 'vitest',
        requestId: 'req-1',
        payload: {
          mode: 'cancel_only',
          status: 'reactivated',
          idempotency_key_hash: IDEMPOTENCY_KEY_HASH,
          stripe_subscription_id: 'sub_snapshot_123',
        },
      }),
      tx,
    );

    expect(mockEnqueueOffboardingReactivated).toHaveBeenCalledWith(tx, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      offboardingId: OFFBOARDING_ID,
    });

    const outboxCall = calls.find((call) => call.text.includes('INSERT INTO job_outbox'));
    expect(outboxCall?.values).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL);
    expect(outboxCall?.values).toContain(OFFBOARDING_ID);
    expect(outboxCall?.values).toContainEqual(expect.objectContaining({
      email_type: 'cancel_only_reactivation_confirmation',
    }));
  });

  it('does not call Stripe when there is no reactivatable scheduled row', async () => {
    const { tx } = makeTx({ active: null });
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: 'not_reactivatable' });
    expect(mockStripeSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingReactivated).not.toHaveBeenCalled();
  });

  it('returns the terminal reactivated row for same-key idempotent retries without calling Stripe', async () => {
    const { tx, calls } = makeTx({
      active: null,
      idempotentReactivated: {
        id: OFFBOARDING_ID,
        mode: 'cancel_only',
        status: 'reactivated',
      },
    });
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({
      ok: true,
      status: 'reactivated',
      offboarding: {
        id: OFFBOARDING_ID,
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'reactivated',
      },
    });
    expect(mockStripeSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingReactivated).not.toHaveBeenCalled();
    expect(sqlText(calls)).toContain('FROM account_audit_log');
    expect(sqlText(calls)).toContain('account_offboarding_reactivated');
  });

  it('points to checkout and reconnect when Stripe cannot reverse the snapshot subscription', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));
    mockStripeSubscriptionsUpdate.mockRejectedValueOnce(new Error('No such subscription'));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'stripe_reversal_unavailable',
      recovery: {
        checkoutPath: '/api/billing/checkout',
        reconnectPath: '/api/zernio/connect/start',
      },
    });
    expect(sqlText(calls)).not.toContain("status = 'reactivated'");
    const clearCall = calls.find((call) => call.text.includes('SET reactivated_at = NULL'));
    expect(clearCall?.values).toContain(`reactivation_claim:${IDEMPOTENCY_KEY_HASH}`);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingReactivated).not.toHaveBeenCalled();
  });

  it('keeps the claim and throws for retryable Stripe reversal failures so the worker can retry', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));
    mockStripeSubscriptionsUpdate.mockRejectedValueOnce(Object.assign(
      new Error('Stripe connection timeout'),
      { type: 'StripeAPIConnectionError' },
    ));

    await expect(reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toThrow('account_offboarding_stripe_reactivation_retryable');

    expect(sqlText(calls)).not.toContain("status = 'reactivated'");
    expect(sqlText(calls)).not.toContain('SET reactivated_at = NULL');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingReactivated).not.toHaveBeenCalled();
  });

  it('treats a different Stripe subscription response as non-reversible and keeps the row open', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));
    mockStripeSubscriptionsUpdate.mockResolvedValueOnce({
      id: 'sub_different',
      cancel_at_period_end: false,
      status: 'active',
    });

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'stripe_reversal_unavailable',
      recovery: {
        checkoutPath: '/api/billing/checkout',
        reconnectPath: '/api/zernio/connect/start',
      },
    });
    expect(sqlText(calls)).not.toContain("status = 'reactivated'");
    const clearCall = calls.find((call) => call.text.includes('SET reactivated_at = NULL'));
    expect(clearCall?.text).toContain('last_error =');
    expect(clearCall?.values).toContain(`reactivation_claim:${IDEMPOTENCY_KEY_HASH}`);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingReactivated).not.toHaveBeenCalled();
  });

  it('does not continue a reactivation claim owned by a different idempotency key', async () => {
    const { tx } = makeTx({
      active: activeRow({
        reactivated_at: new Date(),
        last_error: 'reactivation_claim:different-hash',
      }),
    });
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: 'state_changed' });
    expect(mockStripeSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('takes over a stale abandoned reactivation claim with the new idempotency key', async () => {
    const staleClaimedAt = new Date(Date.now() - 10 * 60 * 1000);
    const { tx, calls } = makeTx({
      active: activeRow({
        reactivated_at: staleClaimedAt,
        last_error: 'reactivation_claim:abandoned-hash',
      }),
    });
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({
      ok: true,
      status: 'reactivated',
      offboarding: {
        id: OFFBOARDING_ID,
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'reactivated',
      },
    });
    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith(
      'sub_snapshot_123',
      { cancel_at_period_end: false },
      expect.any(Object),
    );
    const takeoverCall = calls.find((call) => (
      call.text.includes('reactivated_at IS NOT NULL')
      && call.text.includes('last_error =')
      && call.values.includes('reactivation_claim:abandoned-hash')
    ));
    expect(takeoverCall?.values).toContain(`reactivation_claim:${IDEMPOTENCY_KEY_HASH}`);
  });

  it('compensates Stripe and clears the claim when finalization throws after Stripe success', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));
    mockWriteAccountAuditLog.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toThrow('audit insert failed');

    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledTimes(2);
    expect(mockStripeSubscriptionsUpdate).toHaveBeenLastCalledWith(
      'sub_snapshot_123',
      { cancel_at_period_end: true },
      {
        idempotencyKey:
          `account-offboarding-reactivate-compensate:22222222-2222-7333-8444-555555555555:aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee:${IDEMPOTENCY_KEY_HASH}`,
      },
    );
    const clearCall = calls.find((call) => call.text.includes('SET reactivated_at = NULL'));
    expect(clearCall?.text).toContain('last_error =');
    expect(clearCall?.values).toContain(`reactivation_claim:${IDEMPOTENCY_KEY_HASH}`);
  });

  it('uses a state-conditional update so teardown cannot win after reactivation claims the row', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    const claimCall = calls.find((call) => call.text.includes('SET reactivated_at = NOW()'));
    expect(claimCall?.text).toContain("status = 'scheduled'");
    expect(claimCall?.text).toContain('teardown_started_at IS NULL');
    expect(claimCall?.text).toContain('terminal_at IS NULL');
    expect(claimCall?.text).toContain('reactivated_at IS NULL');
    expect(claimCall?.text).toContain('last_error =');
    expect(claimCall?.values).toContain(`reactivation_claim:${IDEMPOTENCY_KEY_HASH}`);

    const finalUpdateCall = calls.find((call) => call.text.includes("status = 'reactivated'"));
    expect(finalUpdateCall?.text).toContain("status = 'scheduled'");
    expect(finalUpdateCall?.text).toContain('teardown_started_at IS NULL');
    expect(finalUpdateCall?.text).toContain('terminal_at IS NULL');
    expect(finalUpdateCall?.text).toContain('reactivated_at IS NOT NULL');
    expect(finalUpdateCall?.text).toContain('last_error =');
  });

  it('scopes worker-driven claims to the payload account_offboarding_id', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      accountOffboardingId: OFFBOARDING_ID,
      actorUserId: USER_ID,
      idempotencyKeyHash: IDEMPOTENCY_KEY_HASH,
    });

    expect(result.ok).toBe(true);
    const lockCall = calls.find((call) => call.text.includes('FROM account_offboardings') && call.text.includes('FOR UPDATE'));
    expect(lockCall?.text).toContain('WHERE id = ?::uuid');
    expect(lockCall?.values).toContain(OFFBOARDING_ID);
  });

  it('compensates Stripe and returns a conflict if the final update loses to teardown', async () => {
    const { tx } = makeTx({ updateWins: false });
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: 'state_changed' });
    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledTimes(2);
    expect(mockStripeSubscriptionsUpdate).toHaveBeenLastCalledWith(
      'sub_snapshot_123',
      { cancel_at_period_end: true },
      {
        idempotencyKey:
          `account-offboarding-reactivate-compensate:22222222-2222-7333-8444-555555555555:aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee:${IDEMPOTENCY_KEY_HASH}`,
      },
    );
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('returns success without compensation when finalization loses to an already terminal same-key row', async () => {
    const { tx } = makeTx({
      updateWins: false,
      idempotentReactivated: {
        id: OFFBOARDING_ID,
        mode: 'cancel_only',
        status: 'reactivated',
      },
    });
    mockSql.begin.mockImplementation(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await reactivateCancelOnlyOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({
      ok: true,
      status: 'reactivated',
      offboarding: {
        id: OFFBOARDING_ID,
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'reactivated',
      },
    });
    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
