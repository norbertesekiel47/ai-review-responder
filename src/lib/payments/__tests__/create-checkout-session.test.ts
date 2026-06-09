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
