import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStripe, resetStripeClientForTests, STRIPE_CLIENT_CONFIG } from '../stripe-client';

describe('stripe-client', () => {
  afterEach(() => {
    resetStripeClientForTests();
    vi.unstubAllEnvs();
  });

  it('pins the SDK apiVersion and bounds timeout + retries', () => {
    expect(STRIPE_CLIENT_CONFIG.apiVersion).toBe('2026-05-27.dahlia');
    expect(STRIPE_CLIENT_CONFIG.timeout).toBe(20_000);
    expect(STRIPE_CLIENT_CONFIG.maxNetworkRetries).toBe(2);
  });

  it('throws when STRIPE_SECRET_KEY is not set', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not set');
  });

  it('returns a singleton wired to the pinned apiVersion', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
    const a = getStripe();
    const b = getStripe();
    expect(a).toBe(b);
    expect(a.getApiField('version')).toBe('2026-05-27.dahlia');
  });
});
