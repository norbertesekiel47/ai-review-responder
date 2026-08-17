import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertAdminNotificationEmail,
  assertAlertSinkEnv,
  assertCoreInfraEnv,
  assertProductionMockModeEnv,
  assertServerOnlyFeatureOptionalBooleansEnv,
  assertSelfServeSignupEnv,
  assertSingleConcurrencyWorker,
  assertStripeWorkerEnv,
  assertSummedLlmWorkerSlots,
  assertWorkerStartupEnv,
  warnMissingProductionEnv,
} from '../startup-assert';
import { SubscriptionTier, TIER_CONFIG } from '@/lib/accounts/tier-config';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import { TIER_COST_LIMIT_ENV_VARS } from '@/lib/costs/tier-cost-limits';
import { resetServerConfigForTests } from '@/lib/config/server';

const STRIPE_WORKER_REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  ...STRIPE_PRICE_ENV_VARS,
];

const CORE_INFRA_REQUIRED = [
  'DATABASE_POOL_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'REDIS_QUEUE_URL',
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

/**
 * String-keyed so it resolves through ProcessEnv's index signature. A literal
 * `delete process.env.NODE_ENV` does not compile — Next.js types NODE_ENV as a
 * read-only property.
 */
function deleteEnv(key: string): void {
  delete process.env[key];
}

/**
 * The exact configuration that made every production-only boot gate inert
 * (#611): the production Railway lane sets RAILWAY_ENVIRONMENT_NAME and leaves
 * NODE_ENV UNSET. Setting NODE_ENV='production' instead would prove nothing.
 *
 * Every KEYS list in this file carries 'RAILWAY_ENVIRONMENT_NAME' so a developer
 * shell that exports it cannot silently flip a verdict here.
 */
function enterProductionRailwayLane(): void {
  deleteEnv('NODE_ENV');
  setEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
}

describe('assertProductionMockModeEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'MOCK_EXTERNAL_APIS'];

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

  it('assertProductionMockModeEnv() rejects MOCK_EXTERNAL_APIS=true on the production Railway lane when NODE_ENV is unset', () => {
    enterProductionRailwayLane();
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertProductionMockModeEnv()).toThrow(
      /RAILWAY_ENVIRONMENT_NAME=production.*MOCK_EXTERNAL_APIS=true/,
    );
  });
});

describe('assertServerOnlyFeatureOptionalBooleansEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'RAILWAY_ENVIRONMENT_NAME',
    'ACCOUNT_OFFBOARDING_ENABLED',
    'AUTOPILOT_PURCHASABLE',
    'AUTO_APPROVAL_ENABLED',
    'AUTO_APPROVAL_PROVIDER_MODERATION_READY',
    'GOVERNOR_ENABLED',
    'JUDGE_ENABLED',
    'STRIPE_TAX_ENABLED',
  ];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('allows all optional flags to be unset', () => {
    expect(() => assertServerOnlyFeatureOptionalBooleansEnv()).not.toThrow();
  });

  it('allows exact true and false strings', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'false';
    process.env.AUTOPILOT_PURCHASABLE = 'true';
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY = 'false';
    process.env.GOVERNOR_ENABLED = 'true';
    process.env.JUDGE_ENABLED = 'false';
    process.env.STRIPE_TAX_ENABLED = 'true';

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

  it('rejects loose Autopilot sale flag values', () => {
    process.env.AUTOPILOT_PURCHASABLE = 'yes';

    expect(() => assertServerOnlyFeatureOptionalBooleansEnv()).toThrow(
      /AUTOPILOT_PURCHASABLE/,
    );
  });

  it.each(['JUDGE_ENABLED', 'GOVERNOR_ENABLED'] as const)(
    'rejects loose %s values',
    (key) => {
      process.env[key] = '1';

      expect(() => assertServerOnlyFeatureOptionalBooleansEnv()).toThrow(key);
    },
  );

});

describe('assertStripeWorkerEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'MOCK_EXTERNAL_APIS', ...STRIPE_WORKER_REQUIRED];

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
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = `value_${k}`;
    process.env.STRIPE_WEBHOOK_SECRET = '   ';
    expect(() => assertStripeWorkerEnv()).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('passes when all required Stripe worker env vars are set', () => {
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = `value_${k}`;
    expect(() => assertStripeWorkerEnv()).not.toThrow();
  });

  it('rejects duplicate Stripe Price IDs at worker startup', () => {
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = `value_${k}`;
    process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE =
      process.env.STRIPE_PRICE_COPILOT_LIST;
    expect(() => assertStripeWorkerEnv()).toThrow(/must be unique/);
  });

  it('assertStripeWorkerEnv() does not honour the mock-mode skip on a deployed lane', () => {
    enterProductionRailwayLane();
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertStripeWorkerEnv()).toThrow(/STRIPE_SECRET_KEY/);
  });
});

describe('assertAdminNotificationEmail', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'MOCK_EXTERNAL_APIS', 'ADMIN_NOTIFICATION_EMAIL'];

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

  it('assertAdminNotificationEmail() requires ADMIN_NOTIFICATION_EMAIL on the production Railway lane when NODE_ENV is unset', () => {
    enterProductionRailwayLane();
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(() => assertAdminNotificationEmail()).toThrow(/ADMIN_NOTIFICATION_EMAIL/);
  });
});

describe('assertAlertSinkEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'MOCK_EXTERNAL_APIS', 'SENTRY_DSN'];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('throws in production non-mock mode when SENTRY_DSN is unset', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(() => assertAlertSinkEnv()).toThrow(/SENTRY_DSN/);
  });

  it('treats whitespace-only as missing in production', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.SENTRY_DSN = '   ';
    expect(() => assertAlertSinkEnv()).toThrow(/SENTRY_DSN/);
  });

  it('passes in production when SENTRY_DSN is set', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.SENTRY_DSN = 'https://x@sentry.io/1';
    expect(() => assertAlertSinkEnv()).not.toThrow();
  });

  it('is a no-op outside production even when unset', () => {
    setEnv('NODE_ENV', 'test');
    expect(() => assertAlertSinkEnv()).not.toThrow();
  });

  it('is a no-op in production mock mode even when unset', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertAlertSinkEnv()).not.toThrow();
  });

  it('assertAlertSinkEnv() requires SENTRY_DSN on the production Railway lane when NODE_ENV is unset', () => {
    enterProductionRailwayLane();
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(() => assertAlertSinkEnv()).toThrow(/SENTRY_DSN/);
  });

  // The failure proof for #611 must survive the very outage it describes: when
  // SENTRY_DSN is what is missing, nothing Sentry-routed can explain the crash,
  // so the lane and its source have to be in the thrown message itself.
  it('assertAlertSinkEnv() names the resolved lane and its source in the failure message', () => {
    enterProductionRailwayLane();
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(() => assertAlertSinkEnv()).toThrow(/RAILWAY_ENVIRONMENT_NAME=production/);
  });
});

describe('warnMissingProductionEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'NODE_ENV',
    'RAILWAY_ENVIRONMENT_NAME',
    'MOCK_EXTERNAL_APIS',
    'LIST_UNSUBSCRIBE_EMAIL',
    'SENTRY_DSN',
  ];
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
    // SENTRY_DSN is now a hard assertion (assertAlertSinkEnv), not a warning.
    expect(messages.some((m: string) => m.includes('SENTRY_DSN'))).toBe(false);
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

describe('assertCoreInfraEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'MOCK_EXTERNAL_APIS', ...CORE_INFRA_REQUIRED];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('is a no-op in non-production MOCK_EXTERNAL_APIS mode', () => {
    setEnv('NODE_ENV', 'test');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertCoreInfraEnv()).not.toThrow();
  });

  it('throws naming the missing core-infra var in non-mock mode', () => {
    setEnv('NODE_ENV', 'test');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'svc';
    process.env.REDIS_QUEUE_URL = 'redis://localhost:6379';
    // DATABASE_POOL_URL intentionally unset.
    expect(() => assertCoreInfraEnv()).toThrow(/DATABASE_POOL_URL/);
  });

  it('passes when every core-infra var is present', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    for (const k of CORE_INFRA_REQUIRED) process.env[k] = 'x';
    expect(() => assertCoreInfraEnv()).not.toThrow();
  });

  it('assertCoreInfraEnv() does not honour the mock-mode skip on a deployed lane', () => {
    enterProductionRailwayLane();
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertCoreInfraEnv()).toThrow(/DATABASE_POOL_URL/);
  });
});

describe('assertWorkerStartupEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'NODE_ENV',
    'RAILWAY_ENVIRONMENT_NAME',
    'MOCK_EXTERNAL_APIS',
    'ADMIN_NOTIFICATION_EMAIL',
    'SENTRY_DSN',
    'ACCOUNT_OFFBOARDING_ENABLED',
    'AUTOPILOT_PURCHASABLE',
    'AUTO_APPROVAL_ENABLED',
    'AUTO_APPROVAL_PROVIDER_MODERATION_READY',
    'GOVERNOR_ENABLED',
    'JUDGE_ENABLED',
    'STRIPE_TAX_ENABLED',
    ...TIER_COST_LIMIT_ENV_VARS,
    ...STRIPE_WORKER_REQUIRED,
    ...CORE_INFRA_REQUIRED,
  ];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
    process.env.DAILY_COST_LIMIT_CENTS_COPILOT = '1000';
    process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '2000';
    resetServerConfigForTests();
  });
  afterEach(() => {
    restoreEnv(SNAP);
    resetServerConfigForTests();
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

  it('passes when production mock mode is off and Stripe + core-infra env vars are present', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = `value_${k}`;
    for (const k of CORE_INFRA_REQUIRED) process.env[k] = 'x';
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.com';
    process.env.SENTRY_DSN = 'https://x@sentry.io/1';
    expect(() => assertWorkerStartupEnv()).not.toThrow();
  });

  it('fails fast when a core-infra var is missing in production', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = `value_${k}`;
    for (const k of CORE_INFRA_REQUIRED) process.env[k] = 'x';
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.com';
    delete process.env.DATABASE_POOL_URL;
    expect(() => assertWorkerStartupEnv()).toThrow(/DATABASE_POOL_URL/);
  });

  it('runs optional server-only feature boolean validation', () => {
    setEnv('NODE_ENV', 'test');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'enabled';

    expect(() => assertWorkerStartupEnv()).toThrow(/ACCOUNT_OFFBOARDING_ENABLED/);
  });

  it.each(['JUDGE_ENABLED', 'GOVERNOR_ENABLED'] as const)(
    'rejects loose %s through the aggregate startup guard',
    (key) => {
      setEnv('NODE_ENV', 'test');
      process.env.MOCK_EXTERNAL_APIS = 'true';
      process.env[key] = 'enabled';

      expect(() => assertWorkerStartupEnv()).toThrow(key);
    },
  );

  it.each(TIER_COST_LIMIT_ENV_VARS)(
    'fails fast when required tier cost ceiling %s is missing',
    (key) => {
      setEnv('NODE_ENV', 'test');
      process.env.MOCK_EXTERNAL_APIS = 'true';
      delete process.env[key];
      resetServerConfigForTests();

      expect(() => assertWorkerStartupEnv()).toThrow(key);
    },
  );

  it('fails fast when a tier cost ceiling is malformed', () => {
    setEnv('NODE_ENV', 'test');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '0';
    resetServerConfigForTests();

    expect(() => assertWorkerStartupEnv()).toThrow(/DAILY_COST_LIMIT_CENTS_AUTOPILOT/);
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
    'CHANNELS_WHATSAPP_ENABLED', 'MOCK_EXTERNAL_APIS', 'RAILWAY_ENVIRONMENT_NAME',
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

  it('rejects a WORKER_PUBLIC_URL with a trailing slash', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://app.repworth.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com/';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/WORKER_PUBLIC_URL/);
  });

  it('rejects a WORKER_PUBLIC_URL with a query string', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://app.repworth.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com?x=1';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/WORKER_PUBLIC_URL/);
  });

  it('accepts a clean https WORKER_PUBLIC_URL', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://app.repworth.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).not.toThrow();
  });
});

import { assertZernioPublishingEnv } from '../startup-assert';

describe('assertZernioPublishingEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  // NODE_ENV joins the save/restore list because the deployed-lane test below
  // deletes it; without it the deletion would leak into every later describe.
  const KEYS = [
    'ZERNIO_PUBLISHING_ENABLED', 'MOCK_EXTERNAL_APIS',
    'NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME',
    'ZERNIO_API_KEY', 'ZERNIO_WEBHOOK_SECRET',
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

  it('rejects a WORKER_PUBLIC_URL with a trailing slash', () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    process.env.ZERNIO_API_KEY = 'api-key';
    process.env.ZERNIO_WEBHOOK_SECRET = 'webhook-secret';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com/';
    expect(() => assertZernioPublishingEnv()).toThrow(/WORKER_PUBLIC_URL/);
  });

  // Reaches the private assertWorkerPublicUrlFormat helper through its exported
  // entry point; assertChannelsWhatsAppEnv is the helper's other caller and
  // tightens identically.
  it('assertZernioPublishingEnv() rejects an http WORKER_PUBLIC_URL on the production Railway lane when NODE_ENV is unset', () => {
    enterProductionRailwayLane();
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    process.env.ZERNIO_API_KEY = 'api-key';
    process.env.ZERNIO_WEBHOOK_SECRET = 'webhook-secret';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    process.env.WORKER_PUBLIC_URL = 'http://worker.example.com';
    expect(() => assertZernioPublishingEnv()).toThrow(/WORKER_PUBLIC_URL/);
  });
});

// ── assertSelfServeSignupEnv ──────────────────────────────────────────────

const SELF_SERVE_PRICE_VARS = [...STRIPE_PRICE_ENV_VARS];

describe('assertSelfServeSignupEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'SELF_SERVE_SIGNUP_ENABLED',
    'RAILWAY_ENVIRONMENT_NAME',
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

  it('throws naming only the missing price var when 5 of 6 are set', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    process.env.STRIPE_PRICE_COPILOT_LIST = 'price_copilot_list';
    process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_copilot_founding';
    process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot_list';
    process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
    process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_copilot_overage';
    // STRIPE_PRICE_AUTOPILOT_OVERAGE missing
    expect(() => assertSelfServeSignupEnv()).toThrow(/STRIPE_PRICE_AUTOPILOT_OVERAGE/);
    expect(() => assertSelfServeSignupEnv()).not.toThrow(/STRIPE_PRICE_COPILOT_LIST/);
  });

  it('treats whitespace-only price var as missing', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    for (const k of SELF_SERVE_PRICE_VARS) process.env[k] = 'price_x';
    process.env.STRIPE_PRICE_COPILOT_LIST = '   ';
    expect(() => assertSelfServeSignupEnv()).toThrow(/STRIPE_PRICE_COPILOT_LIST/);
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
  it('startup-assert checks list and founding base Prices for both WS8 tiers', () => {
    const tiers = [SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT] as const;
    for (const tier of tiers) {
      expect(SELF_SERVE_PRICE_VARS).toContain(`STRIPE_PRICE_${tier.toUpperCase()}_LIST`);
      expect(SELF_SERVE_PRICE_VARS).toContain(`STRIPE_PRICE_${tier.toUpperCase()}_FOUNDING`);
    }
  });

  it('startup-assert checks one overage Price for each multi-location WS8 tier', () => {
    for (const tier of [SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT] as const) {
      expect(TIER_CONFIG[tier].multiLocAllowed).toBe(true);
      expect(SELF_SERVE_PRICE_VARS).toContain(
        `STRIPE_PRICE_${tier.toUpperCase()}_OVERAGE`,
      );
    }
  });

  it('startup-assert owns exactly six WS8 Price variables', () => {
    expect(SELF_SERVE_PRICE_VARS).toHaveLength(6);
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
    'RAILWAY_ENVIRONMENT_NAME',
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
    process.env.SESSION_COOKIE_SECRET = 'a'.repeat(32);
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(() => assertAccountOffboardingEnv()).not.toThrow();
  });

  it('throws when SESSION_COOKIE_SECRET is shorter than 32 bytes', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECRET = 'short';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(() => assertAccountOffboardingEnv()).toThrow(/SESSION_COOKIE_SECRET/);
  });

  it('accepts a SESSION_COOKIE_SECRET of at least 32 bytes', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECRET = 'a'.repeat(32);
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(() => assertAccountOffboardingEnv()).not.toThrow();
  });

  it('accepts a multibyte secret that is >=32 bytes even though its .length is < 32', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECRET = '€'.repeat(11); // 33 bytes, .length 11
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(() => assertAccountOffboardingEnv()).not.toThrow();
  });
});

import { assertSolicitationSendEnv } from '../startup-assert';

// #657 Task 2 — the solicitation Sending identity's boot gate. RED until
// `assertSolicitationSendEnv` exists. Copies the assertChannelsWhatsAppEnv shape
// exactly: flag gate, MOCK bypass, required-list check, then a format check that
// never logs the value.
//
// A worker that boots with sending enabled and no From address is a worker that
// fails at dispatch time instead of boot time — and a dispatch-time failure in
// this lane strands an approved batch mid-send.
describe('assertSolicitationSendEnv', () => {
  const SOLICITATION_REQUIRED = [
    'SOLICITATION_RESEND_API_KEY',
    'SOLICITATION_SEND_FROM_ADDRESS',
    'SOLICITATION_PLATFORM_DAILY_CAP',
    'SOLICITATION_UNSUBSCRIBE_MAILTO',
  ];
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'SOLICITATION_SEND_ENABLED',
    'MOCK_EXTERNAL_APIS',
    'RAILWAY_ENVIRONMENT_NAME',
    ...SOLICITATION_REQUIRED,
  ];
  const API_KEY_VALUE = 're_solicitation_boot_gate_secret_value';

  function setAllRequired(): void {
    process.env.SOLICITATION_RESEND_API_KEY = API_KEY_VALUE;
    process.env.SOLICITATION_SEND_FROM_ADDRESS = 'reviews@feedback.test.repworth.net';
    process.env.SOLICITATION_PLATFORM_DAILY_CAP = '250';
    process.env.SOLICITATION_UNSUBSCRIBE_MAILTO = 'unsubscribe@feedback.test.repworth.net';
  }

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('assertSolicitationSendEnv is a no-op when SOLICITATION_SEND_ENABLED is off', () => {
    // Unset and explicit-false are the same lane: no sends, so nothing to check.
    expect(() => assertSolicitationSendEnv()).not.toThrow();
    process.env.SOLICITATION_SEND_ENABLED = 'false';
    expect(() => assertSolicitationSendEnv()).not.toThrow();
  });

  it('assertSolicitationSendEnv is a no-op when MOCK_EXTERNAL_APIS is true', () => {
    process.env.SOLICITATION_SEND_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertSolicitationSendEnv()).not.toThrow();
  });

  it('assertSolicitationSendEnv throws naming every missing solicitation env var', () => {
    process.env.SOLICITATION_SEND_ENABLED = 'true';
    try {
      assertSolicitationSendEnv();
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      for (const k of SOLICITATION_REQUIRED) expect(msg).toContain(k);
    }

    // Whitespace-only is not a value — the same collapsing rule the config
    // schema applies to these four vars.
    setAllRequired();
    process.env.SOLICITATION_SEND_FROM_ADDRESS = '   ';
    expect(() => assertSolicitationSendEnv()).toThrow(/SOLICITATION_SEND_FROM_ADDRESS/);
  });

  it('assertSolicitationSendEnv accepts an explicit zero platform daily cap', () => {
    process.env.SOLICITATION_SEND_ENABLED = 'true';
    setAllRequired();
    process.env.SOLICITATION_PLATFORM_DAILY_CAP = '0';

    // 0 is the warm-up dial at rest and the emergency brake, not a
    // misconfiguration. Rejecting it would make the brake unusable.
    expect(() => assertSolicitationSendEnv()).not.toThrow();
  });

  it('assertSolicitationSendEnv throws on an unparseable platform daily cap', () => {
    process.env.SOLICITATION_SEND_ENABLED = 'true';
    setAllRequired();

    // Presence alone would let a typo reach dispatch, where §9's
    // "unparseable ⇒ 0" would silently stop every send.
    for (const bad of ['abc', '10/day', '1e3x', '2.5']) {
      process.env.SOLICITATION_PLATFORM_DAILY_CAP = bad;
      expect(() => assertSolicitationSendEnv()).toThrow(/SOLICITATION_PLATFORM_DAILY_CAP/);
    }
  });

  it('assertSolicitationSendEnv throws on a negative platform daily cap', () => {
    process.env.SOLICITATION_SEND_ENABLED = 'true';
    setAllRequired();
    process.env.SOLICITATION_PLATFORM_DAILY_CAP = '-1';

    expect(() => assertSolicitationSendEnv()).toThrow(/SOLICITATION_PLATFORM_DAILY_CAP/);
  });

  it('assertSolicitationSendEnv never logs the solicitation Resend API key', () => {
    const written: string[] = [];
    const capture = (...args: unknown[]): void => { written.push(args.map(String).join(' ')); };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(capture);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(capture);
    const thrownMessages: string[] = [];

    function messageOf(run: () => void): string {
      try {
        run();
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error('should have thrown');
    }

    try {
      process.env.SOLICITATION_SEND_ENABLED = 'true';
      setAllRequired();
      // The success path...
      assertSolicitationSendEnv();

      // ...and both failure paths, which are where a value is most likely to be
      // interpolated into a message. The assertion names the VAR, never the value.
      process.env.SOLICITATION_PLATFORM_DAILY_CAP = 'nope';
      thrownMessages.push(messageOf(() => assertSolicitationSendEnv()));

      setAllRequired();
      delete process.env.SOLICITATION_SEND_FROM_ADDRESS;
      thrownMessages.push(messageOf(() => assertSolicitationSendEnv()));
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(thrownMessages).toHaveLength(2);
    expect(thrownMessages[0]).toContain('SOLICITATION_PLATFORM_DAILY_CAP');
    expect(thrownMessages[1]).toContain('SOLICITATION_SEND_FROM_ADDRESS');
    for (const message of thrownMessages) {
      expect(message).not.toContain(API_KEY_VALUE);
    }
    expect(written.join('\n')).not.toContain(API_KEY_VALUE);
  });
});

describe('assertSingleConcurrencyWorker', () => {
  it('passes when the effective concurrency is exactly 1', () => {
    expect(() =>
      assertSingleConcurrencyWorker('update_stripe_overage', { concurrency: 1 }),
    ).not.toThrow();
  });

  it('throws at boot when the effective concurrency is greater than 1', () => {
    expect(() =>
      assertSingleConcurrencyWorker('update_stripe_overage', { concurrency: 5 }),
    ).toThrow(/update_stripe_overage.*concurrency: 1.*got 5/);
  });

  it('throws at boot when concurrency is missing from the effective options', () => {
    expect(() =>
      assertSingleConcurrencyWorker('update_stripe_overage', {}),
    ).toThrow(/got undefined/);
  });
});

describe('assertSummedLlmWorkerSlots', () => {
  const nonGatedAtNine = [
    { queueName: 'generate_response', opts: { concurrency: 5 } },
    { queueName: 'generate_demo', opts: {} },
    { queueName: 'weekly_summary', opts: {} },
    { queueName: 'send_monthly_impact', opts: {} },
    { queueName: 'onboarding_demo_response', opts: { concurrency: 1 } },
  ];

  it('passes when the non-flag-gated worker-slot sum is exactly 9 (mixed explicit/undefined opts)', () => {
    expect(() => assertSummedLlmWorkerSlots(nonGatedAtNine)).not.toThrow();
  });

  it('throws when the non-flag-gated sum reaches 10, naming the queues, the sum, and the cap', () => {
    const entries = [
      ...nonGatedAtNine,
      { queueName: 'extra_llm_queue', opts: {} },
    ];
    expect(() => assertSummedLlmWorkerSlots(entries)).toThrow(
      /generate_response.*extra_llm_queue.*10.*9/,
    );
  });

  it('counts undefined concurrency as 1 (BullMQ default)', () => {
    const nineBareWorkers = Array.from({ length: 9 }, (_, i) => ({
      queueName: `bare_queue_${i}`,
      opts: {},
    }));
    expect(() => assertSummedLlmWorkerSlots(nineBareWorkers)).not.toThrow();
    expect(() =>
      assertSummedLlmWorkerSlots([...nineBareWorkers, { queueName: 'bare_queue_9', opts: {} }]),
    ).toThrow(/10.*9/);
  });

  it('passes a flag-gated entry at 1 alongside a non-gated sum of 9', () => {
    const entries = [
      ...nonGatedAtNine,
      { queueName: 'judge_verdict', opts: { concurrency: 1 }, flagGated: true },
    ];
    expect(() => assertSummedLlmWorkerSlots(entries)).not.toThrow();
  });

  it('throws when a flag-gated entry exceeds 1', () => {
    const entries = [
      ...nonGatedAtNine,
      { queueName: 'judge_verdict', opts: { concurrency: 2 }, flagGated: true },
    ];
    expect(() => assertSummedLlmWorkerSlots(entries)).toThrow(/judge_verdict.*2.*1/);
  });

  it('fails boot on drift: the 5-slot queue edited to 6 pushes the sum to 10', () => {
    const drifted = nonGatedAtNine.map((entry) =>
      entry.queueName === 'generate_response'
        ? { ...entry, opts: { concurrency: 6 } }
        : entry,
    );
    expect(() => assertSummedLlmWorkerSlots(drifted)).toThrow(
      /generate_response.*10.*9/,
    );
  });

  it('passes the ADR 0005 flag-on envelope at exactly 11 (sum 9 + two flag-gated lanes)', () => {
    const entries = [
      ...nonGatedAtNine,
      { queueName: 'judge_verdict', opts: { concurrency: 1 }, flagGated: true },
      { queueName: 'generate_solicitation_asks', opts: { concurrency: 1 }, flagGated: true },
    ];
    expect(() => assertSummedLlmWorkerSlots(entries)).not.toThrow();
  });

  it('fails boot when a third flag-gated lane pushes the flag-on envelope to 12', () => {
    const entries = [
      ...nonGatedAtNine,
      { queueName: 'judge_verdict', opts: { concurrency: 1 }, flagGated: true },
      { queueName: 'generate_solicitation_asks', opts: { concurrency: 1 }, flagGated: true },
      { queueName: 'third_gated_lane', opts: {}, flagGated: true },
    ];
    expect(() => assertSummedLlmWorkerSlots(entries)).toThrow(
      /third_gated_lane.*flag-gated.*12.*flag-on envelope of 11/,
    );
  });
});
