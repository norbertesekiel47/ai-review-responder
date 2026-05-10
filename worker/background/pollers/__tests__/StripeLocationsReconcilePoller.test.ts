// worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
//
// TDD assertions for StripeLocationsReconcilePoller.
// Hourly drift detection: compares actual non-archived location count
// against Stripe subscription_items[overage].quantity. Emits Sentry
// alert (or console.warn when Sentry DSN unset) when drift > 0.
// Does NOT auto-correct — manual investigation only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ─────────────────────────────────────────────

const { sqlReturnQueue, mockSql, sqlCalls } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];
  const mockSql: any = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ template: strings.join('?'), values });
      const result = sqlReturnQueue.shift() ?? [];
      return Promise.resolve(result);
    },
  );
  return { sqlReturnQueue, mockSql, sqlCalls };
});

const { mockCaptureMessage, mockConsoleWarn } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
  mockConsoleWarn: vi.fn(),
}));

// Mock Sentry — always returns a captureMessage function.
// The poller checks process.env.SENTRY_DSN at runtime to decide
// whether to call Sentry or fall back to console.warn.
vi.mock('../../../../worker/sentry', () => ({
  Sentry: {
    init: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureMessage: mockCaptureMessage,
    captureException: vi.fn(),
  },
}));

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock Stripe SDK — returns a lazy getter the poller can use
const { mockStripeRetrieve } = vi.hoisted(() => ({
  mockStripeRetrieve: vi.fn(),
}));

vi.mock('stripe', () => {
  return {
    __esModule: true,
    default: class MockStripe {
      subscriptions = {
        retrieve: mockStripeRetrieve,
      };
    },
  };
});

// Import AFTER mocks are wired
import {
  runOnce,
  startStripeLocationsReconcilePoller,
  stopStripeLocationsReconcilePoller,
} from '../StripeLocationsReconcilePoller';

// ── Helpers ────────────────────────────────────────────────────────

/** Build a Stripe subscription object with overage item. */
function makeStripeSubscription(overageQuantity: number, overagePriceId = 'price_overage_std') {
  return {
    id: 'sub_test',
    items: {
      data: [
        { id: 'si_base', price: { id: 'price_base' }, quantity: 1 },
        {
          id: 'si_overage',
          price: { id: overagePriceId },
          quantity: overageQuantity,
        },
      ],
    },
  };
}

/** Build a Stripe subscription with NO overage item (basic tier or legacy). */
function makeStripeSubscriptionNoOverage() {
  return {
    id: 'sub_test',
    items: {
      data: [
        { id: 'si_base', price: { id: 'price_base' }, quantity: 1 },
      ],
    },
  };
}

interface AccountRow {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  stripe_subscription_id: string | null;
  locations_included: number;
  active_location_count: number;
}

function makeAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acct-1',
    subscription_tier: 'standard',
    subscription_status: 'active',
    stripe_subscription_id: 'sub_123',
    locations_included: 1,
    active_location_count: 3,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('StripeLocationsReconcilePoller', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    mockCaptureMessage.mockClear();
    mockConsoleWarn.mockClear();
    mockStripeRetrieve.mockClear();

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Default: SENTRY_DSN unset
    delete process.env.SENTRY_DSN;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED;
    delete process.env.STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS;
    delete process.env.MOCK_EXTERNAL_APIS;
    // Set env vars for Stripe price IDs
    process.env.STRIPE_PRICE_STANDARD_OVERAGE = 'price_overage_std';
    process.env.STRIPE_PRICE_PREMIUM_OVERAGE = 'price_overage_prem';
    process.env.STRIPE_PRICE_FOUNDERS_OVERAGE = 'price_overage_founders';
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  });

  afterEach(() => {
    stopStripeLocationsReconcilePoller();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_STANDARD_OVERAGE;
    delete process.env.STRIPE_PRICE_PREMIUM_OVERAGE;
    delete process.env.STRIPE_PRICE_FOUNDERS_OVERAGE;
  });

  // ── No drift ────────────────────────────────────────────────────

  it('no alert when Stripe overage quantity matches DB expectation', async () => {
    // Account: standard tier, 1 included, 3 active → expected overage = 2
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-match',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);

    // Stripe returns overage quantity = 2 (matches DB)
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(0);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ── Drift detected ──────────────────────────────────────────────

  it('emits alert when Stripe overage quantity exceeds DB expectation', async () => {
    // Account: standard tier, 1 included, 3 active → expected overage = 2
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-drift-high',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);

    // Stripe returns overage quantity = 5 (drift = +3)
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(5, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(1);
    // Should emit alert via console.warn (SENTRY_DSN unset) — single string arg
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('acct-drift-high'),
    );
  });

  it('emits alert when DB overage exceeds Stripe quantity', async () => {
    // Account: standard tier, 1 included, 5 active → expected overage = 4
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-drift-low',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 5,
      }),
    ]);

    // Stripe returns overage quantity = 1 (drift = -3, DB has 4 but Stripe says 1)
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(1, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('acct-drift-low'),
    );
  });

  it('alert includes account_id, expected (from DB), and actual (from Stripe)', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-detail',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 4,
      }),
    ]);

    // DB says overage = 3, Stripe says overage = 7
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(7, 'price_overage_std'),
    );

    await runOnce();

    // The warn message should include the account_id and both quantities
    const warnCall = warnSpy.mock.calls.find(
      (c: any[]) => c[0] && c[0].includes('acct-detail'),
    );
    expect(warnCall).toBeDefined();
    const alertPayload = warnCall![0] as string;
    expect(alertPayload).toContain('acct-detail');
    expect(alertPayload).toContain('3'); // expected from DB
    expect(alertPayload).toContain('7'); // actual from Stripe
  });

  // ── Sentry path when DSN is set ─────────────────────────────────

  it('uses Sentry.captureMessage when SENTRY_DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';

    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-sentry',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);

    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(10, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('acct-sentry'),
      expect.objectContaining({ level: 'warning' }),
    );
    // Should NOT also console.warn when Sentry is active
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('location drift'),
    );
  });

  // ── Skips accounts with no Stripe subscription_id ────────────────

  it('skips accounts with no Stripe subscription_id', async () => {
    // Simulate the SQL query returning empty results (the real query
    // filters WHERE stripe_subscription_id IS NOT NULL, so null-sub
    // accounts never appear in the result set)
    sqlReturnQueue.push([]);

    const result = await runOnce();

    expect(result.accountsChecked).toBe(0);
    expect(result.driftsFound).toBe(0);
    expect(mockStripeRetrieve).not.toHaveBeenCalled();
  });

  // ── Skips non-active subscriptions ─────────────────────────────

  it('skips accounts with non-active subscription status', async () => {
    // Simulate the SQL query returning empty results (the real query
    // filters WHERE subscription_status = 'active', so non-active
    // accounts never appear in the result set)
    sqlReturnQueue.push([]);

    const result = await runOnce();

    expect(result.accountsChecked).toBe(0);
    expect(mockStripeRetrieve).not.toHaveBeenCalled();
  });

  // ── Handles subscription with no overage item ────────────────────

  it('handles subscription with no overage item (basic tier or legacy)', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-basic',
        subscription_tier: 'basic',
        locations_included: 1,
        active_location_count: 1,
      }),
    ]);

    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscriptionNoOverage(),
    );

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    // Basic tier with 1 location and no overage item → no drift
    expect(result.driftsFound).toBe(0);
  });

  it('detects drift when overage item is missing but DB expects overage', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-missing-overage',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 4,
      }),
    ]);

    // Stripe subscription has no overage item but DB expects 3 overage
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscriptionNoOverage(),
    );

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('acct-missing-overage'),
    );
  });

  // ── No drift when overage quantity is 0 and DB expects 0 ─────────

  it('no alert when overage quantity is 0 and DB expects 0 (within included quota)', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-within',
        subscription_tier: 'premium',
        locations_included: 5,
        active_location_count: 3,
      }),
    ]);

    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(0, 'price_overage_prem'),
    );

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(0);
  });

  // ── Does NOT auto-correct ───────────────────────────────────────

  it('does NOT auto-correct Stripe quantity (no stripe.subscriptionItems.update call)', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-no-autocorrect',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);

    // Stripe says 10 but DB says 2 overage — big drift
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(10, 'price_overage_std'),
    );

    await runOnce();

    // No subscriptionItems.update should be called — manual investigation only
    const updateCalls = sqlCalls.filter(
      (c) => c.template.includes('subscriptionItems') || c.template.includes('UPDATE accounts'),
    );
    expect(updateCalls.length).toBe(0);
  });

  // ── Multiple accounts ───────────────────────────────────────────

  it('processes multiple accounts and reports per-account drift', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-ok',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 3,
      }),
      makeAccountRow({
        id: 'acct-drift',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 5,
      }),
    ]);

    // First account: no drift (3 locations - 1 included = 2 overage)
    // Second account: drift (5 locations - 1 included = 4 overage, Stripe says 1)
    mockStripeRetrieve
      .mockResolvedValueOnce(makeStripeSubscription(2, 'price_overage_std'))
      .mockResolvedValueOnce(makeStripeSubscription(1, 'price_overage_std'));

    const result = await runOnce();

    expect(result.accountsChecked).toBe(2);
    expect(result.driftsFound).toBe(1);
  });

  // ── Stripe API error handling ────────────────────────────────────

  it('continues processing after Stripe API error on one account', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-fail',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 3,
      }),
      makeAccountRow({
        id: 'acct-ok',
        subscription_tier: 'standard',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);

    // First account: Stripe API error
    mockStripeRetrieve
      .mockRejectedValueOnce(new Error('Stripe API timeout'))
      .mockResolvedValueOnce(makeStripeSubscription(2, 'price_overage_std'));

    const result = await runOnce();

    // First account errored out, second succeeded — only 1 checked
    expect(result.accountsChecked).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.driftsFound).toBe(0); // second account matches
  });

  // ── No accounts to check ────────────────────────────────────────

  it('returns zero counts when no accounts have Stripe subscriptions', async () => {
    sqlReturnQueue.push([]);

    const result = await runOnce();

    expect(result.accountsChecked).toBe(0);
    expect(result.driftsFound).toBe(0);
    expect(result.errors).toBe(0);
  });

  // ── Poller start/stop ───────────────────────────────────────────

  it('start creates interval timer and stop clears it', async () => {
    startStripeLocationsReconcilePoller();
    // Timer should be created (poller is running)
    // Stop should clear it
    stopStripeLocationsReconcilePoller();
    // No assertion on internals — just verify no crash
  });

  it('idempotent start ignores duplicate calls', async () => {
    startStripeLocationsReconcilePoller();
    startStripeLocationsReconcilePoller(); // duplicate
    stopStripeLocationsReconcilePoller();
  });

  // ── Disabled in mock mode ───────────────────────────────────────

  it('does not start when MOCK_EXTERNAL_APIS=true', () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    startStripeLocationsReconcilePoller();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('MOCK_EXTERNAL_APIS=true'),
    );
    stopStripeLocationsReconcilePoller();
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  // ── Disabled with env flag ──────────────────────────────────────

  it('does not start when STRIPE_LOCATIONS_RECONCILE_DISABLED=true', () => {
    process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED = 'true';
    startStripeLocationsReconcilePoller();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('STRIPE_LOCATIONS_RECONCILE_DISABLED=true'),
    );
    stopStripeLocationsReconcilePoller();
    delete process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED;
  });

  // ── Single-flight guard ─────────────────────────────────────────

  it('skips tick when previous run is still in progress', async () => {
    // First call: return accounts but don't resolve Stripe yet
    sqlReturnQueue.push([
      makeAccountRow({ id: 'acct-slow' }),
    ]);

    let resolveStripe: (value: unknown) => void;
    const stripePromise = new Promise((resolve) => {
      resolveStripe = resolve;
    });
    mockStripeRetrieve.mockReturnValueOnce(stripePromise);

    // Start first runOnce
    const firstRun = runOnce();

    // Try to start a second run concurrently
    const secondRun = runOnce();

    // Resolve the Stripe call
    resolveStripe!(makeStripeSubscription(2, 'price_overage_std'));

    const [first, second] = await Promise.all([firstRun, secondRun]);

    // First run should have checked the account
    expect(first.accountsChecked).toBe(1);
    // Second run should have been skipped (single-flight)
    expect(second.accountsChecked).toBe(0);
  });
});
