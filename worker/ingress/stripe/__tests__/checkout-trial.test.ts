import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../__tests__/helpers/mock-sql';

const {
  mockApplyStripeSubscriptionState,
  mockWriteResolvedTierSnapshot,
  mockSynchronizeBusinessTierMirror,
  mockResumePrimaryBusinessBackfill,
  mockRetrieveSession,
  mockRetrieveSubscription,
  mockCancelSubscription,
  mockReportCaughtError,
  mockAutopilotPurchasable,
} = vi.hoisted(() => ({
  mockApplyStripeSubscriptionState: vi.fn(),
  mockWriteResolvedTierSnapshot: vi.fn(),
  mockSynchronizeBusinessTierMirror: vi.fn(),
  mockResumePrimaryBusinessBackfill: vi.fn(),
  mockRetrieveSession: vi.fn(),
  mockRetrieveSubscription: vi.fn(),
  mockCancelSubscription: vi.fn(),
  mockReportCaughtError: vi.fn(),
  mockAutopilotPurchasable: vi.fn(),
}));

let harness: MockSqlHarness;

vi.mock('../../../../src/lib/db/server', () => ({
  get sql() {
    return harness.mockSql;
  },
  jsonb: (value: unknown) => value,
}));
vi.mock('../apply-subscription-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apply-subscription-state')>()),
  applyStripeSubscriptionStateUnderEntitlementLock:
    mockApplyStripeSubscriptionState,
}));
vi.mock('../../../../src/lib/accounts/tier-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/accounts/tier-snapshot')>()),
  writeResolvedTierSnapshot: mockWriteResolvedTierSnapshot,
  synchronizeBusinessTierMirror: mockSynchronizeBusinessTierMirror,
}));
vi.mock('../shared', async () => {
  const actual = await vi.importActual<typeof import('../shared')>('../shared');
  return {
    ...actual,
    resumePrimaryBusinessBackfill: mockResumePrimaryBusinessBackfill,
    getStripe: () => ({
      checkout: { sessions: { retrieve: mockRetrieveSession } },
      subscriptions: {
        retrieve: mockRetrieveSubscription,
        cancel: mockCancelSubscription,
      },
    }),
  };
});
vi.mock('../../../../src/lib/shared/report-caught-error', () => ({
  reportCaughtError: mockReportCaughtError,
}));
vi.mock('../../../../src/lib/payments/tier-purchasability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/payments/tier-purchasability')>()),
  autopilotPurchasable: mockAutopilotPurchasable,
}));

import { processCheckoutSessionCompleted } from '../checkout-completed';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const PRIMARY_BIZ = '019dc366-29ce-7000-a000-0000000000bb';
const CUSTOMER_ID = 'cus_test_123';
const ATTEMPT_ID = '019dc366-29ce-7000-a000-0000000000cc';
const SESSION_ID = 'cs_trial';
const SUB_ID = 'sub_test_456';
const TRIAL_START = Math.floor(Date.now() / 1000);
const FUTURE_TRIAL_END = TRIAL_START + 30 * 86400;

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    subscription_tier: 'copilot',
    subscription_status: 'pending_payment',
    price_variant: 'list',
    base_price_cents: 2900,
    locations_paid: 0,
    locations_overage_price_cents: 1500,
    locations_included: 1,
    stripe_subscription_id: null,
    stripe_customer_id: null,
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
    checkout_attempt_overage_quantity: 0,
    checkout_attempt_trial_period_days: null,
    checkout_attempt_tax_enabled: false,
    checkout_attempt_customer_email: 'owner@example.com',
    checkout_attempt_success_url:
      'https://app.example.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}',
    checkout_attempt_cancel_url:
      'https://app.example.com/onboarding/pay?cancelled=true',
    ...overrides,
  };
}

function activeDeleteDataOffboarding() {
  return {
    offboarding_id: '019dc366-29ce-7000-a000-0000000000dd',
    offboarding_account_id: ACCOUNT_ID,
    offboarding_mode: 'delete_data',
    offboarding_status: 'pending',
    offboarding_failed_step: null,
    offboarding_access_ends_at: null,
    offboarding_teardown_started_at: null,
    offboarding_purge_after: null,
    offboarding_purge_started_at: null,
    offboarding_purge_cancelled_at: null,
  };
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    client_reference_id: ACCOUNT_ID,
    customer: CUSTOMER_ID,
    subscription: SUB_ID,
    metadata: { checkout_attempt_id: ATTEMPT_ID },
    allow_promotion_codes: false,
    automatic_tax: { enabled: false },
    billing_address_collection: null,
    tax_id_collection: { enabled: false },
    customer_email: 'owner@example.com',
    success_url:
      'https://app.example.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://app.example.com/onboarding/pay?cancelled=true',
    line_items: {
      data: [{ quantity: 1, price: { id: 'price_copilot_list' } }],
    },
    ...overrides,
  };
}

function providerSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB_ID,
    customer: CUSTOMER_ID,
    status: 'active',
    trial_start: null,
    trial_end: null,
    metadata: { checkout_attempt_id: ATTEMPT_ID },
    items: {
      data: [{ quantity: 1, price: { id: 'price_copilot_list' } }],
    },
    ...overrides,
  };
}

function eventSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    mode: 'subscription',
    payment_status: 'paid',
    client_reference_id: ACCOUNT_ID,
    customer: CUSTOMER_ID,
    subscription: SUB_ID,
    metadata: { checkout_attempt_id: ATTEMPT_ID },
    ...overrides,
  };
}

function transition(overrides: Record<string, unknown> = {}) {
  return {
    accountResolved: true,
    fromStatus: 'pending_payment',
    toStatus: 'active',
    changed: true,
    activated: true,
    primaryBusinessId: PRIMARY_BIZ,
    ...overrides,
  };
}

function queueThroughObserved(observed: ReturnType<typeof account> | null): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{ id: ACCOUNT_ID }]),
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult(observed ? [observed] : []),
  );
}

function queueValidProjection(
  observed = account(),
  locked = observed,
): void {
  queueThroughObserved(observed);
  harness.sqlReturnQueue.push(
    mkTaggedResult([{ id: ACCOUNT_ID }]),
    mkTaggedResult([locked]),
    mkTaggedResult([{ id: ACCOUNT_ID }]),
  );
}

beforeEach(() => {
  harness = createMockSql();
  mockApplyStripeSubscriptionState.mockReset();
  mockApplyStripeSubscriptionState.mockResolvedValue(transition());
  mockWriteResolvedTierSnapshot.mockReset();
  mockWriteResolvedTierSnapshot.mockResolvedValue({ changed: true });
  mockSynchronizeBusinessTierMirror.mockReset();
  mockSynchronizeBusinessTierMirror.mockResolvedValue(undefined);
  mockResumePrimaryBusinessBackfill.mockReset();
  mockResumePrimaryBusinessBackfill.mockResolvedValue(undefined);
  mockRetrieveSession.mockReset();
  mockRetrieveSession.mockResolvedValue(checkoutSession());
  mockRetrieveSubscription.mockReset();
  mockRetrieveSubscription.mockResolvedValue(providerSubscription());
  mockCancelSubscription.mockReset();
  mockCancelSubscription.mockResolvedValue({ id: SUB_ID, status: 'canceled' });
  mockReportCaughtError.mockReset();
  mockAutopilotPurchasable.mockReset();
  mockAutopilotPurchasable.mockReturnValue(true);
});

afterEach(() => {
  expect(
    harness.sqlReturnQueue,
    'every queued SQL result must be consumed by the branch under test',
  ).toHaveLength(0);
});

describe('checkout.session.completed authoritative lease projection', () => {
  it('compares provider Session, subscription, lease, and account before applying status', async () => {
    queueValidProjection();

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockRetrieveSession).toHaveBeenCalledWith(SESSION_ID, {
      expand: ['line_items'],
    });
    expect(mockRetrieveSubscription).toHaveBeenCalledWith(SUB_ID);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { mode: 'checkout', accountId: ACCOUNT_ID },
      expect.objectContaining({ id: SUB_ID, status: 'active' }),
    );
    expect(mockWriteResolvedTierSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        snapshot: {
          tier: 'copilot',
          variant: 'list',
          baseCents: 2900,
          overageCents: 1500,
          included: 1,
        },
        locationsPaid: 0,
      }),
    );
    const calls = harness.sqlCalls;
    expect(calls.slice(1, 4).map((call) => call.values[0])).toEqual([
      `${ACCOUNT_ID}:tier_entitlement`,
      `${ACCOUNT_ID}:overage_sync`,
      `${ACCOUNT_ID}:activation`,
    ]);
    for (const frozenField of [
      'checkout_attempt_tax_enabled',
      'checkout_attempt_customer_email',
      'checkout_attempt_success_url',
      'checkout_attempt_cancel_url',
    ]) {
      expect(calls[4]!.text).toContain(frozenField);
      expect(calls[6]!.text).toContain(frozenField);
    }
    expect(calls[5]!.text).toContain('FOR UPDATE');
    expect(calls[6]!.text).not.toContain('FOR UPDATE');
    expect(calls[7]!.text).toMatch(/checkout_attempt_state\s*=\s*'completed'/);
    expect(mockCancelSubscription).not.toHaveBeenCalled();
    expect(mockSynchronizeBusinessTierMirror).toHaveBeenCalledWith(
      harness.mockSql,
      ACCOUNT_ID,
    );
    expect(mockResumePrimaryBusinessBackfill).toHaveBeenCalledWith(PRIMARY_BIZ);
    expect(calls).toHaveLength(8);
  });

  it('projects a valid future card-up-front trial through the single status applier', async () => {
    const trialAccount = account({ checkout_attempt_trial_period_days: 30 });
    queueValidProjection(trialAccount);
    mockRetrieveSession.mockResolvedValueOnce(
      checkoutSession({ payment_status: 'no_payment_required' }),
    );
    mockRetrieveSubscription.mockResolvedValueOnce(
      providerSubscription({
        status: 'trialing',
        trial_start: TRIAL_START,
        trial_end: FUTURE_TRIAL_END,
      }),
    );

    await processCheckoutSessionCompleted(
      eventSession({ payment_status: 'no_payment_required' }) as never,
    );

    expect(mockApplyStripeSubscriptionState.mock.calls[0]![3]).toMatchObject({
      status: 'trialing',
      trial_end: FUTURE_TRIAL_END,
    });
  });

  it('projects when the provider-current Stripe Tax shape matches the frozen lease', async () => {
    const taxAccount = account({ checkout_attempt_tax_enabled: true });
    queueValidProjection(taxAccount);
    mockRetrieveSession.mockResolvedValueOnce(
      checkoutSession({
        automatic_tax: { enabled: true },
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
      }),
    );

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(mockWriteResolvedTierSnapshot).toHaveBeenCalledTimes(1);
    expect(mockCancelSubscription).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'explicit disabled values',
      provider: checkoutSession({
        allow_promotion_codes: false,
        billing_address_collection: null,
        tax_id_collection: { enabled: false },
      }),
    },
    {
      label: 'provider default serialization',
      provider: checkoutSession({
        allow_promotion_codes: null,
        billing_address_collection: 'auto',
        tax_id_collection: null,
      }),
    },
  ])('accepts tax-disabled $label', async ({ provider }) => {
    queueValidProjection(account());
    mockRetrieveSession.mockResolvedValueOnce(provider);

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(mockWriteResolvedTierSnapshot).toHaveBeenCalledTimes(1);
    expect(mockCancelSubscription).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: 'tax shape',
      lease: account({ checkout_attempt_tax_enabled: true }),
      provider: checkoutSession(),
    },
    {
      field: 'customer email',
      lease: account(),
      provider: checkoutSession({ customer_email: 'other-owner@example.com' }),
    },
    {
      field: 'success URL',
      lease: account(),
      provider: checkoutSession({ success_url: 'https://attacker.example/success' }),
    },
    {
      field: 'cancel URL',
      lease: account(),
      provider: checkoutSession({ cancel_url: 'https://attacker.example/cancel' }),
    },
    {
      field: 'promotion-code policy',
      lease: account(),
      provider: checkoutSession({ allow_promotion_codes: true }),
    },
    {
      field: 'tax billing-address collection',
      lease: account({ checkout_attempt_tax_enabled: true }),
      provider: checkoutSession({
        automatic_tax: { enabled: true },
        billing_address_collection: 'auto',
        tax_id_collection: { enabled: true },
      }),
    },
    {
      field: 'tax-ID collection',
      lease: account({ checkout_attempt_tax_enabled: true }),
      provider: checkoutSession({
        automatic_tax: { enabled: true },
        billing_address_collection: 'required',
        tax_id_collection: { enabled: false },
      }),
    },
    {
      field: 'automatic-tax liability',
      lease: account({ checkout_attempt_tax_enabled: true }),
      provider: checkoutSession({
        automatic_tax: {
          enabled: true,
          liability: { type: 'account', account: 'acct_connected' },
        },
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
      }),
    },
    {
      field: 'required tax-ID policy',
      lease: account({ checkout_attempt_tax_enabled: true }),
      provider: checkoutSession({
        automatic_tax: { enabled: true },
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true, required: 'if_supported' },
      }),
    },
  ])(
    'cancels before status or snapshot when provider-current $field differs from the frozen lease',
    async ({ lease, provider }) => {
      queueThroughObserved(lease);
      harness.sqlReturnQueue.push(mkTaggedResult([{}]));
      mockRetrieveSession.mockResolvedValueOnce(provider);

      await processCheckoutSessionCompleted(eventSession() as never);

      expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
      expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
      expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
      expect(mockReportCaughtError).toHaveBeenCalledWith(
        'ingress/stripe/checkout-completed',
        expect.any(Error),
        expect.objectContaining({ reason: 'checkout_create_shape_mismatch' }),
      );
      expect(harness.sqlCalls.at(-1)!.text).toMatch(
        /checkout_attempt_state\s*=\s*'remediated'/,
      );
      expect(harness.sqlCalls).toHaveLength(6);
    },
  );

  it('cancels an active subscription that violates a frozen 30-day trial lease', async () => {
    const trialAccount = account({ checkout_attempt_trial_period_days: 30 });
    queueThroughObserved(trialAccount);
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'invalid_trial' }),
    );
  });

  it('cancels an unexpected provider trial for a no-trial lease', async () => {
    queueThroughObserved(account());
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    mockRetrieveSession.mockResolvedValueOnce(
      checkoutSession({ payment_status: 'no_payment_required' }),
    );
    mockRetrieveSubscription.mockResolvedValueOnce(
      providerSubscription({
        status: 'trialing',
        trial_start: TRIAL_START,
        trial_end: FUTURE_TRIAL_END,
      }),
    );

    await processCheckoutSessionCompleted(
      eventSession({ payment_status: 'no_payment_required' }) as never,
    );

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'invalid_trial' }),
    );
  });

  it('cancels a trial whose provider interval is not the frozen 30 days', async () => {
    const trialAccount = account({ checkout_attempt_trial_period_days: 30 });
    queueThroughObserved(trialAccount);
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    mockRetrieveSession.mockResolvedValueOnce(
      checkoutSession({ payment_status: 'no_payment_required' }),
    );
    mockRetrieveSubscription.mockResolvedValueOnce(
      providerSubscription({
        status: 'trialing',
        trial_start: TRIAL_START,
        trial_end: TRIAL_START + 29 * 86400,
      }),
    );

    await processCheckoutSessionCompleted(
      eventSession({ payment_status: 'no_payment_required' }) as never,
    );

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'invalid_trial' }),
    );
  });

  it.each([null, 'sub_stale_event'])(
    'uses the provider-current subscription when the event carries %s',
    async (eventSubscription) => {
      queueValidProjection();

      await processCheckoutSessionCompleted(
        eventSession({ subscription: eventSubscription }) as never,
      );

      expect(mockRetrieveSubscription).toHaveBeenCalledWith(SUB_ID);
      expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
      expect(mockCancelSubscription).not.toHaveBeenCalled();
      expect(mockWriteResolvedTierSnapshot).toHaveBeenCalledTimes(1);
    },
  );

  it('retries when the provider-current completed Session has no subscription identity', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: ACCOUNT_ID }]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );
    mockRetrieveSession.mockResolvedValueOnce(
      checkoutSession({ subscription: null }),
    );

    await expect(
      processCheckoutSessionCompleted(
        eventSession({ subscription: null }) as never,
      ),
    ).rejects.toThrow('has no subscription identity');

    expect(mockRetrieveSubscription).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockCancelSubscription).not.toHaveBeenCalled();
    expect(mockReportCaughtError).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(4);
  });

  it.each(['active', 'past_due', 'cancelled'])(
    'never activates a matching open lease when canonical status is %s',
    async (subscriptionStatus) => {
      const observed = account({ subscription_status: subscriptionStatus });
      queueThroughObserved(observed);
      harness.sqlReturnQueue.push(mkTaggedResult([{}]));

      await processCheckoutSessionCompleted(eventSession() as never);

      expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
      expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
      expect(
        harness.sqlCalls.some((call) =>
          /checkout_attempt_state\s*=\s*'completed'/.test(call.text),
        ),
      ).toBe(false);
      expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
      expect(harness.sqlCalls.at(-1)!.text).toMatch(
        /checkout_attempt_state\s*=\s*'remediated'/,
      );
      expect(mockReportCaughtError).toHaveBeenCalledWith(
        'ingress/stripe/checkout-completed',
        expect.any(Error),
        expect.objectContaining({ reason: 'checkout_account_status_mismatch' }),
      );
    },
  );

  it.each(['incomplete', 'past_due', 'paused', 'unpaid'])(
    'cancels provider status %s before status/snapshot and makes the lease reselectable',
    async (providerStatus) => {
      queueThroughObserved(account());
      harness.sqlReturnQueue.push(mkTaggedResult([{}]));
      mockRetrieveSubscription.mockResolvedValueOnce(
        providerSubscription({ status: providerStatus }),
      );

      await processCheckoutSessionCompleted(eventSession() as never);

      expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
      expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
      expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
      expect(harness.sqlCalls.at(-1)!.text).toMatch(
        /checkout_attempt_state\s*=\s*'remediated'/,
      );
      expect(mockReportCaughtError).toHaveBeenCalledWith(
        'ingress/stripe/checkout-completed',
        expect.any(Error),
        expect.objectContaining({
          reason: 'checkout_subscription_not_entitled',
        }),
      );
      expect(harness.sqlCalls).toHaveLength(6);
    },
  );

  it.each([
    { changed: false, activated: false },
    { changed: true, activated: false },
  ])(
    'rolls back a non-binding status result $changed/$activated before remediation',
    async (statusResult) => {
      queueThroughObserved(account());
      harness.sqlReturnQueue.push(
        mkTaggedResult([{ id: ACCOUNT_ID }]),
        mkTaggedResult([account()]),
        mkTaggedResult([{}]),
        mkTaggedResult([{}]),
        mkTaggedResult([{}]),
        mkTaggedResult([{}]),
      );
      mockApplyStripeSubscriptionState.mockResolvedValueOnce(
        transition(statusResult),
      );

      await processCheckoutSessionCompleted(eventSession() as never);

      expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
      expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
      expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
      expect(harness.sqlCalls.at(-1)!.text).toMatch(
        /checkout_attempt_state\s*=\s*'remediated'/,
      );
      expect(mockReportCaughtError).toHaveBeenCalledWith(
        'ingress/stripe/checkout-completed',
        expect.any(Error),
        expect.objectContaining({ reason: 'checkout_status_binding_failed' }),
      );
      expect(harness.sqlCalls).toHaveLength(11);
    },
  );

  it('cancels a stale old Session subscription after a newer plan selection without mutating the newer lease', async () => {
    queueThroughObserved(
      account({
        checkout_attempt_id: '019dc366-29ce-7000-a000-0000000000dd',
        checkout_session_id: 'cs_new',
        checkout_attempt_tier: 'autopilot',
      }),
    );

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledWith(
      SUB_ID,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `checkout-attempt-remediate:v1:${SUB_ID}` },
    );
    expect(
      harness.sqlCalls.some((call) =>
        /checkout_attempt_state\s*=\s*'remediated'/.test(call.text),
      ),
    ).toBe(false);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'stale_checkout_attempt' }),
    );
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('rejects a line-item mutation before status and remediates only the current bad lease', async () => {
    queueThroughObserved(account());
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    mockRetrieveSession.mockResolvedValueOnce(
      checkoutSession({
        line_items: {
          data: [{ quantity: 1, price: { id: 'price_autopilot_list' } }],
        },
      }),
    );

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
    expect(harness.sqlCalls.at(-1)!.text).toMatch(
      /checkout_attempt_state\s*=\s*'remediated'/,
    );
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'checkout_line_items_mismatch' }),
    );
  });

  it('keeps a completed identity as a no-op after a legitimate later tier and quantity change', async () => {
    queueThroughObserved(
      account({
        subscription_tier: 'autopilot',
        subscription_status: 'active',
        base_price_cents: 6900,
        locations_overage_price_cents: 2000,
        locations_paid: 4,
        stripe_subscription_id: SUB_ID,
        stripe_customer_id: CUSTOMER_ID,
        checkout_attempt_state: 'completed',
        checkout_attempt_locations_paid: 0,
      }),
    );
    mockRetrieveSubscription.mockResolvedValueOnce(
      providerSubscription({
        items: {
          data: [
            { quantity: 1, price: { id: 'price_autopilot_list' } },
            { quantity: 4, price: { id: 'price_autopilot_overage' } },
          ],
        },
      }),
    );

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockCancelSubscription).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockSynchronizeBusinessTierMirror).toHaveBeenCalledWith(
      harness.mockSql,
      ACCOUNT_ID,
    );
    expect(mockReportCaughtError).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('remediates a post-lock lost lease only after the row-lock transaction releases', async () => {
    const rowLockState = { held: false };
    queueThroughObserved(account());
    harness.sqlReturnQueue.push(
      Promise.resolve(
        mkTaggedResult([{ id: ACCOUNT_ID }]),
      ).then((rows) => {
        rowLockState.held = true;
        return rows;
      }),
      mkTaggedResult([
        account({
          checkout_attempt_id: '019dc366-29ce-7000-a000-0000000000ee',
          checkout_session_id: 'cs_new',
        }),
      ]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );
    const normalBegin = harness.mockSql.begin.getMockImplementation()!;
    harness.mockSql.begin.mockImplementation(async (...args: unknown[]) => {
      try {
        return await normalBegin(...(args as Parameters<typeof normalBegin>));
      } finally {
        rowLockState.held = false;
      }
    });
    mockCancelSubscription.mockImplementationOnce(async () => {
      expect(rowLockState.held).toBe(false);
      return { id: SUB_ID, status: 'canceled' };
    });

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'stale_checkout_attempt' }),
    );
    expect(harness.sqlCalls.at(-1)!.text).toMatch(
      /checkout_attempt_state\s*=\s*'remediated'/,
    );
    expect(harness.sqlCalls).toHaveLength(11);
  });

  it('rechecks the complete frozen create shape after acquiring the account row lock', async () => {
    queueThroughObserved(account());
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: ACCOUNT_ID }]),
      mkTaggedResult([
        account({ checkout_attempt_customer_email: 'changed@example.com' }),
      ]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'checkout_create_shape_mismatch' }),
    );
    expect(harness.sqlCalls.at(-1)!.text).toMatch(
      /checkout_attempt_state\s*=\s*'remediated'/,
    );
    expect(harness.sqlCalls).toHaveLength(11);
  });

  it('cancels and remediates when delete-data offboarding wins the account lock', async () => {
    queueThroughObserved(account());
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: ACCOUNT_ID }]),
      mkTaggedResult([account(activeDeleteDataOffboarding())]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockCancelSubscription).toHaveBeenCalledWith(
      SUB_ID,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `checkout-attempt-remediate:v1:${SUB_ID}` },
    );
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(harness.sqlCalls.at(-1)!.text).toMatch(
      /checkout_attempt_state\s*=\s*'remediated'/,
    );
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'checkout_blocked_by_offboarding' }),
    );
    expect(harness.sqlCalls).toHaveLength(11);
  });

  it('retrieves and cancels a completed subscription after its account was purged', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([]),
      mkTaggedResult([]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([]),
    );

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockRetrieveSession).toHaveBeenCalledWith(SESSION_ID, {
      expand: ['line_items'],
    });
    expect(mockRetrieveSubscription).toHaveBeenCalledWith(SUB_ID);
    expect(mockCancelSubscription).toHaveBeenCalledWith(
      SUB_ID,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `checkout-attempt-remediate:v1:${SUB_ID}` },
    );
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'account_missing' }),
    );
    expect(harness.sqlCalls).toHaveLength(6);
  });

  it('requires subscription attempt metadata before status projection', async () => {
    queueThroughObserved(account());
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    mockRetrieveSubscription.mockResolvedValueOnce(
      providerSubscription({ metadata: {} }),
    );

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'checkout_session_mismatch' }),
    );
  });

  it('provider retrieval failure writes nothing and remains retryable', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: ACCOUNT_ID }]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );
    mockRetrieveSession.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(
      processCheckoutSessionCompleted(eventSession() as never),
    ).rejects.toThrow('provider unavailable');

    expect(mockRetrieveSubscription).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockWriteResolvedTierSnapshot).not.toHaveBeenCalled();
    expect(mockCancelSubscription).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(4);
  });

  it('projects late Autopilot completion but emits the locked gate-closed alert', async () => {
    const autopilot = account({
      subscription_tier: 'autopilot',
      base_price_cents: 6900,
      locations_overage_price_cents: 2000,
      checkout_attempt_tier: 'autopilot',
      checkout_attempt_base_price_id: 'price_autopilot_list',
      checkout_attempt_overage_price_id: 'price_autopilot_overage',
      checkout_attempt_base_price_cents: 6900,
      checkout_attempt_overage_price_cents: 2000,
    });
    queueValidProjection(autopilot);
    mockRetrieveSession.mockResolvedValueOnce(
      checkoutSession({
        line_items: {
          data: [{ quantity: 1, price: { id: 'price_autopilot_list' } }],
        },
      }),
    );
    mockRetrieveSubscription.mockResolvedValueOnce(
      providerSubscription({
        items: {
          data: [{ quantity: 1, price: { id: 'price_autopilot_list' } }],
        },
      }),
    );
    mockAutopilotPurchasable.mockReturnValue(false);

    await processCheckoutSessionCompleted(eventSession() as never);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      {
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        subscriptionId: SUB_ID,
        reason: 'autopilot_activated_while_unavailable',
        priceId: 'price_autopilot_list',
      },
    );
  });

  it('emits the gate-closed Autopilot alert before a retryable mirror failure', async () => {
    const autopilot = account({
      subscription_tier: 'autopilot',
      base_price_cents: 6900,
      locations_overage_price_cents: 2000,
      checkout_attempt_tier: 'autopilot',
      checkout_attempt_base_price_id: 'price_autopilot_list',
      checkout_attempt_overage_price_id: 'price_autopilot_overage',
      checkout_attempt_base_price_cents: 6900,
      checkout_attempt_overage_price_cents: 2000,
    });
    queueValidProjection(autopilot);
    mockRetrieveSession.mockResolvedValueOnce(
      checkoutSession({
        line_items: {
          data: [{ quantity: 1, price: { id: 'price_autopilot_list' } }],
        },
      }),
    );
    mockRetrieveSubscription.mockResolvedValueOnce(
      providerSubscription({
        items: {
          data: [{ quantity: 1, price: { id: 'price_autopilot_list' } }],
        },
      }),
    );
    mockAutopilotPurchasable.mockReturnValue(false);
    mockSynchronizeBusinessTierMirror.mockRejectedValueOnce(
      new Error('deprecated mirror unavailable'),
    );

    await expect(
      processCheckoutSessionCompleted(eventSession() as never),
    ).rejects.toThrow('deprecated mirror unavailable');

    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({
        reason: 'autopilot_activated_while_unavailable',
      }),
    );
  });
});
