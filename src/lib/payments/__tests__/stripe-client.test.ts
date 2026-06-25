import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getStripe() now reads STRIPE_SECRET_KEY via the memoized getServerConfig()
// (Stage-3 migration). vi.resetModules() re-evaluates the config module so each
// case's env is parsed fresh; the module under test is re-imported dynamically
// after env is set (convention #6). Every assertion is the same as before — only
// the env-setup mechanism changed from vi.stubEnv to set→reset→import.
async function freshClient(envPatch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import('../stripe-client');
}

describe('stripe-client', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original }; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('pins the SDK apiVersion and bounds timeout + retries', async () => {
    const { STRIPE_CLIENT_CONFIG } = await freshClient({});
    expect(STRIPE_CLIENT_CONFIG.apiVersion).toBe('2026-05-27.dahlia');
    expect(STRIPE_CLIENT_CONFIG.timeout).toBe(20_000);
    expect(STRIPE_CLIENT_CONFIG.maxNetworkRetries).toBe(2);
  });

  it('throws when STRIPE_SECRET_KEY is not set', async () => {
    const { getStripe } = await freshClient({ STRIPE_SECRET_KEY: '' });
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not set');
  });

  it('returns a singleton wired to the pinned apiVersion', async () => {
    const { getStripe } = await freshClient({ STRIPE_SECRET_KEY: 'sk_test_dummy' });
    const a = getStripe();
    const b = getStripe();
    expect(a).toBe(b);
    expect(a.getApiField('version')).toBe('2026-05-27.dahlia');
  });
});
