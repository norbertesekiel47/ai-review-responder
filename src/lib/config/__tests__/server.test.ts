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

  // ── Stage-3 src-lib batch: the migrated server/shared secret + config vars ──
  const SRC_LIB_VARS = [
    'POSTHOG_API_KEY',
    'POSTHOG_HOST',
    'ONBOARDING_DEMO_DAILY_CENTS',
    'OWNER_LEADS_GOOGLE_SHEET_ID',
    'GOOGLE_SHEETS_CLIENT_EMAIL',
    'GOOGLE_SHEETS_PRIVATE_KEY',
    'OWNER_LEADS_GOOGLE_SHEET_RANGE',
    'IMPERSONATION_COOKIE_SECRET',
    'SESSION_COOKIE_SECRET',
    'CSRF_SECRET',
    'WORKER_PUBLIC_URL',
  ] as const;

  it('exposes the Stage-3 src-lib vars as OPTIONAL (present when set)', async () => {
    Object.assign(process.env, CORE);
    for (const v of SRC_LIB_VARS) process.env[v] = `val_${v}`;
    const { getServerConfig } = await import('../server');
    const cfg = getServerConfig();
    for (const v of SRC_LIB_VARS) {
      expect(cfg[v]).toBe(`val_${v}`);
    }
  });

  it('Stage-3 src-lib vars are undefined (not throwing) when unset — tolerate-absent', async () => {
    Object.assign(process.env, CORE);
    for (const v of SRC_LIB_VARS) delete process.env[v];
    const { getServerConfig } = await import('../server');
    const cfg = getServerConfig();
    for (const v of SRC_LIB_VARS) {
      expect(cfg[v]).toBeUndefined();
    }
  });

  // rawOptionalVar (#7): the four HMAC/secret/URL vars switched from optionalVar
  // → rawOptionalVar must preserve a whitespace-only '   ' VERBATIM (not collapse
  // to undefined), because each consumer does `if (!value) throw` then a RAW
  // length/HMAC/URL check on the value. RED under the collapsing optionalVar.
  it('preserves whitespace-only secrets verbatim (rawOptionalVar passthrough)', async () => {
    Object.assign(process.env, CORE, {
      SESSION_COOKIE_SECRET: '   ',
      IMPERSONATION_COOKIE_SECRET: '   ',
      CSRF_SECRET: '   ',
      WORKER_PUBLIC_URL: '   ',
    });
    const { getServerConfig } = await import('../server');
    const cfg = getServerConfig();
    expect(cfg.SESSION_COOKIE_SECRET).toBe('   ');
    expect(cfg.IMPERSONATION_COOKIE_SECRET).toBe('   ');
    expect(cfg.CSRF_SECRET).toBe('   ');
    expect(cfg.WORKER_PUBLIC_URL).toBe('   ');
  });

  // ── Stage-3 serpapi-redis batch: SERPAPI_API_KEY + REDIS_CACHE_URL switched
  //    optionalVar → rawOptionalVar, and SERPAPI_TIMEOUT_MS added (rawOptionalVar).
  const SERPAPI_REDIS_VARS = ['SERPAPI_API_KEY', 'REDIS_CACHE_URL', 'SERPAPI_TIMEOUT_MS'] as const;

  it('exposes the SerpAPI+Redis cluster vars as OPTIONAL (present when set)', async () => {
    Object.assign(process.env, CORE, {
      SERPAPI_API_KEY: 'serp-key',
      REDIS_CACHE_URL: 'redis://localhost:6379',
      SERPAPI_TIMEOUT_MS: '3500',
    });
    const { getServerConfig } = await import('../server');
    const cfg = getServerConfig();
    expect(cfg.SERPAPI_API_KEY).toBe('serp-key');
    expect(cfg.REDIS_CACHE_URL).toBe('redis://localhost:6379');
    expect(cfg.SERPAPI_TIMEOUT_MS).toBe('3500');
  });

  it('SerpAPI+Redis cluster vars are undefined when unset — tolerate-absent (no throw)', async () => {
    Object.assign(process.env, CORE);
    for (const v of SERPAPI_REDIS_VARS) delete process.env[v];
    const { getServerConfig } = await import('../server');
    const cfg = getServerConfig();
    for (const v of SERPAPI_REDIS_VARS) {
      expect(cfg[v]).toBeUndefined();
    }
  });

  // rawOptionalVar (#7): SERPAPI_API_KEY / REDIS_CACHE_URL / SERPAPI_TIMEOUT_MS must
  // preserve a whitespace-only '   ' VERBATIM (not collapse to undefined): the
  // migrated consumers do `if (!apiKey)` / `if (!REDIS_CACHE_URL)` (presence gates)
  // and `cfg.SERPAPI_TIMEOUT_MS ? parseInt(...) : 2_000`, so '   ' must stay truthy
  // exactly like the old raw process.env read. RED under the collapsing optionalVar.
  it('preserves whitespace-only SerpAPI+Redis cluster vars verbatim (rawOptionalVar #7)', async () => {
    Object.assign(process.env, CORE, {
      SERPAPI_API_KEY: '   ',
      REDIS_CACHE_URL: '   ',
      SERPAPI_TIMEOUT_MS: '   ',
    });
    const { getServerConfig } = await import('../server');
    const cfg = getServerConfig();
    expect(cfg.SERPAPI_API_KEY).toBe('   ');
    expect(cfg.REDIS_CACHE_URL).toBe('   ');
    expect(cfg.SERPAPI_TIMEOUT_MS).toBe('   ');
  });
});
