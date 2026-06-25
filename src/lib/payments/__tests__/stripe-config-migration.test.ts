// Behavior-preservation tests for the Stage-3 STRIPE_SECRET_KEY migration
// (process.env.STRIPE_SECRET_KEY → getServerConfig().STRIPE_SECRET_KEY).
//
// The raw-semantics-critical contract: the migrated read uses rawOptionalVar, so
// a whitespace-only key stays truthy and is passed verbatim to new Stripe(...),
// exactly as the old raw process.env read did. Under the collapsing optionalVar
// this would be RED (the whitespace case would throw / pass undefined); under
// rawOptionalVar it is GREEN. The narrow `if (!key) throw` assert on the RAW value
// is preserved for the genuinely-unset/empty cases.
//
// Uses set→reset→import (convention #6) because getStripe() now reads the memoized
// getServerConfig() — each case re-evaluates the config module on a fresh env.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the secret passed to `new Stripe(...)` without pulling in the real SDK.
const { stripeCtorArgs } = vi.hoisted(() => ({ stripeCtorArgs: [] as unknown[] }));

vi.mock('stripe', () => ({
  __esModule: true,
  default: class FakeStripe {
    constructor(key: string) {
      stripeCtorArgs.push(key);
    }
    getApiField() {
      return '2026-05-27.dahlia';
    }
  },
}));

async function freshClient(envPatch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import('../stripe-client');
}

describe('stripe-client STRIPE_SECRET_KEY migration — raw-semantics preserved', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original };
    stripeCtorArgs.length = 0;
  });
  afterEach(() => {
    process.env = original;
    vi.resetModules();
  });

  it('constructs with the configured key (present case)', async () => {
    const { getStripe } = await freshClient({ STRIPE_SECRET_KEY: 'sk_test_present' });
    expect(() => getStripe()).not.toThrow();
    expect(stripeCtorArgs).toEqual(['sk_test_present']);
  });

  it('throws the same message when STRIPE_SECRET_KEY is unset', async () => {
    const { getStripe } = await freshClient({ STRIPE_SECRET_KEY: undefined });
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not set');
    expect(stripeCtorArgs).toEqual([]);
  });

  it('throws the same message when STRIPE_SECRET_KEY is empty', async () => {
    const { getStripe } = await freshClient({ STRIPE_SECRET_KEY: '' });
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not set');
    expect(stripeCtorArgs).toEqual([]);
  });

  // The rawOptionalVar contract (convention #7): a whitespace-only key is TRUTHY,
  // so it does NOT throw and is passed verbatim to new Stripe('   '), matching the
  // old raw process.env read. The collapsing optionalVar would map '   '→undefined,
  // changing behavior to a spurious throw — this case locks against that.
  it('does NOT throw for a whitespace-only key and passes the raw string through', async () => {
    const { getStripe } = await freshClient({ STRIPE_SECRET_KEY: '   ' });
    expect(() => getStripe()).not.toThrow();
    expect(stripeCtorArgs).toEqual(['   ']);
  });
});
