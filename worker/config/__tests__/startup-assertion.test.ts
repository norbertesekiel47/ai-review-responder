import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertChannelsSmsEnv, assertSelfServeSignupEnv } from '../startup-assert';
import { SubscriptionTier, TIER_CONFIG, type SubscriptionTierValue } from '@/lib/accounts/tier-config';

const REQUIRED = [
  'WORKER_PUBLIC_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_VERIFY_SERVICE_SID',
];

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
