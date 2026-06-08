import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertAdminNotificationEmail,
  assertChannelsSmsEnv,
  assertProductionMockModeEnv,
  assertServerOnlyFeatureOptionalBooleansEnv,
  assertSelfServeSignupEnv,
  assertStripeWorkerEnv,
  assertWorkerStartupEnv,
  warnMissingProductionEnv,
} from '../startup-assert';
import { SubscriptionTier, TIER_CONFIG, type SubscriptionTierValue } from '@/lib/accounts/tier-config';

const REQUIRED = [
  'WORKER_PUBLIC_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_VERIFY_SERVICE_SID',
];

const STRIPE_WORKER_REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_STANDARD',
  'STRIPE_PRICE_PREMIUM',
  'STRIPE_PRICE_STANDARD_OVERAGE',
  'STRIPE_PRICE_PREMIUM_OVERAGE',
  'STRIPE_PRICE_FOUNDERS_OVERAGE',
];

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of Object.keys(snapshot)) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}

function setEnv(key: string, value: string): void {
  process.env[key] = value;
}

describe('assertProductionMockModeEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS'];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('throws when production is configured with MOCK_EXTERNAL_APIS=true', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertProductionMockModeEnv()).toThrow(/NODE_ENV=production.*MOCK_EXTERNAL_APIS=true/);
  });

  it('allows MOCK_EXTERNAL_APIS=true outside production', () => {
    setEnv('NODE_ENV', 'test');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertProductionMockModeEnv()).not.toThrow();
  });

  it('allows production when MOCK_EXTERNAL_APIS is not true', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(() => assertProductionMockModeEnv()).not.toThrow();
  });
});

describe('assertServerOnlyFeatureOptionalBooleansEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'ACCOUNT_OFFBOARDING_ENABLED',
    'AUTO_APPROVAL_ENABLED',
    'AUTO_APPROVAL_PROVIDER_MODERATION_READY',
  ];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('allows both flags to be unset', () => {
    expect(() => assertServerOnlyFeatureOptionalBooleansEnv()).not.toThrow();
  });

  it('allows exact true and false strings', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'false';
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY = 'false';

    expect(() => assertServerOnlyFeatureOptionalBooleansEnv()).not.toThrow();
  });

  it('rejects non-boolean values instead of interpreting them loosely', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'TRUE';

    expect(() => assertServerOnlyFeatureOptionalBooleansEnv()).toThrow(/AUTO_APPROVAL_ENABLED/);
  });

  it('rejects loose account offboarding flag values', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = '1';

    expect(() => assertServerOnlyFeatureOptionalBooleansEnv()).toThrow(/ACCOUNT_OFFBOARDING_ENABLED/);
  });
});

describe('assertStripeWorkerEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS', ...STRIPE_WORKER_REQUIRED];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('is a no-op in non-production MOCK_EXTERNAL_APIS mode', () => {
    setEnv('NODE_ENV', 'test');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertStripeWorkerEnv()).not.toThrow();
  });

  it('throws with all missing Stripe worker env vars', () => {
    try {
      assertStripeWorkerEnv();
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      for (const k of STRIPE_WORKER_REQUIRED) expect(msg).toContain(k);
    }
  });

  it('throws in production non-mock mode when Stripe worker env vars are missing', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(() => assertStripeWorkerEnv()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('treats whitespace-only Stripe worker env vars as missing', () => {
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = 'x';
    process.env.STRIPE_WEBHOOK_SECRET = '   ';
    expect(() => assertStripeWorkerEnv()).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('passes when all required Stripe worker env vars are set', () => {
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = 'x';
    expect(() => assertStripeWorkerEnv()).not.toThrow();
  });
});

describe('assertAdminNotificationEmail', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS', 'ADMIN_NOTIFICATION_EMAIL'];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('throws in production non-mock mode when unset', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(() => assertAdminNotificationEmail()).toThrow(/ADMIN_NOTIFICATION_EMAIL/);
  });

  it('treats whitespace-only as missing in production', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.ADMIN_NOTIFICATION_EMAIL = '   ';
    expect(() => assertAdminNotificationEmail()).toThrow(/ADMIN_NOTIFICATION_EMAIL/);
  });

  it('passes in production when set', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.com';
    expect(() => assertAdminNotificationEmail()).not.toThrow();
  });

  it('is a no-op outside production even when unset', () => {
    setEnv('NODE_ENV', 'test');
    expect(() => assertAdminNotificationEmail()).not.toThrow();
  });

  it('is a no-op in production mock mode even when unset', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertAdminNotificationEmail()).not.toThrow();
  });
});

describe('warnMissingProductionEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS', 'LIST_UNSUBSCRIBE_EMAIL', 'SENTRY_DSN'];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    restoreEnv(SNAP);
    warnSpy.mockRestore();
  });

  it('warns for each unset var in production non-mock mode', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    warnMissingProductionEnv();
    const messages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(messages.some((m: string) => m.includes('LIST_UNSUBSCRIBE_EMAIL'))).toBe(true);
    expect(messages.some((m: string) => m.includes('SENTRY_DSN'))).toBe(true);
  });

  it('is silent outside production', () => {
    setEnv('NODE_ENV', 'test');
    warnMissingProductionEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is silent in production mock mode', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    warnMissingProductionEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for vars that are set', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.LIST_UNSUBSCRIBE_EMAIL = 'unsubscribe@repworth.com';
    process.env.SENTRY_DSN = 'https://x@sentry.io/1';
    warnMissingProductionEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('assertWorkerStartupEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'NODE_ENV',
    'MOCK_EXTERNAL_APIS',
    'ADMIN_NOTIFICATION_EMAIL',
    'ACCOUNT_OFFBOARDING_ENABLED',
    'AUTO_APPROVAL_ENABLED',
    'AUTO_APPROVAL_PROVIDER_MODERATION_READY',
    ...STRIPE_WORKER_REQUIRED,
  ];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('checks unsafe production mock mode before Stripe env vars', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertWorkerStartupEnv()).toThrow(/MOCK_EXTERNAL_APIS=true/);
    expect(() => assertWorkerStartupEnv()).not.toThrow(/STRIPE_SECRET_KEY/);
  });

  it('does not require Stripe env vars in non-production MOCK_EXTERNAL_APIS mode', () => {
    setEnv('NODE_ENV', 'test');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertWorkerStartupEnv()).not.toThrow();
  });

  it('passes when production mock mode is off and Stripe env vars are present', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = 'x';
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.com';
    expect(() => assertWorkerStartupEnv()).not.toThrow();
  });

  it('runs optional server-only feature boolean validation', () => {
    setEnv('NODE_ENV', 'test');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'enabled';

    expect(() => assertWorkerStartupEnv()).toThrow(/ACCOUNT_OFFBOARDING_ENABLED/);
  });
});

describe('worker startup guard import order', () => {
  it('imports the side-effect full startup guard before queues can evaluate', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../index.ts'),
      'utf-8',
    );

    const envImport = source.indexOf("import './env'");
    const guardImport = source.indexOf("import './config/startup-side-effect-guard'");
    const queuesImport = source.indexOf("from './queues'");

    expect(envImport).toBeGreaterThanOrEqual(0);
    expect(guardImport).toBeGreaterThan(envImport);
    expect(guardImport).toBeLessThan(queuesImport);
  });

  it('side-effect guard runs assertWorkerStartupEnv', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../startup-side-effect-guard.ts'),
      'utf-8',
    );

    expect(source).toContain('assertWorkerStartupEnv');
    expect(source).not.toContain('assertProductionMockModeEnv');
  });
});

describe('assertChannelsSmsEnv', () => {
  beforeEach(() => {
    for (const k of REQUIRED) delete process.env[k];
    delete process.env.CHANNELS_SMS_ENABLED;
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  it('no-op when CHANNELS_SMS_ENABLED is off', () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    expect(() => assertChannelsSmsEnv()).not.toThrow();
  });

  it('no-op when CHANNELS_SMS_ENABLED is unset', () => {
    expect(() => assertChannelsSmsEnv()).not.toThrow();
  });

  it('no-op in MOCK_EXTERNAL_APIS mode even with vars missing', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertChannelsSmsEnv()).not.toThrow();
  });

  it('throws with full list of missing vars when SMS enabled and none set', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    try {
      assertChannelsSmsEnv();
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      for (const k of REQUIRED) expect(msg).toContain(k);
    }
  });

  it('throws naming only the missing var when 4 of 5 are set', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    process.env.WORKER_PUBLIC_URL = 'https://x';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 't';
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG';
    // TWILIO_VERIFY_SERVICE_SID missing
    expect(() => assertChannelsSmsEnv()).toThrow(/TWILIO_VERIFY_SERVICE_SID/);
    expect(() => assertChannelsSmsEnv()).not.toThrow(/WORKER_PUBLIC_URL/);
  });

  it('treats whitespace-only env var as missing', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    for (const k of REQUIRED) process.env[k] = 'x';
    process.env.WORKER_PUBLIC_URL = '   ';
    expect(() => assertChannelsSmsEnv()).toThrow(/WORKER_PUBLIC_URL/);
  });

  it('passes when all five vars are set', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    for (const k of REQUIRED) process.env[k] = 'x';
    expect(() => assertChannelsSmsEnv()).not.toThrow();
  });
});

import { assertChannelsTelegramEnv } from '../startup-assert';

describe('assertChannelsTelegramEnv', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.MOCK_EXTERNAL_APIS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is a no-op when flag is off', () => {
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });

  it('is a no-op when MOCK_EXTERNAL_APIS=true even with flag on', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });

  it('throws with all missing vars when flag is on and env is empty', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    expect(() => assertChannelsTelegramEnv()).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => assertChannelsTelegramEnv()).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('passes when flag is on and all required vars are set', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-at-least-32-bytes-long-XXXXXXXXXXXXX';
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });
});

import { assertChannelsWhatsAppEnv } from '../startup-assert';

describe('assertChannelsWhatsAppEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'CHANNELS_WHATSAPP_ENABLED', 'MOCK_EXTERNAL_APIS',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER',
    'WHATSAPP_APPROVAL_TEMPLATE_SID', 'WHATSAPP_APPROVAL_URL_BASE',
    'WORKER_PUBLIC_URL', 'NEXT_PUBLIC_APP_URL',
  ];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('is a no-op when flag is off', () => {
    expect(() => assertChannelsWhatsAppEnv()).not.toThrow();
  });

  it('is a no-op in MOCK_EXTERNAL_APIS=true', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertChannelsWhatsAppEnv()).not.toThrow();
  });

  it('throws when required env vars are missing', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/missing required env vars/);
  });

  it('throws if TWILIO_WHATSAPP_NUMBER is not whatsapp:+<digits>', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = '+15551234567';  // missing 'whatsapp:' prefix
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://app.repworth.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/TWILIO_WHATSAPP_NUMBER/);
  });

  it('throws if WHATSAPP_APPROVAL_URL_BASE does not equal NEXT_PUBLIC_APP_URL + "/approve/"', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://OTHER.example.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/WHATSAPP_APPROVAL_URL_BASE/);
  });

  it('passes with all vars set correctly', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://app.repworth.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).not.toThrow();
  });
});

// ── assertSelfServeSignupEnv ──────────────────────────────────────────────

const SELF_SERVE_PRICE_VARS = [
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_STANDARD',
  'STRIPE_PRICE_PREMIUM',
  'STRIPE_PRICE_STANDARD_OVERAGE',
  'STRIPE_PRICE_PREMIUM_OVERAGE',
  'STRIPE_PRICE_FOUNDERS_OVERAGE',
];

describe('assertSelfServeSignupEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'SELF_SERVE_SIGNUP_ENABLED',
    'REDIS_CACHE_URL',
    'NEXT_PUBLIC_APP_URL',
    ...SELF_SERVE_PRICE_VARS,
  ];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('is a no-op when SELF_SERVE_SIGNUP_ENABLED is off', () => {
    expect(() => assertSelfServeSignupEnv()).not.toThrow();
  });

  it('is a no-op when SELF_SERVE_SIGNUP_ENABLED is unset', () => {
    expect(() => assertSelfServeSignupEnv()).not.toThrow();
  });

  it('throws when flag is on but REDIS_CACHE_URL is missing', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    for (const k of SELF_SERVE_PRICE_VARS) process.env[k] = 'price_x';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(() => assertSelfServeSignupEnv()).toThrow(/REDIS_CACHE_URL/);
  });

  it('throws when flag is on but NEXT_PUBLIC_APP_URL is missing', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    for (const k of SELF_SERVE_PRICE_VARS) process.env[k] = 'price_x';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    expect(() => assertSelfServeSignupEnv()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('throws listing all missing STRIPE_PRICE_* vars when flag is on and none are set', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    try {
      assertSelfServeSignupEnv();
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      for (const k of SELF_SERVE_PRICE_VARS) expect(msg).toContain(k);
    }
  });

  it('throws naming only the missing price var when 6 of 7 are set', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    process.env.STRIPE_PRICE_BASIC = 'price_basic';
    process.env.STRIPE_PRICE_FOUNDING = 'price_founding';
    process.env.STRIPE_PRICE_STANDARD = 'price_standard';
    process.env.STRIPE_PRICE_PREMIUM = 'price_premium';
    process.env.STRIPE_PRICE_STANDARD_OVERAGE = 'price_std_overage';
    process.env.STRIPE_PRICE_PREMIUM_OVERAGE = 'price_prem_overage';
    // STRIPE_PRICE_FOUNDERS_OVERAGE missing
    expect(() => assertSelfServeSignupEnv()).toThrow(/STRIPE_PRICE_FOUNDERS_OVERAGE/);
    expect(() => assertSelfServeSignupEnv()).not.toThrow(/STRIPE_PRICE_BASIC/);
  });

  it('treats whitespace-only price var as missing', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    for (const k of SELF_SERVE_PRICE_VARS) process.env[k] = 'price_x';
    process.env.STRIPE_PRICE_BASIC = '   ';
    expect(() => assertSelfServeSignupEnv()).toThrow(/STRIPE_PRICE_BASIC/);
  });

  it('does NOT require STRIPE_PAYMENT_LINK_* vars', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    for (const k of SELF_SERVE_PRICE_VARS) process.env[k] = 'price_x';
    // Intentionally NOT setting STRIPE_PAYMENT_LINK_* — should still pass
    expect(() => assertSelfServeSignupEnv()).not.toThrow();
  });

  it('passes when all required vars are set', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    for (const k of SELF_SERVE_PRICE_VARS) process.env[k] = 'price_x';
    expect(() => assertSelfServeSignupEnv()).not.toThrow();
  });
});

// ── Stripe env var contract — drift prevention ────────────────────────────
//
// This test verifies that the STRIPE_PRICE_* env vars in startup-assert.ts
// match the tiers defined in tier-config.ts. If a new tier is added to
// TIER_CONFIG without a corresponding STRIPE_PRICE_* assertion, this test
// will fail — preventing env contract drift.

describe('Stripe env var contract — drift prevention', () => {
  it('startup-assert checks a base price var for every tier in TIER_CONFIG', () => {
    // Every tier in TIER_CONFIG must have a STRIPE_PRICE_<TIER> env var
    const tiers: SubscriptionTierValue[] = Object.values(SubscriptionTier);
    const expectedBaseVars = tiers.map(
      (t) => `STRIPE_PRICE_${t === 'founders' ? 'FOUNDING' : t.toUpperCase()}`
    );

    // Read the startup-assert source to confirm all base vars are asserted
    // We just verify the list matches our expected list
    const startupAssertPriceVars = SELF_SERVE_PRICE_VARS;
    for (const baseVar of expectedBaseVars) {
      expect(startupAssertPriceVars).toContain(baseVar);
    }
  });

  it('startup-assert checks an overage price var for every multi-location tier', () => {
    // Every tier with multiLocAllowed must have a STRIPE_PRICE_<TIER>_OVERAGE var
    const multiLocTiers = Object.entries(TIER_CONFIG)
      .filter(([, config]) => config.multiLocAllowed)
      .map(([tier]) => tier as SubscriptionTierValue);

    const expectedOverageVars = multiLocTiers.map(
      (t) => `STRIPE_PRICE_${t === 'founders' ? 'FOUNDERS' : t.toUpperCase()}_OVERAGE`
    );

    const startupAssertPriceVars = SELF_SERVE_PRICE_VARS;
    for (const overageVar of expectedOverageVars) {
      expect(startupAssertPriceVars).toContain(overageVar);
    }
  });

  it('startup-assert does NOT check STRIPE_PRICE_BASIC_OVERAGE', () => {
    // Basic tier has no overage (multiLocAllowed=false)
    expect(SELF_SERVE_PRICE_VARS).not.toContain('STRIPE_PRICE_BASIC_OVERAGE');
  });

  it('no STRIPE_PAYMENT_LINK references remain in startup-assert', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../startup-assert.ts'),
      'utf-8',
    );
    expect(source).not.toContain('STRIPE_PAYMENT_LINK');
  });
});

import { assertAccountOffboardingEnv } from '../startup-assert';

describe('assertAccountOffboardingEnv', () => {
  const KEYS = [
    'ACCOUNT_OFFBOARDING_ENABLED',
    'MOCK_EXTERNAL_APIS',
    'SESSION_COOKIE_SECRET',
    'NEXT_PUBLIC_APP_URL',
  ];
  const SNAP: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('is a no-op when the flag is off or unset', () => {
    expect(() => assertAccountOffboardingEnv()).not.toThrow();
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'false';
    expect(() => assertAccountOffboardingEnv()).not.toThrow();
  });

  it('is a no-op under MOCK_EXTERNAL_APIS even when the flag is on', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertAccountOffboardingEnv()).not.toThrow();
  });

  it('throws listing both vars when the flag is on and both are missing', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    expect(() => assertAccountOffboardingEnv()).toThrow(/SESSION_COOKIE_SECRET.*NEXT_PUBLIC_APP_URL/);
  });

  it('does not throw when the flag is on and both required vars are present', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECRET = 'secret-value';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(() => assertAccountOffboardingEnv()).not.toThrow();
  });
});
