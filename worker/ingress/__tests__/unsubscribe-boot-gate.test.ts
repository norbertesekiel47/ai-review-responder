import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/db/server', () => ({
  sql: { begin: vi.fn() },
  jsonb: (value: unknown) => value,
}));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

const SESSION_SECRET = 'test-session-cookie-secret-at-least-32-chars';

// Both config accessors memoize on first read, so each case needs a fresh module
// graph rather than a reset — the same convention the token module's own suite uses.
async function freshGate() {
  vi.resetModules();
  return import('../unsubscribe');
}

function stubDeployedLane(): void {
  vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
  vi.stubEnv('MOCK_EXTERNAL_APIS', '');
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Deviations D4, extended by quality review I2. Neither value the opt-out path
// depends on is asserted on a deployed lane today, and each absence fails in a way
// no operator would attribute to config: a missing secret makes every well-formed
// token look unknown, a missing app URL makes every human GET a 503 plus one
// Sentry event per request on an unauthenticated, unrate-limited route.
describe('assertUnsubscribeIngressConfigured', () => {
  it('fails the boot on a deployed lane when the token secret is missing', async () => {
    stubDeployedLane();
    vi.stubEnv('SESSION_COOKIE_SECRET', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.repworth.test');
    const { assertUnsubscribeIngressConfigured } = await freshGate();

    expect(() => assertUnsubscribeIngressConfigured()).toThrow(/SESSION_COOKIE_SECRET/);
    // The lane proof rides in the thrown message: this fires at boot, so a Sentry
    // tag or a log field would be the wrong place to explain it.
    expect(() => assertUnsubscribeIngressConfigured()).toThrow(
      /RAILWAY_ENVIRONMENT_NAME=production/,
    );
  });

  it('fails the boot on a deployed lane when the landing page origin is missing', async () => {
    stubDeployedLane();
    vi.stubEnv('SESSION_COOKIE_SECRET', SESSION_SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const { assertUnsubscribeIngressConfigured } = await freshGate();

    expect(() => assertUnsubscribeIngressConfigured()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('treats a whitespace-only landing page origin as missing', async () => {
    stubDeployedLane();
    vi.stubEnv('SESSION_COOKIE_SECRET', SESSION_SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '   ');
    const { assertUnsubscribeIngressConfigured } = await freshGate();

    // NEXT_PUBLIC_APP_URL is a raw passthrough in the worker schema, so '   ' is
    // truthy there — the gate must apply the SAME trim the redirect builder does
    // or it would pass boot and then throw once per request.
    expect(() => assertUnsubscribeIngressConfigured()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('passes on a deployed lane when both values are configured', async () => {
    stubDeployedLane();
    vi.stubEnv('SESSION_COOKIE_SECRET', SESSION_SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.repworth.test');
    const { assertUnsubscribeIngressConfigured } = await freshGate();

    expect(() => assertUnsubscribeIngressConfigured()).not.toThrow();
  });

  it('stays silent off a deployed lane and under mock mode', async () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SESSION_COOKIE_SECRET', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const undeployed = await freshGate();
    expect(() => undeployed.assertUnsubscribeIngressConfigured()).not.toThrow();

    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    vi.stubEnv('MOCK_EXTERNAL_APIS', 'true');
    const mocked = await freshGate();
    expect(() => mocked.assertUnsubscribeIngressConfigured()).not.toThrow();
  });

  it('worker/index.ts calls the ingress gate in its boot assertion block', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(
      path.join(path.resolve(__dirname, '../../..'), 'worker/index.ts'),
      'utf8',
    );
    expect(source).toContain('assertUnsubscribeIngressConfigured();');
  });
});
