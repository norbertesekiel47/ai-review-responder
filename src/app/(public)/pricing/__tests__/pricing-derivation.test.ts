import { describe, it, expect } from 'vitest';
import { monthlyPriceUsd, annualPriceUsd } from '../pricing-derivation';

describe('pricing page derives from TIER_CONFIG', () => {
  it('monthly = baseCents/100', () => {
    expect(monthlyPriceUsd('founders')).toBe(19);
    expect(monthlyPriceUsd('basic')).toBe(29);
    expect(monthlyPriceUsd('standard')).toBe(79);
    expect(monthlyPriceUsd('premium')).toBe(199);
  });
  it('annual = floor(monthly × (1 − ANNUAL_DISCOUNT)) — locks today’s displayed values', () => {
    expect(annualPriceUsd('founders')).toBe(15);
    expect(annualPriceUsd('basic')).toBe(23);
    expect(annualPriceUsd('standard')).toBe(63);
    expect(annualPriceUsd('premium')).toBe(159);
  });
});
