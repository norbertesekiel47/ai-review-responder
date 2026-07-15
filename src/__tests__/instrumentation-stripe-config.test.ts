import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';

const sentry = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: sentry.captureMessage,
  captureRequestError: vi.fn(),
  init: sentry.init,
}));

import { register } from '@/instrumentation';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    NEXT_RUNTIME: 'nodejs',
    NODE_ENV: 'test',
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    STRIPE_SECRET_KEY: 'sk_test',
  };
  for (const priceEnv of STRIPE_PRICE_ENV_VARS) delete process.env[priceEnv];
  sentry.captureMessage.mockClear();
  sentry.init.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('Next Stripe config soft assertion', () => {
  it('reports every missing WS8 Price from the single owner list without throwing', async () => {
    await expect(register()).resolves.toBeUndefined();
    const message = String(sentry.captureMessage.mock.calls[0]?.[0]);
    for (const priceEnv of STRIPE_PRICE_ENV_VARS) expect(message).toContain(priceEnv);
  });

  it('reports duplicate configured Price IDs without exposing the duplicate value', async () => {
    for (const priceEnv of STRIPE_PRICE_ENV_VARS) {
      process.env[priceEnv] = `price_${priceEnv}`;
    }
    const duplicateValue = 'price_sensitive_duplicate';
    process.env.STRIPE_PRICE_COPILOT_LIST = duplicateValue;
    process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = duplicateValue;

    await expect(register()).resolves.toBeUndefined();
    const messages = sentry.captureMessage.mock.calls.map(([message]) => String(message));
    expect(messages).toContain(
      '[instrumentation] Stripe Price env vars contain duplicate IDs; billing lookups will fail closed until configuration is repaired.',
    );
    expect(messages.join(' ')).not.toContain(duplicateValue);
  });
});
