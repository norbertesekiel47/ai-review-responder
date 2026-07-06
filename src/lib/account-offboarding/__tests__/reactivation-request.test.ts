import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockEnqueueAccountOffboardingReactivation } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn();
  return {
    mockSql: sqlFn,
    mockEnqueueAccountOffboardingReactivation: vi.fn(),
  };
});

vi.mock('@/lib/account-offboarding/outbox', () => ({
  enqueueAccountOffboardingReactivation: mockEnqueueAccountOffboardingReactivation,
}));

import { requestCancelOnlyReactivation } from '../reactivation-request';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const OFFBOARDING_ID = '22222222-2222-7333-8444-555555555555';
const IDEMPOTENCY_KEY = 'reactivate-key-1';
const IDEMPOTENCY_KEY_HASH = createHash('sha256').update(IDEMPOTENCY_KEY).digest('hex');

interface QueryCall {
  text: string;
  values: unknown[];
}

function makeTx(row: unknown[] = [{
  id: OFFBOARDING_ID,
  mode: 'cancel_only',
  status: 'scheduled',
  stripe_subscription_id: 'sub_snapshot_123',
}]) {
  const calls: QueryCall[] = [];
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return row;
  });
  mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));
  return { tx, calls };
}

describe('requestCancelOnlyReactivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.begin.mockReset();
    mockEnqueueAccountOffboardingReactivation.mockResolvedValue('outbox-1');
  });

  it('locks the scheduled cancel-only row and enqueues reactivation with only the idempotency hash', async () => {
    const { tx, calls } = makeTx();

    const result = await requestCancelOnlyReactivation(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      requestId: 'req-1',
      ip: '203.0.113.20',
      userAgent: 'vitest',
    });

    expect(result).toEqual({
      ok: true,
      status: 'queued',
      offboarding: {
        id: OFFBOARDING_ID,
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'scheduled',
      },
    });
    expect(calls[0]?.text).toContain('FOR UPDATE');
    expect(calls[0]?.text).toContain("mode = 'cancel_only'");
    expect(calls[0]?.text).toContain("status = 'scheduled'");
    expect(calls[0]?.text).toContain('teardown_started_at IS NULL');
    expect(calls[0]?.text).toContain('terminal_at IS NULL');
    expect(mockEnqueueAccountOffboardingReactivation).toHaveBeenCalledWith(tx, {
      accountOffboardingId: OFFBOARDING_ID,
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKeyHash: IDEMPOTENCY_KEY_HASH,
      requestId: 'req-1',
      ip: '203.0.113.20',
      userAgent: 'vitest',
      correlationId: 'req-1',
    });
    expect(JSON.stringify(mockEnqueueAccountOffboardingReactivation.mock.calls)).not.toContain(IDEMPOTENCY_KEY);
  });

  it('does not enqueue when no same-subscription scheduled row exists', async () => {
    makeTx([]);

    const result = await requestCancelOnlyReactivation(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: 'not_reactivatable' });
    expect(mockEnqueueAccountOffboardingReactivation).not.toHaveBeenCalled();
  });
});
