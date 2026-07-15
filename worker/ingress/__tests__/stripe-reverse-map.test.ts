import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  basePriceInfoForId,
  priceIdFor,
} from '../../../src/lib/payments/price-tier-map';

const PRICE_ENV = {
  STRIPE_PRICE_COPILOT_LIST: 'price_copilot_list',
  STRIPE_PRICE_COPILOT_FOUNDING: 'price_copilot_founding',
  STRIPE_PRICE_AUTOPILOT_LIST: 'price_autopilot_list',
  STRIPE_PRICE_AUTOPILOT_FOUNDING: 'price_autopilot_founding',
  STRIPE_PRICE_COPILOT_OVERAGE: 'price_copilot_overage',
  STRIPE_PRICE_AUTOPILOT_OVERAGE: 'price_autopilot_overage',
} as const;
const saved = new Map<string, string | undefined>();

beforeAll(() => {
  for (const [key, value] of Object.entries(PRICE_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('WS8 Stripe reverse Price mapping', () => {
  it.each([
    ['price_copilot_list', 'copilot', 'list'],
    ['price_copilot_founding', 'copilot', 'founding'],
    ['price_autopilot_list', 'autopilot', 'list'],
    ['price_autopilot_founding', 'autopilot', 'founding'],
  ] as const)('retains base Price %s as %s/%s', (priceId, tier, variant) => {
    expect(basePriceInfoForId(priceId)).toEqual({ tier, variant });
  });

  it.each([
    ['copilot', 'list', 'price_copilot_overage'],
    ['copilot', 'founding', 'price_copilot_overage'],
    ['autopilot', 'list', 'price_autopilot_overage'],
    ['autopilot', 'founding', 'price_autopilot_overage'],
  ] as const)('resolves %s/%s to its shared tier overage Price', (tier, variant, priceId) => {
    expect(priceIdFor(tier, variant, 'overage')).toBe(priceId);
  });

  it('does not let founding eligibility closure remove historical reverse IDs', () => {
    process.env.FOUNDING_DEADLINE = '2020-01-01T00:00:00Z';
    expect(basePriceInfoForId('price_copilot_founding')).toEqual({
      tier: 'copilot',
      variant: 'founding',
    });
    expect(basePriceInfoForId('price_autopilot_founding')).toEqual({
      tier: 'autopilot',
      variant: 'founding',
    });
  });
});
