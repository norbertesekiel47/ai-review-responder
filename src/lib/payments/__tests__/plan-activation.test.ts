import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type { Sql } from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
  type RecordedSqlCall,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { resetServerConfigForTests } from '@/lib/config/server';

const {
  mockTrialEnabled,
  mockStripeTaxEnabled,
  mockAssertTierPurchasable,
  retrieveSessionMock,
  expireSessionMock,
  reportCaughtErrorMock,
  loggerMock,
} = vi.hoisted(() => ({
  mockTrialEnabled: vi.fn(),
  mockStripeTaxEnabled: vi.fn(),
  mockAssertTierPurchasable: vi.fn(),
  retrieveSessionMock: vi.fn(),
  expireSessionMock: vi.fn(),
  reportCaughtErrorMock: vi.fn(),
  loggerMock: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// `betaCompCouponId` is deliberately NOT mocked: the coupon decision's second
// input is the env var itself, so these tests drive the REAL accessor through
// getServerConfig() and prove the wiring, not a stub.
vi.mock('../flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../flags')>()),
  trialEnabled: mockTrialEnabled,
  stripeTaxEnabled: mockStripeTaxEnabled,
}));
vi.mock('@/lib/shared/report-caught-error', () => ({
  reportCaughtError: reportCaughtErrorMock,
}));
vi.mock('@/lib/shared/logger', () => ({
  createWorkerLogger: () => loggerMock,
}));
vi.mock('@/lib/payments/tier-purchasability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/tier-purchasability')>()),
  assertTierPurchasable: mockAssertTierPurchasable,
}));
vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        retrieve: retrieveSessionMock,
        expire: expireSessionMock,
      },
    },
  }),
}));

import {
  applyTierSnapshot as applyTierSnapshotImpl,
  CheckoutAttemptConflictError,
  isTrialEligible,
  primaryOnboardedBySql,
  releaseCouponFaultedAttempt,
  resolveCheckoutContext,
  type ApplyTierSnapshotParams,
} from '../plan-activation';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BUSINESS_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
/** A non-primary location on the same account. */
const SECONDARY_BUSINESS_ID = 'cccccccc-dddd-eeee-ffff-000000000000';
const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'cs_prior';

let harness: MockSqlHarness;
let mockSql: Sql;

function applyTierSnapshot(
  sql: Sql,
  params: Omit<ApplyTierSnapshotParams, 'ownerEmail' | 'trial'> &
    Partial<Pick<ApplyTierSnapshotParams, 'ownerEmail' | 'trial'>>,
) {
  return applyTierSnapshotImpl(sql, {
    ownerEmail: 'owner@example.com',
    trial: false,
    ...params,
  });
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    subscription_status: 'pending_payment',
    price_variant: 'list',
    active_locations: 3,
    checkout_attempt_id: null,
    checkout_session_id: null,
    checkout_attempt_state: null,
    checkout_attempt_tier: null,
    checkout_attempt_price_variant: null,
    checkout_attempt_base_price_id: null,
    checkout_attempt_overage_price_id: null,
    checkout_attempt_base_price_cents: null,
    checkout_attempt_overage_price_cents: null,
    checkout_attempt_locations_included: null,
    checkout_attempt_locations_paid: null,
    checkout_attempt_overage_quantity: null,
    primary_onboarded_by: null,
    ...overrides,
  };
}

function copilotAttempt(overrides: Record<string, unknown> = {}) {
  return accountRow({
    checkout_attempt_id: ATTEMPT_ID,
    checkout_session_id: SESSION_ID,
    checkout_attempt_state: 'open',
    checkout_attempt_tier: 'copilot',
    checkout_attempt_price_variant: 'list',
    checkout_attempt_base_price_id: 'price_copilot_list',
    checkout_attempt_overage_price_id: 'price_copilot_overage',
    checkout_attempt_base_price_cents: 2900,
    checkout_attempt_overage_price_cents: 1500,
    checkout_attempt_locations_included: 1,
    checkout_attempt_locations_paid: 0,
    checkout_attempt_overage_quantity: 2,
    ...overrides,
  });
}

function queueLocksAndRow(row: Record<string, unknown> | null): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult(row ? [{ id: ACCOUNT_ID }] : []),
  );
  if (row) harness.sqlReturnQueue.push(mkTaggedResult([row]));
}

function queueBusinessMirrorSync(tier: string): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{ id: BUSINESS_ID }]),
    mkTaggedResult([{}]),
    mkTaggedResult([{ subscription_tier: tier }]),
    mkTaggedResult([{}]),
  );
}

function queueNewSelection(row = accountRow()): void {
  queueLocksAndRow(row);
  harness.sqlReturnQueue.push(
    mkTaggedResult([
      {
        subscription_status: 'pending_payment',
        price_variant: row.price_variant,
      },
    ]),
    mkTaggedResult([{ id: ACCOUNT_ID }]),
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
  );
}

beforeEach(() => {
  harness = createMockSql();
  // `tx.savepoint(cb)` — the shared mock harness does not model it, and
  // `applyTierSnapshot` now emits the coupon-decision event through a savepoint
  // so the event commits with the decision instead of after it. A handle without
  // `.savepoint` is a documented hazard here rather than a harmless gap: it
  // raises `TypeError: tx.savepoint is not a function`, which
  // `emitCouponDecisionEvent` deliberately RETHROWS (no `code`), so a missing
  // stub fails loudly instead of passing vacuously — see the long note in
  // `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts`.
  //
  // Stubbed locally, not in `worker/__tests__/helpers/mock-sql.ts`, because that
  // helper is outside this branch's `allowed_edit_surface`; promoting it there is
  // filed in `docs/future-plans/2026-08-14-unify-create-business-insert-paths.md`.
  //
  // Rejections PROPAGATE, matching Postgres: a failed savepoint rolls back to
  // the savepoint and leaves the transaction usable, and what that means is the
  // caller's catch — which is the behaviour under test.
  // Cast because `MockSql` does not declare `savepoint` — that declaration
  // belongs in the shared helper, which is off-surface for this branch (see the
  // follow-up doc). Widening here, not with `any`, keeps the no-`any` rule.
  (
    harness.mockSql as unknown as {
      savepoint: (cb: (sp: unknown) => Promise<unknown>) => Promise<unknown>;
    }
  ).savepoint = vi.fn(async (cb: (sp: unknown) => Promise<unknown>) =>
    cb(harness.mockSql),
  );
  mockSql = harness.mockSql as unknown as Sql;
  mockTrialEnabled.mockReset();
  mockTrialEnabled.mockReturnValue(false);
  mockStripeTaxEnabled.mockReset();
  mockStripeTaxEnabled.mockReturnValue(false);
  mockAssertTierPurchasable.mockReset();
  retrieveSessionMock.mockReset();
  retrieveSessionMock.mockResolvedValue({ id: SESSION_ID, status: 'open' });
  expireSessionMock.mockReset();
  expireSessionMock.mockResolvedValue({ id: SESSION_ID, status: 'expired' });
  vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', 'price_copilot_list');
  vi.stubEnv('STRIPE_PRICE_COPILOT_FOUNDING', 'price_copilot_founding');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_LIST', 'price_autopilot_list');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_FOUNDING', 'price_autopilot_founding');
  vi.stubEnv('STRIPE_PRICE_COPILOT_OVERAGE', 'price_copilot_overage');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_OVERAGE', 'price_autopilot_overage');
  // The second flag term of `isTrialEligible`. Read through `readFlag`, which
  // is deliberately un-memoized, so stubbing the env IS the seam — there is no
  // accessor mock to keep in sync.
  vi.stubEnv('SELF_SERVE_SIGNUP_ENABLED', 'true');
  reportCaughtErrorMock.mockReset();
  loggerMock.log.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  // Comp OFF by default: '' collapses to undefined through optionalVar, which
  // is exactly the kill-switch position.
  vi.stubEnv('BETA_COMP_COUPON_ID', '');
  resetServerConfigForTests();
});

/** Stub the comp env var and force the memoized server config to re-read it. */
function setBetaCompCoupon(value: string | undefined): void {
  vi.stubEnv('BETA_COMP_COUPON_ID', value ?? '');
  resetServerConfigForTests();
}

/** The single `UPDATE accounts SET checkout_attempt_…` lease write. */
function leaseWriteCall(): RecordedSqlCall {
  const call = harness.sqlCalls.find((entry) =>
    /UPDATE\s+accounts[\s\S]*checkout_attempt_state\s*=\s*'creating'/i.test(entry.text),
  );
  if (!call) throw new Error('no Checkout attempt lease write was issued');
  return call;
}

/** The bound value of `checkout_attempt_coupon_id` on the lease write. */
function snapshottedCouponId(): unknown {
  const call = leaseWriteCall();
  const placeholderIndex = call.text
    .slice(0, call.text.indexOf('checkout_attempt_coupon_id'))
    .split('?').length - 1;
  return call.values[placeholderIndex];
}

/** The analytics INSERT emitted after the snapshot transaction commits. */
function couponAnalyticsCall(): RecordedSqlCall | undefined {
  return harness.sqlCalls.find((entry) =>
    /INSERT INTO analytics_events/i.test(entry.text),
  );
}

describe('applyTierSnapshot authoritative Checkout attempt', () => {
  it('writes the full founding Autopilot lease and pending billing snapshot in fixed lock order', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://frozen.example.com');
    mockStripeTaxEnabled.mockReturnValue(true);
    queueNewSelection(accountRow({ price_variant: 'founding' }));
    queueBusinessMirrorSync(SubscriptionTier.AUTOPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
      ownerEmail: '  founder@example.com  ',
      trial: true,
    });

    expect(result).toMatchObject({
      kind: 'ok',
      accountId: ACCOUNT_ID,
      variant: 'founding',
      attemptId: expect.any(String),
    });
    const calls = harness.sqlCalls;
    expect(calls.slice(0, 3).map((call) => call.values[0])).toEqual([
      `${ACCOUNT_ID}:tier_entitlement`,
      `${ACCOUNT_ID}:overage_sync`,
      `${BUSINESS_ID}:activation`,
    ]);
    expect(calls[3]!.text).toContain('FOR UPDATE');
    expect(calls[4]!.text).not.toContain('FOR UPDATE');
    const snapshotWrite = calls[6]!;
    expect(snapshotWrite.values).toEqual(
      expect.arrayContaining(['autopilot', 4900, 2000, 1, 0, ACCOUNT_ID]),
    );
    const leaseWrite = calls[8]!;
    expect(leaseWrite.text).toMatch(/checkout_attempt_state\s*=\s*'creating'/);
    expect(leaseWrite.values).toEqual(
      expect.arrayContaining([
        'autopilot',
        'founding',
        'price_autopilot_founding',
        'price_autopilot_overage',
        4900,
        2000,
        1,
        2,
        30,
        true,
        'founder@example.com',
        'https://frozen.example.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}',
        'https://frozen.example.com/onboarding/pay?cancelled=true',
        ACCOUNT_ID,
      ]),
    );
    expect(harness.sqlReturnQueue).toHaveLength(0);
    // 13 as before + the post-commit coupon-decision analytics INSERT.
    expect(calls).toHaveLength(14);
  });

  it('reuses the stable identity for the same creating attempt', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', '');
    queueLocksAndRow(
      copilotAttempt({
        checkout_session_id: null,
        checkout_attempt_state: 'creating',
      }),
    );
    queueBusinessMirrorSync(SubscriptionTier.COPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.COPILOT,
      ownerEmail: '   ',
      trial: true,
    });

    expect(result).toEqual({
      kind: 'ok',
      accountId: ACCOUNT_ID,
      variant: 'list',
      attemptId: ATTEMPT_ID,
    });
    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(9);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('same-selection replay reuses the provider-open Session', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', 'price_deploy_drift');
    queueLocksAndRow(copilotAttempt());
    queueBusinessMirrorSync(SubscriptionTier.COPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.COPILOT,
      ownerEmail: '   ',
      trial: true,
    });

    expect(result).toMatchObject({ attemptId: ATTEMPT_ID });
    expect(retrieveSessionMock).toHaveBeenCalledWith(SESSION_ID);
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(9);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('gate closure still permits exact reuse of an authoritative open Session', async () => {
    queueLocksAndRow(copilotAttempt({
      subscription_tier: 'autopilot',
      checkout_attempt_tier: 'autopilot',
      checkout_attempt_base_price_id: 'price_autopilot_list',
      checkout_attempt_overage_price_id: 'price_autopilot_overage',
      checkout_attempt_base_price_cents: 6900,
      checkout_attempt_overage_price_cents: 2000,
    }));
    queueBusinessMirrorSync(SubscriptionTier.AUTOPILOT);
    mockAssertTierPurchasable.mockImplementation(() => {
      throw new Error('gate closed');
    });

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
    });

    expect(result).toMatchObject({ kind: 'ok', attemptId: ATTEMPT_ID });
    expect(retrieveSessionMock).toHaveBeenCalledWith(SESSION_ID);
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(mockAssertTierPurchasable).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(9);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('gate-closed different-tier selection does not expire the existing open Session', async () => {
    queueLocksAndRow(copilotAttempt());
    mockAssertTierPurchasable.mockImplementationOnce(() => {
      throw new Error('Autopilot unavailable');
    });

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toThrow('Autopilot unavailable');

    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(
      false,
    );
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('expires the previous open Session before persisting a replacement selection', async () => {
    queueNewSelection(copilotAttempt());
    queueBusinessMirrorSync(SubscriptionTier.AUTOPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
    });

    expect(result).toMatchObject({ kind: 'ok', variant: 'list' });
    expect(result.kind === 'ok' && result.attemptId).not.toBe(ATTEMPT_ID);
    expect(expireSessionMock).toHaveBeenCalledWith(
      SESSION_ID,
      {},
      { idempotencyKey: `checkout-attempt-expire:v1:${SESSION_ID}` },
    );
    // 13 as before + the post-commit coupon-decision analytics INSERT.
    expect(harness.sqlCalls).toHaveLength(14);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('blocks replacement when the prior Session is already complete', async () => {
    queueLocksAndRow(copilotAttempt());
    retrieveSessionMock.mockResolvedValueOnce({
      id: SESSION_ID,
      status: 'complete',
    });

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('failed expiry leaves the old lease intact and creates no replacement', async () => {
    queueLocksAndRow(copilotAttempt());
    expireSessionMock.mockRejectedValueOnce(new Error('provider expiry failed'));
    retrieveSessionMock
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'open' })
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'open' });

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toThrow('provider expiry failed');
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(
      false,
    );
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('expire-versus-complete race converges by blocking the replacement', async () => {
    queueLocksAndRow(copilotAttempt());
    expireSessionMock.mockRejectedValueOnce(new Error('session no longer open'));
    retrieveSessionMock
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'open' })
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'complete' });

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(
      false,
    );
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('a different selection cannot supersede a provider-ambiguous creating attempt', async () => {
    queueLocksAndRow(
      copilotAttempt({
        checkout_session_id: null,
        checkout_attempt_state: 'creating',
      }),
    );

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);
    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('gate rejection performs no mutation or provider call', async () => {
    queueLocksAndRow(accountRow());
    mockAssertTierPurchasable.mockImplementationOnce(() => {
      throw new Error('Autopilot unavailable');
    });
    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toThrow('Autopilot unavailable');
    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(
      false,
    );
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('blocks a pending account with active delete-data offboarding before provider or snapshot work', async () => {
    queueLocksAndRow(accountRow({
      offboarding_id: '22222222-3333-4444-8555-666666666666',
      offboarding_account_id: ACCOUNT_ID,
      offboarding_mode: 'delete_data',
      offboarding_status: 'pending',
      offboarding_failed_step: null,
      offboarding_access_ends_at: null,
      offboarding_teardown_started_at: null,
      offboarding_purge_after: null,
      offboarding_purge_started_at: null,
      offboarding_purge_cancelled_at: null,
    }));

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.COPILOT,
      }),
    ).resolves.toEqual({ kind: 'offboarding_blocked' });

    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(
      harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text)),
    ).toBe(false);
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('missing and non-pending accounts perform no provider or snapshot writes', async () => {
    queueLocksAndRow(null);
    expect(
      await applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.COPILOT,
      }),
    ).toEqual({ kind: 'not_found' });
    expect(harness.sqlCalls).toHaveLength(4);
    expect(harness.sqlReturnQueue).toHaveLength(0);

    harness.resetMockSql();
    queueLocksAndRow(accountRow({ subscription_status: 'active' }));
    expect(
      await applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.COPILOT,
      }),
    ).toEqual({ kind: 'wrong_status', status: 'active' });
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
    expect(retrieveSessionMock).not.toHaveBeenCalled();
  });
});

describe('applyTierSnapshot beta comp coupon snapshot', () => {
  const COUPON_ID = 'beta_comp_3mo';
  const ADMIN_ID = '33333333-4444-4555-8666-777777777777';

  async function selectCopilot(row: Record<string, unknown>) {
    queueNewSelection(accountRow(row));
    queueBusinessMirrorSync(SubscriptionTier.COPILOT);
    return applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.COPILOT,
    });
  }

  it('snapshots the coupon id when the primary business is admin-onboarded and BETA_COMP_COUPON_ID is set', async () => {
    setBetaCompCoupon(COUPON_ID);

    const result = await selectCopilot({ primary_onboarded_by: ADMIN_ID });

    expect(result).toMatchObject({ kind: 'ok' });
    expect(snapshottedCouponId()).toBe(COUPON_ID);
  });

  it('snapshots NULL when BETA_COMP_COUPON_ID is unset', async () => {
    setBetaCompCoupon(undefined);

    await selectCopilot({ primary_onboarded_by: ADMIN_ID });

    // An invitee with the comp switched off is an explicit no-coupon DECISION,
    // not a missing value — and the reason must say so.
    expect(snapshottedCouponId()).toBeNull();
    expect(loggerMock.log).toHaveBeenCalledWith(
      'Beta comp coupon decision',
      expect.objectContaining({ decision: 'skipped:env_unset', reason: 'env_unset' }),
    );
  });

  it('snapshots NULL when the primary business is self-serve (onboarded_by IS NULL)', async () => {
    setBetaCompCoupon(COUPON_ID);

    await selectCopilot({ primary_onboarded_by: null });

    expect(snapshottedCouponId()).toBeNull();
    expect(loggerMock.log).toHaveBeenCalledWith(
      'Beta comp coupon decision',
      expect.objectContaining({ decision: 'skipped:not_invited' }),
    );
  });

  it('resolves coupon eligibility from the primary business on a multi-location account', async () => {
    setBetaCompCoupon(COUPON_ID);

    // Three active locations, only the PRIMARY one carries onboarded_by.
    await selectCopilot({ primary_onboarded_by: ADMIN_ID, active_locations: 3 });

    const selectCall = harness.sqlCalls.find((call) =>
      /primary_onboarded_by/.test(call.text),
    )!;
    // The eligibility read is a scalar subquery over the primary Business …
    expect(selectCall.text).toMatch(
      /SELECT pb\.onboarded_by[\s\S]*pb\.is_primary = TRUE[\s\S]*AS primary_onboarded_by/,
    );
    // … and the COUNT join stays unfiltered, so the location count survives.
    expect(selectCall.text).not.toMatch(/LEFT JOIN businesses b[\s\S]*b\.is_primary/);
    expect(snapshottedCouponId()).toBe(COUPON_ID);
    // Copilot includes 1 location, so 3 active locations must still bill 2
    // overage seats — the regression an is_primary join predicate would cause.
    expect(leaseWriteCall().values).toEqual(expect.arrayContaining([2]));
  });

  it('records a coupon_decision analytics event for an applied coupon', async () => {
    setBetaCompCoupon(COUPON_ID);

    const result = await selectCopilot({ primary_onboarded_by: ADMIN_ID });

    const call = couponAnalyticsCall();
    expect(call).toBeDefined();
    expect(call!.values).toEqual(
      expect.arrayContaining([
        'checkout_coupon_decision',
        `checkout_coupon_decision:${result.kind === 'ok' ? result.attemptId : ''}`,
      ]),
    );
    expect(call!.values).toContainEqual(
      expect.objectContaining({
        decision: 'applied',
        reason: 'applied',
        coupon_applied: true,
      }),
    );
    // INSIDE the tier-snapshot transaction, via a savepoint. Migration 106's
    // header calls this event the ONLY durable signal that a comp was silently
    // skipped before a beta tester is charged, and a post-commit emitter loses
    // exactly that signal in exactly the case it exists for: a crash between
    // COMMIT and the insert leaves an attempt whose coupon answer nothing
    // records. In-transaction, the event commits iff the decision does.
    //
    // The un-migrated-106 safety that originally justified post-commit is kept
    // by the SAVEPOINT, not by the ordering: a CHECK violation rolls back to the
    // savepoint and is swallowed, so the snapshot still commits (pinned by the
    // sibling test below).
    expect(call!.inTransaction).toBe(true);
  });

  it('records a coupon_decision analytics event with reason not_invited', async () => {
    setBetaCompCoupon(COUPON_ID);

    await selectCopilot({ primary_onboarded_by: null });

    expect(couponAnalyticsCall()!.values).toContainEqual(
      expect.objectContaining({ reason: 'not_invited', coupon_applied: false }),
    );
  });

  it('records a coupon_decision analytics event with reason env_unset', async () => {
    setBetaCompCoupon(undefined);

    await selectCopilot({ primary_onboarded_by: ADMIN_ID });

    expect(couponAnalyticsCall()!.values).toContainEqual(
      expect.objectContaining({ reason: 'env_unset', coupon_applied: false }),
    );
  });

  it('never lets a failed analytics emission fail an already-committed attempt', async () => {
    setBetaCompCoupon(COUPON_ID);
    queueNewSelection(accountRow({ primary_onboarded_by: ADMIN_ID }));
    // The emission now runs INSIDE the transaction, so its rejection is queued
    // BEFORE the post-commit mirror sync — the ordering is part of the contract.
    //
    // The code lives on a `code` PROPERTY, not in the message. That is what
    // `errorStringProperty(err, 'code')` narrows on, and it is the shape
    // Postgres.js actually delivers; a bare `new Error('23514 …')` is a codeless
    // error, which this guard deliberately RETHROWS (see the sibling test).
    harness.sqlReturnQueue.push(
      Promise.reject(
        Object.assign(new Error('analytics_events_event_name_check'), {
          code: '23514',
        }),
      ),
    );
    queueBusinessMirrorSync(SubscriptionTier.COPILOT);

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.COPILOT,
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
    expect(reportCaughtErrorMock).toHaveBeenCalledWith(
      'checkout-attempt',
      expect.any(Error),
      expect.objectContaining({
        reason: 'checkout_coupon_decision_analytics_enqueue_failed',
      }),
    );
  });

  it('rethrows a CODELESS emission failure instead of swallowing it', async () => {
    // The other half of the narrowing, and the reason it is bounded at all. A
    // `23514` carries a string `code` and is swallowed whether or not the bound
    // exists, so deleting the guard would leave the sibling test green. The
    // hazard it actually closes is a handle with no `.savepoint` — a `TypeError`
    // with no `code`, which is a WIRING bug, not schema drift. Swallowing it
    // would kill this event forever behind a warning that reads like a missing
    // migration; `import-consent.ts` names the same class-2 hazard, and it has
    // already shipped once in this repo.
    setBetaCompCoupon(COUPON_ID);
    queueNewSelection(accountRow({ primary_onboarded_by: ADMIN_ID }));
    harness.sqlReturnQueue.push(
      Promise.reject(new TypeError('tx.savepoint is not a function')),
    );

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.COPILOT,
      }),
    ).rejects.toThrow('tx.savepoint is not a function');
    expect(reportCaughtErrorMock).not.toHaveBeenCalledWith(
      'checkout-attempt',
      expect.any(Error),
      expect.objectContaining({
        reason: 'checkout_coupon_decision_analytics_enqueue_failed',
      }),
    );
  });

  it('reusing an existing attempt takes no new coupon decision', async () => {
    setBetaCompCoupon(COUPON_ID);
    queueLocksAndRow(
      copilotAttempt({
        checkout_session_id: null,
        checkout_attempt_state: 'creating',
        primary_onboarded_by: ADMIN_ID,
      }),
    );
    queueBusinessMirrorSync(SubscriptionTier.COPILOT);

    await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.COPILOT,
    });

    expect(couponAnalyticsCall()).toBeUndefined();
    expect(loggerMock.log).not.toHaveBeenCalled();
  });

  describe('invariants', () => {
    it('snapshots a coupon iff the primary business is admin-onboarded AND the env var is set', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.option(fc.constant(ADMIN_ID), { nil: null }),
          fc.option(fc.string({ minLength: 1, maxLength: 24 }).map((s) => s.trim()), {
            nil: undefined,
          }),
          async (primaryOnboardedBy, configuredCoupon) => {
            harness.resetMockSql();
            setBetaCompCoupon(configuredCoupon);

            await selectCopilot({ primary_onboarded_by: primaryOnboardedBy });

            const invited = primaryOnboardedBy !== null;
            const comped = configuredCoupon !== undefined && configuredCoupon !== '';
            const snapshot = snapshottedCouponId();
            expect(snapshot !== null).toBe(invited && comped);
            if (invited && comped) expect(snapshot).toBe(configuredCoupon);
          },
        ),
        { numRuns: 40 },
      );
    });
  });
});

describe('primaryOnboardedBySql', () => {
  it('scopes the onboarded_by read to the account, its PRIMARY business, and un-archived rows', () => {
    primaryOnboardedBySql(mockSql, ACCOUNT_ID);

    // A fragment is LAZY: composing it must not execute. `sqlCalls` records
    // only awaited queries, so an empty log here IS the laziness assertion —
    // an eager fragment would burn a pooled connection at every call site.
    expect(harness.sqlCalls).toHaveLength(0);
    const [strings, ...values] = harness.mockSql.mock.calls[0]!;
    const text = (strings as TemplateStringsArray).join('?');

    // `onboarded_by` lives per-Business while both decisions that read it (the
    // Beta comp coupon and the self-serve trial) are per-Account, so "which
    // Business" is the whole question. All three predicates are load-bearing:
    // drop is_primary and the answer becomes "whichever row Postgres returns
    // first"; drop archived_at and a deleted location can still decide it.
    expect(text).toMatch(/FROM\s+businesses\s+pb/i);
    expect(text).toMatch(/pb\.account_id\s*=\s*\?::uuid/i);
    expect(text).toMatch(/pb\.is_primary\s*=\s*TRUE/i);
    expect(text).toMatch(/pb\.archived_at\s+IS\s+NULL/i);
    expect(text).toMatch(/LIMIT\s+1/i);
    expect(values).toEqual([ACCOUNT_ID]);
  });

  it('carries its own tenant predicate as a bound value, not an outer correlation', () => {
    primaryOnboardedBySql(mockSql, ACCOUNT_ID);
    const [strings] = harness.mockSql.mock.calls[0]!;
    const text = (strings as TemplateStringsArray).join('?');

    // Correlating to an outer alias (`pb.account_id = a.id`) would hide the
    // scope from every composed statement AND from the tenant-scope audit,
    // which reads raw template text per file.
    expect(text).not.toMatch(/pb\.account_id\s*=\s*[a-z]+\.id/i);
  });
});

describe('isTrialEligible', () => {
  // The truth table, exhaustively. Each of the four terms is the sole reason
  // for denial in at least one row, which is what makes deleting any one of
  // them fail here rather than in a route suite three modules away.
  for (const trial of [true, false]) {
    for (const selfServeSignup of [true, false]) {
      for (const subscriptionStatus of [
        SubscriptionStatus.PENDING_PAYMENT,
        // `cancelled` is not hypothetical: reactivation posts to
        // /api/billing/checkout, so without the status term a self-serve
        // account would earn a fresh $0 trial on every cancellation.
        SubscriptionStatus.CANCELLED,
      ]) {
        for (const primaryOnboardedBy of [null, 'admin-1']) {
          const expected =
            trial &&
            selfServeSignup &&
            subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT &&
            primaryOnboardedBy === null;
          it(`TRIAL_ENABLED=${trial} SELF_SERVE=${selfServeSignup} status=${subscriptionStatus} onboarded_by=${primaryOnboardedBy} → ${expected}`, () => {
            mockTrialEnabled.mockReturnValue(trial);
            vi.stubEnv('SELF_SERVE_SIGNUP_ENABLED', String(selfServeSignup));
            expect(
              isTrialEligible({ subscriptionStatus, primaryOnboardedBy }),
            ).toBe(expected);
          });
        }
      }
    }
  }
});

describe('resolveCheckoutContext', () => {
  /** Business lookup, then the account read the eligibility facts come from. */
  function queueContext(
    accountId: string | null,
    account: { subscription_status: string; primary_onboarded_by: string | null } | null,
  ): void {
    harness.sqlReturnQueue.push(
      mkTaggedResult(accountId ? [{ account_id: accountId }] : []),
    );
    if (account) harness.sqlReturnQueue.push(mkTaggedResult([account]));
  }

  it('returns null when the business row is missing', async () => {
    queueContext(null, null);
    expect(await resolveCheckoutContext(mockSql, BUSINESS_ID)).toBeNull();
    // Short-circuits: no account id means nothing to read the facts from.
    expect(harness.sqlCalls).toHaveLength(1);
  });

  it('returns null when the account row vanished between the two reads', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ account_id: ACCOUNT_ID }]),
      mkTaggedResult([]),
    );
    expect(await resolveCheckoutContext(mockSql, BUSINESS_ID)).toBeNull();
  });

  it('allows a configured trial only for a self-serve business', async () => {
    mockTrialEnabled.mockReturnValue(true);
    queueContext(ACCOUNT_ID, {
      subscription_status: SubscriptionStatus.PENDING_PAYMENT,
      primary_onboarded_by: null,
    });
    expect(await resolveCheckoutContext(mockSql, BUSINESS_ID)).toEqual({
      accountId: ACCOUNT_ID,
      trialEligible: true,
    });
  });

  it('denies a trial to admin-provisioned businesses', async () => {
    mockTrialEnabled.mockReturnValue(true);
    queueContext(ACCOUNT_ID, {
      subscription_status: SubscriptionStatus.PENDING_PAYMENT,
      primary_onboarded_by: 'admin-1',
    });
    expect(await resolveCheckoutContext(mockSql, BUSINESS_ID)).toEqual({
      accountId: ACCOUNT_ID,
      trialEligible: false,
    });
  });

  it('defers to the single owner rather than re-spelling the flag terms', async () => {
    // Same self-serve, pending row as the granting case above — only the
    // second flag differs. A copy of the predicate that carried just
    // TRIAL_ENABLED + onboarded_by (what this function spelled before #H2)
    // would answer `true` here and disagree with /api/billing/checkout.
    mockTrialEnabled.mockReturnValue(true);
    vi.stubEnv('SELF_SERVE_SIGNUP_ENABLED', 'false');
    queueContext(ACCOUNT_ID, {
      subscription_status: SubscriptionStatus.PENDING_PAYMENT,
      primary_onboarded_by: null,
    });
    expect(await resolveCheckoutContext(mockSql, BUSINESS_ID)).toEqual({
      accountId: ACCOUNT_ID,
      trialEligible: false,
    });
  });

  it('reads the PRIMARY business onboarded_by, not the business it was handed', async () => {
    // The latent bug this function carried: it read `onboarded_by` off the row
    // the caller passed. Correct today only because select-plan happens to pass
    // the primary and a pending_payment account cannot yet hold a second
    // location — a precondition enforced two modules away, failing OPEN (it
    // grants the trial) the moment either half changes.
    mockTrialEnabled.mockReturnValue(true);
    queueContext(ACCOUNT_ID, {
      subscription_status: SubscriptionStatus.PENDING_PAYMENT,
      primary_onboarded_by: 'admin-1',
    });

    const context = await resolveCheckoutContext(mockSql, SECONDARY_BUSINESS_ID);

    expect(context).toEqual({ accountId: ACCOUNT_ID, trialEligible: false });
    // The facts read keys on the ACCOUNT resolved from that business — never on
    // the business id — and is scoped to the primary through the shared fragment.
    const factsRead = harness.sqlCalls[1]!;
    expect(factsRead.values).toEqual([ACCOUNT_ID, ACCOUNT_ID]);
    expect(factsRead.values).not.toContain(SECONDARY_BUSINESS_ID);
    expect(factsRead.text).toMatch(/pb\.is_primary\s*=\s*TRUE/i);
    expect(factsRead.text).toMatch(/pb\.archived_at\s+IS\s+NULL/i);
  });
});

describe('releaseCouponFaultedAttempt', () => {
  it('clears every attempt column, scoped to the faulted creating lease', async () => {
    await releaseCouponFaultedAttempt(mockSql, ACCOUNT_ID, ATTEMPT_ID);

    const [call] = harness.sqlCalls;
    expect(call).toBeDefined();

    // Migration 105's CLEARED branch of accounts_checkout_attempt_complete_check
    // enumerates all nineteen columns, so a partial clear satisfies NEITHER
    // branch and the UPDATE is rejected outright. An attempt is
    // complete-or-cleared as a WHOLE — asserted column by column because the
    // failure mode of missing one is a runtime constraint violation, not a
    // build-time type error.
    for (const column of [
      'checkout_attempt_state',
      'checkout_attempt_id',
      'checkout_session_id',
      'checkout_attempt_tier',
      'checkout_attempt_price_variant',
      'checkout_attempt_base_price_id',
      'checkout_attempt_overage_price_id',
      'checkout_attempt_base_price_cents',
      'checkout_attempt_overage_price_cents',
      'checkout_attempt_locations_included',
      'checkout_attempt_locations_paid',
      'checkout_attempt_overage_quantity',
      'checkout_attempt_trial_period_days',
      'checkout_attempt_tax_enabled',
      'checkout_attempt_customer_email',
      'checkout_attempt_success_url',
      'checkout_attempt_cancel_url',
      'checkout_attempt_updated_at',
      'checkout_attempt_coupon_id',
    ]) {
      expect(call!.text).toContain(`${column} = NULL`);
    }

    // Narrowly scoped: only a `creating` lease, and only the attempt the caller
    // just failed on. An `open`/`completed` attempt has a live Stripe Session
    // behind it and must never be cleared from an error path; the attempt-id
    // predicate leaves a concurrent request that already replaced the lease
    // alone instead of yanking its attempt.
    expect(call!.text).toContain("checkout_attempt_state = 'creating'");
    expect(call!.values).toContain(ACCOUNT_ID);
    expect(call!.values).toContain(ATTEMPT_ID);
  });

  it('swallows a failure so it cannot mask the error the caller is returning', async () => {
    // The caller is already returning 502 for the coupon fault; a release
    // failure must not replace that with something less actionable.
    harness.sqlReturnQueue.push(Promise.reject(new Error('connection reset')));

    await expect(
      releaseCouponFaultedAttempt(mockSql, ACCOUNT_ID, ATTEMPT_ID),
    ).resolves.toBeUndefined();

    expect(reportCaughtErrorMock).toHaveBeenCalledWith(
      'plan-activation',
      expect.any(Error),
      expect.objectContaining({
        reason: 'coupon_faulted_attempt_release_failed',
      }),
    );
  });
});
