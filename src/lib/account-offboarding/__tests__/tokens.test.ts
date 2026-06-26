import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// tokens.ts → session-cookie-secret.ts now reads SESSION_COOKIE_SECRET via the
// memoized getServerConfig(). Stub the secret, reset modules, then dynamically
// import so the config memo re-parses the per-test value (Stage-3 convention #6).
// Every assertion below is unchanged.
async function freshTokens() {
  vi.resetModules();
  return import('../tokens');
}

describe('account offboarding tokens', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('SESSION_COOKIE_SECRET', 'test-session-cookie-secret-at-least-32-chars');
  });

  it('hashes raw tokens with SHA-256 hex', async () => {
    const { hashAccountOffboardingToken } = await freshTokens();
    expect(hashAccountOffboardingToken('raw-token-1')).toBe(
      createHash('sha256').update('raw-token-1').digest('hex'),
    );
    expect(hashAccountOffboardingToken('raw-token-1')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('derives the same raw keep-my-data token for the same offboarding delivery', async () => {
    const { createKeepMyDataRawToken } = await freshTokens();
    const first = createKeepMyDataRawToken({
      accountOffboardingId: '22222222-2222-4222-8222-222222222222',
      deliveryId: '33333333-3333-4333-8333-333333333333',
    });
    const second = createKeepMyDataRawToken({
      accountOffboardingId: '22222222-2222-4222-8222-222222222222',
      deliveryId: '33333333-3333-4333-8333-333333333333',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('changes the raw token when the offboarding delivery changes', async () => {
    const { createKeepMyDataRawToken } = await freshTokens();
    const first = createKeepMyDataRawToken({
      accountOffboardingId: '22222222-2222-4222-8222-222222222222',
      deliveryId: '33333333-3333-4333-8333-333333333333',
    });
    const second = createKeepMyDataRawToken({
      accountOffboardingId: '22222222-2222-4222-8222-222222222222',
      deliveryId: '44444444-4444-4444-8444-444444444444',
    });

    expect(second).not.toBe(first);
  });

  it('fails closed when the signing secret is missing', async () => {
    // Force the secret falsy explicitly — unstubAllEnvs() restores the ambient
    // process.env value, which is SET in CI (workflow env), so it would not be
    // "missing" there. Stubbing empty makes this deterministic in any environment.
    vi.stubEnv('SESSION_COOKIE_SECRET', '');
    const { assertKeepMyDataTokenSecretConfigured, createKeepMyDataRawToken } = await freshTokens();

    expect(() => assertKeepMyDataTokenSecretConfigured()).toThrow(
      /SESSION_COOKIE_SECRET/,
    );
    expect(() => createKeepMyDataRawToken({
      accountOffboardingId: '22222222-2222-4222-8222-222222222222',
      deliveryId: '33333333-3333-4333-8333-333333333333',
    })).toThrow(/SESSION_COOKIE_SECRET/);
  });
});
