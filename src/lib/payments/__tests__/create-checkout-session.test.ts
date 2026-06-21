import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.fn();

vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({ checkout: { sessions: { create: createMock } } }),
}));

vi.mock('@/lib/payments/price-tier-map', () => ({
  basePriceIdForTier: () => 'price_basic_123',
  overagePriceIdForTier: () => null,
}));

import { createCheckoutSession } from '../create-checkout-session';

describe('createCheckoutSession tax handling', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ url: 'https://checkout.stripe', id: 'cs_123' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('omits tax fields when STRIPE_TAX_ENABLED is off', async () => {
    vi.stubEnv('STRIPE_TAX_ENABLED', 'false');
    await createCheckoutSession('acct_1', 'basic', 'owner@example.com');
    const params = createMock.mock.calls[0]![0];
    expect(params.automatic_tax).toBeUndefined();
    expect(params.billing_address_collection).toBeUndefined();
    expect(params.tax_id_collection).toBeUndefined();
  });

  it('adds tax + address + tax-id collection when STRIPE_TAX_ENABLED=true', async () => {
    vi.stubEnv('STRIPE_TAX_ENABLED', 'true');
    await createCheckoutSession('acct_1', 'basic', 'owner@example.com');
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
  });
  afterEach(() => vi.unstubAllEnvs());

  it('omits subscription_data when trial option is not set', async () => {
    await createCheckoutSession('acct_1', 'basic', 'owner@example.com');
    const params = createMock.mock.calls[0]![0];
    expect(params.subscription_data).toBeUndefined();
  });

  it('adds subscription_data.trial_period_days = TRIAL_PERIOD_DAYS when trial=true', async () => {
    vi.stubEnv('TRIAL_PERIOD_DAYS', '30');
    await createCheckoutSession('acct_1', 'basic', 'owner@example.com', { trial: true });
    const params = createMock.mock.calls[0]![0];
    expect(params.subscription_data).toEqual({ trial_period_days: 30 });
  });

  it('defaults trial_period_days to 30 when TRIAL_PERIOD_DAYS unset', async () => {
    vi.stubEnv('TRIAL_PERIOD_DAYS', '');
    await createCheckoutSession('acct_1', 'basic', 'owner@example.com', { trial: true });
    const params = createMock.mock.calls[0]![0];
    expect(params.subscription_data).toEqual({ trial_period_days: 30 });
  });

  it('respects a custom TRIAL_PERIOD_DAYS', async () => {
    vi.stubEnv('TRIAL_PERIOD_DAYS', '14');
    await createCheckoutSession('acct_1', 'basic', 'owner@example.com', { trial: true });
    const params = createMock.mock.calls[0]![0];
    expect(params.subscription_data).toEqual({ trial_period_days: 14 });
  });
});
