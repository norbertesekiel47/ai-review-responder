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

  // LANE SAFETY (regression guard for the Codex blocker): getServerConfig() is
  // SHAPE-ONLY — it must NOT throw when the NEXT_PUBLIC_* core vars are absent but
  // a subsystem secret is present, because shared src/lib modules (getStripe(),
  // the email modules) call getServerConfig() in the WORKER, whose env doesn't
  // carry the Next public vars. Required-ness lives only in assertCoreAppConfig().
  it('getServerConfig does NOT throw when NEXT_PUBLIC_* are absent but a subsystem secret is set (worker lane)', async () => {
    // Simulate the worker env: no Next public vars, a subsystem secret present.
    for (const v of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_APP_URL']) {
      delete process.env[v];
    }
    process.env.STRIPE_SECRET_KEY = 'sk_live_worker';
    const { getServerConfig } = await import('../server');
    expect(() => getServerConfig()).not.toThrow();
    const cfg = getServerConfig();
    expect(cfg.STRIPE_SECRET_KEY).toBe('sk_live_worker');
    expect(cfg.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
    expect(cfg.NEXT_PUBLIC_APP_URL).toBeUndefined();
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

  it('STRIPE_SECRET_KEY is exposed RAW via getServerConfig (tolerate-absent)', async () => {
    // rawOptionalVar passthrough: present-when-set, undefined-when-unset, and
    // whitespace survives verbatim (the stripe-client migrated read depends on it).
    Object.assign(process.env, CORE, { STRIPE_SECRET_KEY: '   ' });
    const { getServerConfig } = await import('../server');
    expect(getServerConfig().STRIPE_SECRET_KEY).toBe('   ');
  });

  it('STRIPE_SECRET_KEY is undefined (not throwing) when unset — tolerate-absent', async () => {
    Object.assign(process.env, CORE);
    delete process.env.STRIPE_SECRET_KEY;
    const { getServerConfig } = await import('../server');
    expect(getServerConfig().STRIPE_SECRET_KEY).toBeUndefined();
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
