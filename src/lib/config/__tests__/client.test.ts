import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
};

describe('config/client', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original }; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('assertClientConfig passes when required public vars are present', async () => {
    Object.assign(process.env, REQUIRED);
    const { assertClientConfig } = await import('../client');
    expect(() => assertClientConfig()).not.toThrow();
  });

  it('assertClientConfig throws naming the missing var', async () => {
    Object.assign(process.env, REQUIRED);
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { assertClientConfig } = await import('../client');
    expect(() => assertClientConfig()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('getClientConfig returns required + optional fields', async () => {
    Object.assign(process.env, REQUIRED, { NEXT_PUBLIC_SENTRY_DSN: 'https://x@y/1' });
    const { getClientConfig } = await import('../client');
    const cfg = getClientConfig();
    expect(cfg.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
    expect(cfg.NEXT_PUBLIC_SENTRY_DSN).toBe('https://x@y/1');
  });
});
