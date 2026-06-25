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

  it('assertCoreAppConfig passes with only the three public core vars (no DB creds)', async () => {
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    });
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.DATABASE_POOL_URL;
    const { assertCoreAppConfig } = await import('../server');
    expect(() => assertCoreAppConfig()).not.toThrow();
  });

  it('assertCoreAppConfig throws naming a missing core var', async () => {
    Object.assign(process.env, CORE);
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { assertCoreAppConfig } = await import('../server');
    expect(() => assertCoreAppConfig()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('getServerDbConfig asserts presence and returns the DB creds', async () => {
    Object.assign(process.env, CORE);
    const { getServerDbConfig } = await import('../server');
    const cfg = getServerDbConfig();
    expect(cfg.SUPABASE_SERVICE_KEY).toBe('svc');
    expect(cfg.DATABASE_POOL_URL).toBe('postgres://t:t@localhost:5432/t');
  });

  it('getServerDbConfig throws when a DB cred is missing', async () => {
    Object.assign(process.env, CORE);
    delete process.env.DATABASE_POOL_URL;
    const { getServerDbConfig } = await import('../server');
    expect(() => getServerDbConfig()).toThrow(/DATABASE_POOL_URL/);
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

  it('exposes the email subsystem vars as OPTIONAL (present when set)', async () => {
    Object.assign(process.env, CORE, {
      RESEND_FROM_EMAIL: 'RepWorth <hi@repworth.com>',
      EMAIL_SEND_TIMEOUT_MS: '7500',
      LIST_UNSUBSCRIBE_URL: 'https://repworth.com/unsub',
      LIST_UNSUBSCRIBE_EMAIL: 'unsub@repworth.com',
    });
    const { getServerConfig } = await import('../server');
    const cfg = getServerConfig();
    expect(cfg.RESEND_FROM_EMAIL).toBe('RepWorth <hi@repworth.com>');
    expect(cfg.EMAIL_SEND_TIMEOUT_MS).toBe('7500');
    expect(cfg.LIST_UNSUBSCRIBE_URL).toBe('https://repworth.com/unsub');
    expect(cfg.LIST_UNSUBSCRIBE_EMAIL).toBe('unsub@repworth.com');
  });

  it('email subsystem vars are undefined (not throwing) when unset — tolerate-absent', async () => {
    Object.assign(process.env, CORE);
    for (const v of [
      'RESEND_FROM_EMAIL', 'EMAIL_SEND_TIMEOUT_MS', 'LIST_UNSUBSCRIBE_URL', 'LIST_UNSUBSCRIBE_EMAIL',
    ]) delete process.env[v];
    const { getServerConfig } = await import('../server');
    const cfg = getServerConfig();
    expect(cfg.RESEND_FROM_EMAIL).toBeUndefined();
    expect(cfg.EMAIL_SEND_TIMEOUT_MS).toBeUndefined();
    expect(cfg.LIST_UNSUBSCRIBE_URL).toBeUndefined();
    expect(cfg.LIST_UNSUBSCRIBE_EMAIL).toBeUndefined();
  });
});
