import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic: the worker lane self-loads .env.local in production, but a unit test
// must not let the developer's real .env.local repopulate vars it deliberately
// clears. Stub the loader to a no-op so the assert logic is tested in isolation.
vi.mock('../dotenv-load', () => ({ ensureWorkerDotenvLoaded: () => {} }));

const CORE = {
  DATABASE_POOL_URL: 'postgres://t:t@localhost:5432/t',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_KEY: 'svc',
  REDIS_QUEUE_URL: 'redis://localhost:6379/1',
};

describe('config/worker', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original }; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('assertWorkerConfig passes with the four core-infra vars', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    const { assertWorkerConfig } = await import('../worker');
    expect(() => assertWorkerConfig()).not.toThrow();
  });

  it('assertWorkerConfig throws naming a missing core-infra var (non-mock)', async () => {
    process.env = { ...CORE, NODE_ENV: 'test', MOCK_EXTERNAL_APIS: 'false' } as NodeJS.ProcessEnv;
    delete process.env.REDIS_QUEUE_URL;
    const { assertWorkerConfig } = await import('../worker');
    expect(() => assertWorkerConfig()).toThrow(/REDIS_QUEUE_URL/);
  });

  it('assertWorkerConfig is a no-op in non-prod MOCK mode even when vars are absent', async () => {
    process.env = { NODE_ENV: 'test', MOCK_EXTERNAL_APIS: 'true' } as NodeJS.ProcessEnv;
    const { assertWorkerConfig } = await import('../worker');
    expect(() => assertWorkerConfig()).not.toThrow();
  });

  it('getWorkerStripeConfig throws when a Stripe price var is missing', async () => {
    process.env = {
      ...CORE, NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh',
    } as NodeJS.ProcessEnv;
    const { getWorkerStripeConfig } = await import('../worker');
    expect(() => getWorkerStripeConfig()).toThrow(/STRIPE_PRICE_/);
  });

  it('STRIPE_WEBHOOK_SECRET is exposed RAW via getWorkerConfig (tolerate-absent)', async () => {
    // rawOptionalVar passthrough — the ingress migrated read does `if (!secret)`.
    process.env = { ...CORE, NODE_ENV: 'test', STRIPE_WEBHOOK_SECRET: '   ' } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().STRIPE_WEBHOOK_SECRET).toBe('   ');
  });

  it('STRIPE_WEBHOOK_SECRET is undefined when unset — tolerate-absent (no throw)', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().STRIPE_WEBHOOK_SECRET).toBeUndefined();
  });

  it('STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS is exposed RAW via getWorkerConfig', async () => {
    // The reconcile poller owns its own `envInterval ? parseInt : NaN` parse, so
    // the config layer just passes the raw string through (present + unset).
    process.env = {
      ...CORE, NODE_ENV: 'test', STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS: '900000',
    } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS).toBe('900000');
  });

  it('STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS is undefined when unset — tolerate-absent', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete process.env.STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS).toBeUndefined();
  });

  // ── Stage-3 worker-pollers batch ──────────────────────────────────────────

  it('a representative poller tuning var is exposed RAW via getWorkerConfig (present)', async () => {
    process.env = {
      ...CORE, NODE_ENV: 'test', OUTBOX_BATCH_SIZE: '50',
    } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().OUTBOX_BATCH_SIZE).toBe('50');
  });

  it('a poller tuning var is undefined when unset — tolerate-absent (no throw)', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete process.env.OUTBOX_BATCH_SIZE;
    delete process.env.HEALTH_ALERT_FAILED_THRESHOLD;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().OUTBOX_BATCH_SIZE).toBeUndefined();
    expect(getWorkerConfig().HEALTH_ALERT_FAILED_THRESHOLD).toBeUndefined();
  });

  it('GOVERNOR_INTERVAL_MS is exposed RAW for scheduler-owned parsing', async () => {
    process.env = {
      ...CORE, NODE_ENV: 'test', GOVERNOR_INTERVAL_MS: '900000',
    } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().GOVERNOR_INTERVAL_MS).toBe('900000');
  });

  it('ADMIN_NOTIFICATION_EMAIL passes whitespace-only through RAW (rawOptionalVar #7)', async () => {
    // The migrated NotificationFailoverPoller reads it raw via `if (adminEmail)`,
    // so `'   '` must stay truthy (the collapsing optionalVar would map it to
    // undefined and silently drop the alert).
    process.env = { ...CORE, NODE_ENV: 'test', ADMIN_NOTIFICATION_EMAIL: '   ' } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().ADMIN_NOTIFICATION_EMAIL).toBe('   ');
  });

  it('SENTRY_DSN passes whitespace-only through RAW (rawOptionalVar #7)', async () => {
    // drift-alert.ts reads it raw via `if (X)` (Sentry vs warn-log fallback).
    process.env = { ...CORE, NODE_ENV: 'test', SENTRY_DSN: '   ' } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().SENTRY_DSN).toBe('   ');
  });

  // ── Stage-3 worker-jobs batch ─────────────────────────────────────────────

  it('the new worker-jobs vars are exposed RAW via getWorkerConfig (present)', async () => {
    process.env = {
      ...CORE, NODE_ENV: 'test',
      NEXT_PUBLIC_APP_URL: 'https://app.repworth.com',
      RESEND_FROM_EMAIL: 'RepWorth <noreply@repworth.com>',
      CSRF_SECRET: 'csrf-secret',
      WHATSAPP_AUTOPOST_TEMPLATE_SID: 'HXsid',
      ZERNIO_INGEST_MAX_PAGES: '6',
    } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    const cfg = getWorkerConfig();
    expect(cfg.NEXT_PUBLIC_APP_URL).toBe('https://app.repworth.com');
    expect(cfg.RESEND_FROM_EMAIL).toBe('RepWorth <noreply@repworth.com>');
    expect(cfg.CSRF_SECRET).toBe('csrf-secret');
    expect(cfg.WHATSAPP_AUTOPOST_TEMPLATE_SID).toBe('HXsid');
    expect(cfg.ZERNIO_INGEST_MAX_PAGES).toBe('6');
  });

  it('the new worker-jobs vars are undefined when unset — tolerate-absent (no throw)', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.CSRF_SECRET;
    delete process.env.WHATSAPP_AUTOPOST_TEMPLATE_SID;
    delete process.env.ZERNIO_INGEST_MAX_PAGES;
    const { getWorkerConfig } = await import('../worker');
    const cfg = getWorkerConfig();
    expect(cfg.NEXT_PUBLIC_APP_URL).toBeUndefined();
    expect(cfg.RESEND_FROM_EMAIL).toBeUndefined();
    expect(cfg.CSRF_SECRET).toBeUndefined();
    expect(cfg.WHATSAPP_AUTOPOST_TEMPLATE_SID).toBeUndefined();
    expect(cfg.ZERNIO_INGEST_MAX_PAGES).toBeUndefined();
  });

  it('NEXT_PUBLIC_APP_URL passes whitespace-only through RAW (rawOptionalVar #7)', async () => {
    // Worker job sites build `${appUrl}/dashboard` / `if (!appUrl)` on the raw
    // value; the collapsing optionalVar would map '   ' to undefined.
    process.env = { ...CORE, NODE_ENV: 'test', NEXT_PUBLIC_APP_URL: '   ' } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().NEXT_PUBLIC_APP_URL).toBe('   ');
  });

  it('SERPAPI_API_KEY passes whitespace-only through RAW (rawOptionalVar #7)', async () => {
    // RankingTrackingWorker passes it straight to the SerpAPI SDK; '   ' must
    // survive exactly (the collapsing optionalVar would send undefined instead).
    process.env = { ...CORE, NODE_ENV: 'test', SERPAPI_API_KEY: '   ' } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().SERPAPI_API_KEY).toBe('   ');
  });

  // ── Stage-3 worker-ingress batch (webhook signature secrets) ──────────────

  it('the 4 webhook-signature secrets are exposed RAW via getWorkerConfig (present)', async () => {
    process.env = {
      ...CORE, NODE_ENV: 'test',
      RESEND_WEBHOOK_SECRET: 'whsec_resend',
      TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
      TWILIO_AUTH_TOKEN: 'twilio-tok',
      ZERNIO_WEBHOOK_SECRET: 'zernio-secret',
    } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    const cfg = getWorkerConfig();
    expect(cfg.RESEND_WEBHOOK_SECRET).toBe('whsec_resend');
    expect(cfg.TELEGRAM_WEBHOOK_SECRET).toBe('tg-secret');
    expect(cfg.TWILIO_AUTH_TOKEN).toBe('twilio-tok');
    expect(cfg.ZERNIO_WEBHOOK_SECRET).toBe('zernio-secret');
  });

  it('the 4 webhook-signature secrets are undefined when unset — tolerate-absent (no throw)', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    const { getWorkerConfig } = await import('../worker');
    const cfg = getWorkerConfig();
    expect(cfg.RESEND_WEBHOOK_SECRET).toBeUndefined();
    expect(cfg.TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    expect(cfg.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(cfg.ZERNIO_WEBHOOK_SECRET).toBeUndefined();
  });

  it('webhook-signature secrets pass whitespace-only through RAW (rawOptionalVar #7)', async () => {
    // SECURITY-CRITICAL: each secret is compared RAW in the verification
    // primitive (createHmac key / timingSafeEqual buffer / twilio.validateRequest
    // authToken). A whitespace value MUST survive byte-for-byte — the collapsing
    // optionalVar would map '   ' to undefined and could FLIP a verification
    // outcome. RED under optionalVar, GREEN under rawOptionalVar.
    process.env = {
      ...CORE, NODE_ENV: 'test',
      RESEND_WEBHOOK_SECRET: '   ',
      TELEGRAM_WEBHOOK_SECRET: '   ',
      TWILIO_AUTH_TOKEN: '   ',
      ZERNIO_WEBHOOK_SECRET: '   ',
    } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    const cfg = getWorkerConfig();
    expect(cfg.RESEND_WEBHOOK_SECRET).toBe('   ');
    expect(cfg.TELEGRAM_WEBHOOK_SECRET).toBe('   ');
    expect(cfg.TWILIO_AUTH_TOKEN).toBe('   ');
    expect(cfg.ZERNIO_WEBHOOK_SECRET).toBe('   ');
  });

  // ── Stage-3 serpapi-redis batch ───────────────────────────────────────────

  it('REDIS_CACHE_URL passes whitespace-only through RAW (rawOptionalVar #7)', async () => {
    // place-id-resolver (worker-only) does `if (!getWorkerConfig().REDIS_CACHE_URL)`
    // on the raw value; '   ' must stay truthy so the fail-closed budget gate does
    // not false-fire. The collapsing optionalVar would map it to undefined. RED
    // under optionalVar, GREEN under rawOptionalVar.
    process.env = { ...CORE, NODE_ENV: 'test', REDIS_CACHE_URL: '   ' } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().REDIS_CACHE_URL).toBe('   ');
  });

  it('REDIS_CACHE_URL is undefined when unset — tolerate-absent (no throw)', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete process.env.REDIS_CACHE_URL;
    const { getWorkerConfig } = await import('../worker');
    expect(getWorkerConfig().REDIS_CACHE_URL).toBeUndefined();
  });

  // ── Stage-3 notification-channels batch ───────────────────────────────────

  it('the 4 new channel-send vars are exposed RAW via getWorkerConfig (present)', async () => {
    process.env = {
      ...CORE, NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155238886',
      WHATSAPP_APPROVAL_TEMPLATE_SID: 'HX_approval',
    } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    const cfg = getWorkerConfig();
    expect(cfg.TELEGRAM_BOT_TOKEN).toBe('bot-token');
    expect(cfg.TWILIO_ACCOUNT_SID).toBe('AC_test');
    expect(cfg.TWILIO_WHATSAPP_NUMBER).toBe('whatsapp:+14155238886');
    expect(cfg.WHATSAPP_APPROVAL_TEMPLATE_SID).toBe('HX_approval');
  });

  it('the 4 new channel-send vars are undefined when unset — tolerate-absent (no throw)', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_WHATSAPP_NUMBER;
    delete process.env.WHATSAPP_APPROVAL_TEMPLATE_SID;
    const { getWorkerConfig } = await import('../worker');
    const cfg = getWorkerConfig();
    expect(cfg.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(cfg.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(cfg.TWILIO_WHATSAPP_NUMBER).toBeUndefined();
    expect(cfg.WHATSAPP_APPROVAL_TEMPLATE_SID).toBeUndefined();
  });

  it('the channel-send vars pass whitespace-only through RAW (rawOptionalVar #7)', async () => {
    // Each call site owns its own truthy/`!`/`X!`/`?? ''` guard on the raw value:
    // `if (!from) throw`, `if (!botToken) throw`, `if (!sid || !token) throw`,
    // `TWILIO_WHATSAPP_NUMBER!`, and the `?? ''` formatter default-params. A
    // whitespace `'   '` MUST stay truthy / survive byte-for-byte — the collapsing
    // optionalVar would map it to undefined and FLIP a guard. RED under
    // optionalVar, GREEN under rawOptionalVar.
    process.env = {
      ...CORE, NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '   ',
      TWILIO_ACCOUNT_SID: '   ',
      TWILIO_WHATSAPP_NUMBER: '   ',
      WHATSAPP_APPROVAL_TEMPLATE_SID: '   ',
    } as NodeJS.ProcessEnv;
    const { getWorkerConfig } = await import('../worker');
    const cfg = getWorkerConfig();
    expect(cfg.TELEGRAM_BOT_TOKEN).toBe('   ');
    expect(cfg.TWILIO_ACCOUNT_SID).toBe('   ');
    expect(cfg.TWILIO_WHATSAPP_NUMBER).toBe('   ');
    expect(cfg.WHATSAPP_APPROVAL_TEMPLATE_SID).toBe('   ');
  });

  it('resetWorkerConfigForTests clears the memo so the next read re-parses env', async () => {
    process.env = { ...CORE, NODE_ENV: 'test', OUTBOX_BATCH_SIZE: '50' } as NodeJS.ProcessEnv;
    const { getWorkerConfig, resetWorkerConfigForTests } = await import('../worker');
    expect(getWorkerConfig().OUTBOX_BATCH_SIZE).toBe('50');
    process.env.OUTBOX_BATCH_SIZE = '99';
    expect(getWorkerConfig().OUTBOX_BATCH_SIZE).toBe('50'); // still memoized
    resetWorkerConfigForTests();
    expect(getWorkerConfig().OUTBOX_BATCH_SIZE).toBe('99'); // re-parsed
  });
});
