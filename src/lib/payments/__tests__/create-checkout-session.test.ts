import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

const createMock = vi.fn();

vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({ checkout: { sessions: { create: createMock } } }),
}));

// Partial mock: keep the real exports (notably STRIPE_PRICE_ENV_VARS, which
// config/server.ts imports to build its schema — now pulled in transitively via
// resetServerConfigForTests) and override only the two price-id resolvers.
vi.mock('@/lib/payments/price-tier-map', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/price-tier-map')>()),
  basePriceIdForTier: () => 'price_basic_123',
  overagePriceIdForTier: () => null,
}));

import { createCheckoutSession } from '../create-checkout-session';
import { resetServerConfigForTests } from '@/lib/config/server';

// createCheckoutSession is born-injected (sql is a leading parameter), so no
// @/lib/db/server module mocking is needed — the fragment-aware createMockSql
// harness (shared with worker suites) stands in for `sql` directly. Every
// test below exercises the tier='basic' branch, which never issues a query
// (VAL-BILLING-004: basic tier skips the locations-count lookup), so the
// harness's return queue is never populated — it exists only to satisfy the
// parameter contract.
let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  // The fragment-aware harness mocks the tagged-template + `.begin` shape of
  // Postgres.js's `Sql` without implementing its full type surface — cast,
  // same convention as src/lib/payments/__tests__/plan-activation.test.ts.
  mockSql = harness.mockSql as unknown as Sql;
});

describe('createCheckoutSession tax handling', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ url: 'https://checkout.stripe', id: 'cs_123' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('omits tax fields when STRIPE_TAX_ENABLED is off', async () => {
    vi.stubEnv('STRIPE_TAX_ENABLED', 'false');
    await createCheckoutSession(mockSql, 'acct_1', 'basic', 'owner@example.com');
    const params = createMock.mock.calls[0]![0];
    expect(params.automatic_tax).toBeUndefined();
    expect(params.billing_address_collection).toBeUndefined();
    expect(params.tax_id_collection).toBeUndefined();
  });

  it('adds tax + address + tax-id collection when STRIPE_TAX_ENABLED=true', async () => {
    vi.stubEnv('STRIPE_TAX_ENABLED', 'true');
    await createCheckoutSession(mockSql, 'acct_1', 'basic', 'owner@example.com');
    const params = createMock.mock.calls[0]![0];
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.billing_address_collection).toBe('required');
    expect(params.tax_id_collection).toEqual({ enabled: true });
  });
});

describe('createCheckoutSession trial handling', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ url: 'https://checkout.stripe', id: 'cs_123' });
    // resolveTrialPeriodDays() now reads TRIAL_PERIOD_DAYS via the memoized
    // getServerConfig(); clear the memo so each test's vi.stubEnv() value is
    // re-parsed at the next getServerConfig() call (Stage-3 convention #6). Every
    // assertion below is unchanged. Each test stubs env BEFORE the first config
    // read, so the reset here is sufficient (no per-stub reset needed).
    resetServerConfigForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('omits subscription_data when trial option is not set', async () => {
    await createCheckoutSession(mockSql, 'acct_1', 'basic', 'owner@example.com');
    const params = createMock.mock.calls[0]![0];
    expect(params.subscription_data).toBeUndefined();
  });

  it('adds subscription_data.trial_period_days = TRIAL_PERIOD_DAYS when trial=true', async () => {
    vi.stubEnv('TRIAL_PERIOD_DAYS', '30');
    await createCheckoutSession(mockSql, 'acct_1', 'basic', 'owner@example.com', { trial: true });
    const params = createMock.mock.calls[0]![0];
    expect(params.subscription_data).toEqual({ trial_period_days: 30 });
  });

  it('defaults trial_period_days to 30 when TRIAL_PERIOD_DAYS unset', async () => {
    vi.stubEnv('TRIAL_PERIOD_DAYS', '');
    await createCheckoutSession(mockSql, 'acct_1', 'basic', 'owner@example.com', { trial: true });
    const params = createMock.mock.calls[0]![0];
    expect(params.subscription_data).toEqual({ trial_period_days: 30 });
  });

  it('respects a custom TRIAL_PERIOD_DAYS', async () => {
    vi.stubEnv('TRIAL_PERIOD_DAYS', '14');
    await createCheckoutSession(mockSql, 'acct_1', 'basic', 'owner@example.com', { trial: true });
    const params = createMock.mock.calls[0]![0];
    expect(params.subscription_data).toEqual({ trial_period_days: 14 });
  });
});
