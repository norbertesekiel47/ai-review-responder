import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Deviations D4. The gate exists because a worker missing SESSION_COOKIE_SECRET
// boots perfectly clean today and then 503s every well-formed opt-out forever,
// with no boot signal and no symptom distinguishable from a genuine unknown
// token. These tests pin both halves: it fires on a deployed lane, and it stays
// silent everywhere a developer or CI would otherwise be broken by it.
async function freshUnsubscribe() {
  vi.resetModules();
  return import('../unsubscribe');
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertUnsubscribeTokenSecretConfigured', () => {
  it('fails the boot on a deployed lane when the token secret is missing', async () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    vi.stubEnv('MOCK_EXTERNAL_APIS', '');
    vi.stubEnv('SESSION_COOKIE_SECRET', '');
    const { assertUnsubscribeTokenSecretConfigured } = await freshUnsubscribe();

    expect(() => assertUnsubscribeTokenSecretConfigured()).toThrow(/SESSION_COOKIE_SECRET/);
    // The lane proof has to ride in the thrown message: this fires at boot, so a
    // Sentry tag or a log field would be the wrong place to explain it.
    expect(() => assertUnsubscribeTokenSecretConfigured()).toThrow(
      /RAILWAY_ENVIRONMENT_NAME=production/,
    );
  });

  it('rejects a secret too short to be a 256-bit HMAC key', async () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    vi.stubEnv('MOCK_EXTERNAL_APIS', '');
    vi.stubEnv('SESSION_COOKIE_SECRET', 'too-short');
    const { assertUnsubscribeTokenSecretConfigured } = await freshUnsubscribe();

    expect(() => assertUnsubscribeTokenSecretConfigured()).toThrow(/at least 32 bytes/);
  });

  it('passes on a deployed lane when the secret is configured', async () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    vi.stubEnv('MOCK_EXTERNAL_APIS', '');
    vi.stubEnv('SESSION_COOKIE_SECRET', 'test-session-cookie-secret-at-least-32-chars');
    const { assertUnsubscribeTokenSecretConfigured } = await freshUnsubscribe();

    expect(() => assertUnsubscribeTokenSecretConfigured()).not.toThrow();
  });

  it('stays silent off a deployed lane and under mock mode', async () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SESSION_COOKIE_SECRET', '');
    const undeployed = await freshUnsubscribe();
    expect(() => undeployed.assertUnsubscribeTokenSecretConfigured()).not.toThrow();

    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    vi.stubEnv('MOCK_EXTERNAL_APIS', 'true');
    const mocked = await freshUnsubscribe();
    expect(() => mocked.assertUnsubscribeTokenSecretConfigured()).not.toThrow();
  });
});
