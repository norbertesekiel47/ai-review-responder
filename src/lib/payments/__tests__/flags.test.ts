import { afterEach, describe, expect, it } from 'vitest';
import {
  betaCompCouponId,
  trialEnabled,
  stripeTaxEnabled,
  stripeLocationsReconcileDisabled,
} from '../flags';
import { resetServerConfigForTests } from '@/lib/config/server';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetServerConfigForTests();
});

const FALSE_CASES: ReadonlyArray<[string, string | undefined]> = [
  ['missing', undefined],
  ['empty', ''],
  ['false', 'false'],
  ['uppercase TRUE', 'TRUE'],
  ['mixed case True', 'True'],
  ['numeric 1', '1'],
  ['padded true', ' true '],
];

const ACCESSORS: ReadonlyArray<[string, () => boolean]> = [
  ['TRIAL_ENABLED', trialEnabled],
  ['STRIPE_TAX_ENABLED', stripeTaxEnabled],
  ['STRIPE_LOCATIONS_RECONCILE_DISABLED', stripeLocationsReconcileDisabled],
];

describe.each(ACCESSORS)('%s accessor', (envName, accessor) => {
  it.each(FALSE_CASES)('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
    expect(accessor()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env[envName] = 'true';
    expect(accessor()).toBe(true);
  });
});

// The one NON-boolean value this module owns. "Unset" is its OFF position, so
// every shape that is not a real coupon id must read as null — a blank id would
// otherwise reach Stripe and fail session creation instead of switching off.
describe('BETA_COMP_COUPON_ID accessor', () => {
  const NULL_CASES: ReadonlyArray<[string, string | undefined]> = [
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ];

  it.each(NULL_CASES)('is null for %s', (_label, value) => {
    if (value === undefined) delete process.env.BETA_COMP_COUPON_ID;
    else process.env.BETA_COMP_COUPON_ID = value;
    resetServerConfigForTests();
    expect(betaCompCouponId()).toBeNull();
  });

  it('returns the configured id, trimmed', () => {
    process.env.BETA_COMP_COUPON_ID = '  beta_comp_3mo  ';
    resetServerConfigForTests();
    expect(betaCompCouponId()).toBe('beta_comp_3mo');
  });
});
