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
});
