import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseStripeTaxEnabled,
  prepareStripePriceParityCli,
  stripePriceParityExitCode,
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
    recurring: { interval: 'month', interval_count: 1 },
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

  it('verifies retained overage Prices remain active at their recorded grandfathered cents', async () => {
    const retrieve = vi.fn<RetrieveStripePrice>(async (priceId) => validPrice({
      active: priceId !== 'price_old_overage_inactive',
      unit_amount: priceId === 'price_old_overage_wrong_cents'
        ? 1499
        : priceId.startsWith('price_old_')
          ? 1400
          : expectedAmounts[priceId] ?? null,
    }));

    const mismatches = await verifyConfiguredStripePrices(retrieve, true, [
      {
        id: 'price_old_overage_wrong_cents',
        kind: 'overage',
        tier: 'copilot',
        unitAmountCents: 1400,
      },
      {
        id: 'price_old_overage_inactive',
        kind: 'overage',
        tier: 'copilot',
        unitAmountCents: 1400,
      },
    ]);

    expect(mismatches).toEqual([
      {
        label: 'copilot retained overage price_old_overage_wrong_cents',
        field: 'unit_amount',
        expected: 1400,
        actual: 1499,
      },
      {
        label: 'copilot retained overage price_old_overage_inactive',
        field: 'active',
        expected: true,
        actual: false,
      },
    ]);
    expect(retrieve).toHaveBeenCalledWith('price_old_overage_wrong_cents');
    expect(retrieve).toHaveBeenCalledWith('price_old_overage_inactive');
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

  it('fails closed on a missing configured Price without attempting to retrieve it', async () => {
    delete process.env.STRIPE_PRICE_COPILOT_FOUNDING;
    const retrieve = vi.fn<RetrieveStripePrice>(async (priceId) => validPrice({
      unit_amount: expectedAmounts[priceId] ?? null,
    }));

    const mismatches = await verifyConfiguredStripePrices(retrieve, true);

    expect(mismatches).toContainEqual({
      label: 'copilot/founding base',
      field: 'env',
      expected: 'price id',
      actual: 'unset',
    });
    expect(retrieve).toHaveBeenCalledTimes(5);
    expect(retrieve).not.toHaveBeenCalledWith('');
  });

  it('hard-fails when two launch env vars contain the same Price ID', async () => {
    process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_copilot_list';
    const retrieve = vi.fn<RetrieveStripePrice>();

    await expect(verifyConfiguredStripePrices(retrieve, true)).rejects.toThrow(
      'STRIPE_PRICE_COPILOT_LIST duplicates STRIPE_PRICE_AUTOPILOT_FOUNDING',
    );
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('reports wrong amount, currency, recurring interval, and active state', async () => {
    const retrieve: RetrieveStripePrice = async (priceId) => validPrice({
      active: priceId !== 'price_copilot_list',
      unit_amount: priceId === 'price_copilot_list' ? 2899 : expectedAmounts[priceId] ?? null,
      currency: priceId === 'price_copilot_list' ? 'eur' : 'usd',
      recurring: priceId === 'price_copilot_list'
        ? { interval: 'year', interval_count: 1 }
        : { interval: 'month', interval_count: 1 },
    });

    const mismatches = await verifyConfiguredStripePrices(retrieve, true);

    expect(mismatches.filter((mismatch) => mismatch.label === 'copilot/list base'))
      .toEqual([
        { label: 'copilot/list base', field: 'active', expected: true, actual: false },
        { label: 'copilot/list base', field: 'unit_amount', expected: 2900, actual: 2899 },
        { label: 'copilot/list base', field: 'currency', expected: 'usd', actual: 'eur' },
        { label: 'copilot/list base', field: 'recurring.interval', expected: 'month', actual: 'year' },
      ]);
  });

  it('rejects a multi-month Price even when its recurring interval is month', async () => {
    const retrieve: RetrieveStripePrice = async (priceId) => validPrice({
      unit_amount: expectedAmounts[priceId] ?? null,
      recurring: priceId === 'price_autopilot_list'
        ? { interval: 'month', interval_count: 3 }
        : { interval: 'month', interval_count: 1 },
    });

    const mismatches = await verifyConfiguredStripePrices(retrieve, true);

    expect(mismatches).toEqual([{
      label: 'autopilot/list base',
      field: 'recurring.interval_count',
      expected: 1,
      actual: 3,
    }]);
  });

  it('propagates Stripe retrieval errors instead of reporting a false pass', async () => {
    const retrieve = vi.fn<RetrieveStripePrice>(async () => {
      throw new Error('Stripe unavailable');
    });

    await expect(verifyConfiguredStripePrices(retrieve, true)).rejects.toThrow('Stripe unavailable');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
});

describe('Stripe parity CLI preparation', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['true', true],
  ])('parses STRIPE_TAX_ENABLED=%s as %s', (value, expected) => {
    expect(parseStripeTaxEnabled(value)).toBe(expected);
    expect(prepareStripePriceParityCli({ STRIPE_TAX_ENABLED: value })).toEqual({
      taxRequired: expected,
    });
  });

  it.each(['TRUE', ' false ', '0', 'yes'])('rejects non-exact STRIPE_TAX_ENABLED=%s', (value) => {
    expect(() => prepareStripePriceParityCli({ STRIPE_TAX_ENABLED: value })).toThrow(
      'STRIPE_TAX_ENABLED must be exactly true or false when set',
    );
  });

  it('fails closed for mismatches, missing results, and thrown errors', () => {
    expect(stripePriceParityExitCode([])).toBe(0);
    expect(stripePriceParityExitCode([{
      label: 'copilot/list base', field: 'active', expected: true, actual: false,
    }])).toBe(1);
    expect(stripePriceParityExitCode(null)).toBe(1);
    expect(stripePriceParityExitCode([], new Error('provider failed'))).toBe(1);
  });
});
