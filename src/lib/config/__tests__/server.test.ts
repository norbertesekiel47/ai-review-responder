import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';

const CORE = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_KEY: 'svc',
  DATABASE_POOL_URL: 'postgres://t:t@localhost:5432/t',
};

describe('config/server', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original }; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('assertCoreAppConfig passes with the six core-app vars', async () => {
    Object.assign(process.env, CORE);
    const { assertCoreAppConfig } = await import('../server');
    expect(() => assertCoreAppConfig()).not.toThrow();
  });

  it('assertCoreAppConfig throws naming a missing core var', async () => {
    Object.assign(process.env, CORE);
    delete process.env.SUPABASE_SERVICE_KEY;
    const { assertCoreAppConfig } = await import('../server');
    expect(() => assertCoreAppConfig()).toThrow(/SUPABASE_SERVICE_KEY/);
  });

  it('getStripeConfig asserts presence and returns non-null secrets', async () => {
    Object.assign(process.env, CORE, {
      STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec',
    });
    for (const v of STRIPE_PRICE_ENV_VARS) process.env[v] = `price_${v}`;
    const { getStripeConfig } = await import('../server');
    const cfg = getStripeConfig();
    expect(cfg.STRIPE_SECRET_KEY).toBe('sk_test');
    expect(cfg.STRIPE_PRICE_BASIC).toBe('price_STRIPE_PRICE_BASIC');
  });

  it('getStripeConfig throws when a Stripe secret is missing', async () => {
    Object.assign(process.env, CORE, { STRIPE_WEBHOOK_SECRET: 'whsec' });
    const { getStripeConfig } = await import('../server');
    expect(() => getStripeConfig()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('getResendConfig throws when RESEND_API_KEY is missing', async () => {
    Object.assign(process.env, CORE);
    const { getResendConfig } = await import('../server');
    expect(() => getResendConfig()).toThrow(/RESEND_API_KEY/);
  });
});
