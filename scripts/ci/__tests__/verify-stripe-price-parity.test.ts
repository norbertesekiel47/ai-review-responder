import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  verifyConfiguredStripePrices,
  type RetrieveStripePrice,
} from '../../verify-stripe-price-parity';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';

const original: Record<string, string | undefined> = {};
const expectedIds = [
  'price_copilot_list',
  'price_copilot_founding',
  'price_copilot_overage',
  'price_autopilot_list',
  'price_autopilot_founding',
  'price_autopilot_overage',
];
const expectedAmounts: Record<string, number> = {
  price_copilot_list: 2900,
  price_copilot_founding: 1900,
  price_copilot_overage: 1500,
  price_autopilot_list: 6900,
  price_autopilot_founding: 4900,
  price_autopilot_overage: 2000,
};

beforeEach(() => {
  for (const key of STRIPE_PRICE_ENV_VARS) original[key] = process.env[key];
  process.env.STRIPE_PRICE_COPILOT_LIST = expectedIds[0];
  process.env.STRIPE_PRICE_COPILOT_FOUNDING = expectedIds[1];
  process.env.STRIPE_PRICE_COPILOT_OVERAGE = expectedIds[2];
  process.env.STRIPE_PRICE_AUTOPILOT_LIST = expectedIds[3];
  process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = expectedIds[4];
  process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = expectedIds[5];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of STRIPE_PRICE_ENV_VARS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function validPrice(overrides: Partial<Awaited<ReturnType<RetrieveStripePrice>>> = {}) {
  return {
    active: true,
    unit_amount: 2900,
    currency: 'usd',
    recurring: { interval: 'month' },
    tax_behavior: 'exclusive',
    ...overrides,
  };
}

describe('verifyConfiguredStripePrices', () => {
  it('retrieves every immutable WS8 Price and validates the expected amount', async () => {
    const retrieve = vi.fn<RetrieveStripePrice>(async (priceId) =>
      validPrice({ unit_amount: expectedAmounts[priceId] ?? null }),
    );

    await expect(verifyConfiguredStripePrices(retrieve, true)).resolves.toEqual([]);
    expect(retrieve.mock.calls.map(([priceId]) => priceId)).toEqual(expectedIds);
    expect(retrieve).toHaveBeenCalledTimes(6);
  });

  it('fails an inactive Price even when its amount, currency, interval, and tax behavior match', async () => {
    const retrieve = vi.fn<RetrieveStripePrice>(async (priceId) =>
      validPrice({
        active: priceId !== 'price_copilot_list',
        unit_amount: expectedAmounts[priceId] ?? null,
      }),
    );

    const mismatches = await verifyConfiguredStripePrices(retrieve, false);

    expect(mismatches).toEqual([{
      label: 'copilot/list base',
      field: 'active',
      expected: true,
      actual: false,
    }]);
    expect(retrieve).toHaveBeenCalledTimes(6);
  });

  it('enforces exclusive tax behavior only when Stripe Tax is enabled', async () => {
    const retrieve: RetrieveStripePrice = async (priceId) => validPrice({
      unit_amount: expectedAmounts[priceId] ?? null,
      tax_behavior: 'unspecified',
    });

    await expect(verifyConfiguredStripePrices(retrieve, false)).resolves.toEqual([]);
    const required = await verifyConfiguredStripePrices(retrieve, true);
    expect(required).toHaveLength(6);
    expect(required.every((mismatch) => mismatch.field === 'tax_behavior')).toBe(true);
  });
});
