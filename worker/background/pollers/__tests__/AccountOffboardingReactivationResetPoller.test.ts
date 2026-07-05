import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSql,
  mockStripeUpdate,
  mockWriteAccountAuditLog,
  mockAccountOffboardingEnabled,
  mockLoggerLog,
  mockLoggerError,
} = vi.hoisted(() => {
  const mockSql: any = vi.fn();
  mockSql.begin = vi.fn();
  return {
    mockSql,
    mockStripeUpdate: vi.fn(),
    mockWriteAccountAuditLog: vi.fn(),
    mockAccountOffboardingEnabled: vi.fn(() => true),
    mockLoggerLog: vi.fn(),
    mockLoggerError: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../../../../src/lib/account-offboarding/flags', () => ({
  accountOffboardingEnabled: mockAccountOffboardingEnabled,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  toError: (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
  logUnhandledPollError: () => () => {},
  createWorkerLogger: () => ({ log: mockLoggerLog, error: mockLoggerError }),
}));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    subscriptions = { update: mockStripeUpdate };
  },
}));

import { runAccountOffboardingReactivationResetOnce } from '../AccountOffboardingReactivationResetPoller';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OFFBOARDING_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = 'stale-claim-token-hash';

interface TxCall { text: string; values: unknown[] }

function setup(options: {
  candidates?: Array<Record<string, unknown>>;
  clearWins?: boolean;
} = {}) {
  const candidates = options.candidates ?? [{
    id: OFFBOARDING_ID,
    account_id: ACCOUNT_ID,
    stripe_subscription_id: 'sub_live_1',
    reactivation_claim_token: CLAIM_TOKEN,
  }];
  const txCalls: TxCall[] = [];

  mockSql.mockImplementation(() => Promise.resolve(candidates));
  mockSql.begin.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
    const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      txCalls.push({ text: strings.join('?'), values });
      return Promise.resolve(options.clearWins === false ? [] : [{ id: OFFBOARDING_ID }]);
    });
    return cb(tx);
  });

  return { txCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockSql.begin.mockReset();
  mockAccountOffboardingEnabled.mockReturnValue(true);
  mockStripeUpdate.mockResolvedValue({ id: 'sub_live_1', cancel_at_period_end: true });
  mockWriteAccountAuditLog.mockResolvedValue(undefined);
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
});

describe('AccountOffboardingReactivationResetPoller', () => {
  it('compensates Stripe back to cancel_at_period_end and clears a stale reactivation claim with an audit row', async () => {
    const { txCalls } = setup();

    await runAccountOffboardingReactivationResetOnce();

    expect(mockStripeUpdate).toHaveBeenCalledWith(
      'sub_live_1',
      { cancel_at_period_end: true },
      {
        idempotencyKey:
          `account-offboarding-reactivate-compensate:${OFFBOARDING_ID}:${ACCOUNT_ID}:${CLAIM_TOKEN}`,
      },
    );

    const clearCall = txCalls.find((call) => call.text.includes('SET reactivation_claimed_at = NULL'));
    expect(clearCall).toBeDefined();
    expect(clearCall!.text).toContain('reactivation_claim_token =');
    expect(clearCall!.values).toContain(CLAIM_TOKEN);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        eventType: 'account_offboarding_reactivation_claim_reset',
        entityType: 'account_offboarding',
        entityId: OFFBOARDING_ID,
      }),
    );
  });

  it('does not write an audit row when the guarded clear loses to a concurrent takeover or finalize', async () => {
    setup({ clearWins: false });

    await runAccountOffboardingReactivationResetOnce();

    expect(mockStripeUpdate).toHaveBeenCalledOnce();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('defers (no clear, no audit) when Stripe compensation fails retryably', async () => {
    setup();
    mockStripeUpdate.mockRejectedValueOnce(Object.assign(
      new Error('Stripe connection reset'),
      { type: 'StripeAPIConnectionError' },
    ));

    await runAccountOffboardingReactivationResetOnce();

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('still releases the claim when Stripe compensation fails permanently (subscription already gone)', async () => {
    const { txCalls } = setup();
    mockStripeUpdate.mockRejectedValueOnce(Object.assign(
      new Error('No such subscription'),
      { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' },
    ));

    await runAccountOffboardingReactivationResetOnce();

    expect(txCalls.some((call) => call.text.includes('SET reactivation_claimed_at = NULL'))).toBe(true);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
  });

  it('is a no-op when the feature flag is off', async () => {
    mockAccountOffboardingEnabled.mockReturnValue(false);
    setup();

    await runAccountOffboardingReactivationResetOnce();

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when there are no stale claims', async () => {
    setup({ candidates: [] });

    await runAccountOffboardingReactivationResetOnce();

    expect(mockStripeUpdate).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
