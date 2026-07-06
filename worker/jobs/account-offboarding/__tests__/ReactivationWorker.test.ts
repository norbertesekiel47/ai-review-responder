import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { AccountOffboardingReactivationPayload } from '../../../../src/lib/shared/worker-types';

const {
  mockReactivateCancelOnlyOffboarding,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSql,
} = vi.hoisted(() => ({
  mockReactivateCancelOnlyOffboarding: vi.fn(),
  mockMarkOutboxCompleted: vi.fn(),
  mockMarkOutboxFailed: vi.fn(),
  mockSql: {},
}));

vi.mock('../../../../src/lib/account-offboarding/reactivate', () => ({
  reactivateCancelOnlyOffboarding: mockReactivateCancelOnlyOffboarding,
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (data: { outbox_id?: string; outbox_attempt?: number }, fallback: string) => ({
    outboxId: data.outbox_id ?? fallback,
    attempt: data.outbox_attempt,
  }),
}));

vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { handleAccountOffboardingReactivation } from '../ReactivationWorker';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const OFFBOARDING_ID = '22222222-2222-7333-8444-555555555555';
const IDEMPOTENCY_KEY_HASH = 'hash-reactivate-1';

describe('AccountOffboarding ReactivationWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReactivateCancelOnlyOffboarding.mockResolvedValue({
      ok: true,
      status: 'reactivated',
      offboarding: {
        id: OFFBOARDING_ID,
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'reactivated',
      },
    });
  });

  it('runs Stripe-backed reactivation on the worker and completes the outbox', async () => {
    await handleAccountOffboardingReactivation(mockSql as never, makeJob());

    expect(mockReactivateCancelOnlyOffboarding).toHaveBeenCalledWith(mockSql, {
      accountId: ACCOUNT_ID,
      accountOffboardingId: OFFBOARDING_ID,
      actorUserId: USER_ID,
      idempotencyKeyHash: IDEMPOTENCY_KEY_HASH,
      requestId: 'req-reactivate-1',
      ip: '203.0.113.20',
      userAgent: 'vitest',
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-reactivate-1', 2);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('marks the outbox failed when the row is no longer reactivatable', async () => {
    mockReactivateCancelOnlyOffboarding.mockResolvedValueOnce({
      ok: false,
      reason: 'not_reactivatable',
    });

    await handleAccountOffboardingReactivation(mockSql as never, makeJob());

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-reactivate-1',
      'account_offboarding_reactivation_not_reactivatable',
      2,
    );
  });

  it('lets retryable service failures retry instead of terminally failing the deterministic outbox row', async () => {
    mockReactivateCancelOnlyOffboarding.mockRejectedValueOnce(
      new Error('account_offboarding_stripe_reactivation_retryable'),
    );

    await expect(handleAccountOffboardingReactivation(mockSql as never, makeJob())).rejects.toThrow(
      'account_offboarding_stripe_reactivation_retryable',
    );

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });
});

function makeJob(): Job<AccountOffboardingReactivationPayload> {
  return {
    id: 'outbox-reactivate-1',
    data: {
      account_id: ACCOUNT_ID,
      account_offboarding_id: OFFBOARDING_ID,
      actor_user_id: USER_ID,
      idempotency_key_hash: IDEMPOTENCY_KEY_HASH,
      request_id: 'req-reactivate-1',
      ip: '203.0.113.20',
      user_agent: 'vitest',
      correlation_id: 'req-reactivate-1',
      outbox_id: 'outbox-reactivate-1',
      outbox_attempt: 2,
    },
  } as Job<AccountOffboardingReactivationPayload>;
}
