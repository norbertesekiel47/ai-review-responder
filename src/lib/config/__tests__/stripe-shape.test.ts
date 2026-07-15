import { describe, expect, it } from 'vitest';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import { narrowStripeConfig, STRIPE_REQUIRED_VARS } from '../stripe-shape';

describe('narrowStripeConfig owner-tuple derivation', () => {
  it('preserves every Price key from STRIPE_PRICE_ENV_VARS mechanically', () => {
    const env: Record<string, string> = {
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
    };
    for (const name of STRIPE_PRICE_ENV_VARS) env[name] = `value_for_${name}`;

    const narrowed = narrowStripeConfig(env, 'stripe-shape-test');

    expect(STRIPE_REQUIRED_VARS).toEqual([
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      ...STRIPE_PRICE_ENV_VARS,
    ]);
    for (const name of STRIPE_PRICE_ENV_VARS) {
      expect(narrowed[name]).toBe(`value_for_${name}`);
    }
    expect(Object.keys(narrowed).sort()).toEqual([...STRIPE_REQUIRED_VARS].sort());
  });
});
