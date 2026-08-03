import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCheckRateLimit, mockBegin, mockRedeem } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockBegin: vi.fn(),
  mockRedeem: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('../../../src/lib/db/server', () => ({
  sql: { begin: mockBegin },
  jsonb: (value: unknown) => value,
}));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
vi.mock('../../../src/lib/solicitation/unsubscribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/solicitation/unsubscribe')>();
  return { ...actual, redeemUnsubscribeToken: mockRedeem };
});

import { resetServerConfigForTests } from '../../../src/lib/config/server';
import { resetWorkerConfigForTests } from '../../../src/lib/config/worker';
import { mintUnsubscribeRawToken } from '../../../src/lib/solicitation/unsubscribe';
import { buildUnsubscribeTestApp, type UnsubscribeTestApp } from './helpers/unsubscribe-app';

const SESSION_SECRET = 'test-session-cookie-secret-at-least-32-chars';
const REPO_ROOT = path.resolve(__dirname, '../../..');

let harness: UnsubscribeTestApp;
let validToken: string;
let consoleSpies: Array<{ mockRestore: () => void }>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('SESSION_COOKIE_SECRET', SESSION_SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.repworth.test');
  resetServerConfigForTests();
  resetWorkerConfigForTests();

  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
  mockBegin.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run({}));
  mockRedeem.mockResolvedValue({ status: 'redeemed', tokenHashPrefix: 'a1b2c3d4e5f6' });

  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];

  validToken = mintUnsubscribeRawToken();
  harness = buildUnsubscribeTestApp({ productionConfigRequired: true });
});

afterEach(async () => {
  await harness.close();
  consoleSpies.forEach((spy) => spy.mockRestore());
  vi.unstubAllEnvs();
  resetServerConfigForTests();
  resetWorkerConfigForTests();
});

// The whole matrix runs through a real router: the previous raw-URL predicate
// would have passed any unit test of the string check while `/%69ngress/resend`
// escaped the limiter in production.
describe('ingress rate-limit hook — the unsubscribe exemption', () => {
  it('does not enforce the ingress rate limit on the unsubscribe path', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/ingress/unsubscribe/${validToken}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('exempts the unsubscribe GET route and its inherited HEAD route from the ingress rate limit', async () => {
    // Fastify auto-creates HEAD from the GET route and it inherits the GET
    // route's options — including the exemption. Revision 2's defect was scope:
    // it flagged only app.post, leaving the GET redirect and its HEAD throttled.
    const get = await harness.app.inject({
      method: 'GET',
      url: `/ingress/unsubscribe/${validToken}`,
    });
    const head = await harness.app.inject({
      method: 'HEAD',
      url: `/ingress/unsubscribe/${validToken}`,
    });

    expect(get.statusCode).toBe(302);
    expect(head.statusCode).toBe(302);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('routes a percent-encoded unsubscribe path without enforcing the rate limit', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/ingress/%75nsubscribe/${validToken}`,
    });

    // It really routes — the exemption would be worthless on a 404.
    expect(response.statusCode).toBe(302);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('ingress rate-limit hook — everything else stays throttled', () => {
  it('still enforces the ingress rate limit on every other ingress path', async () => {
    await harness.app.inject({ method: 'POST', url: '/ingress/resend', payload: {} });
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('still enforces the ingress rate limit on a percent-encoded ingress root path', async () => {
    // The live pre-existing bypass this ticket closes: `/%69ngress/resend`
    // reaches the real route while failing a raw `startsWith('/ingress/')` test.
    await harness.app.inject({ method: 'POST', url: '/%69ngress/resend', payload: {} });
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('still enforces the ingress rate limit on an unmatched percent-encoded ingress path', async () => {
    // routeOptions.url is undefined here, so only the decoded-raw arm can catch
    // it. A resolved-route-only test would drop every 404 out of the hook and
    // reopen an unthrottled flood namespace.
    const response = await harness.app.inject({ method: 'GET', url: '/%69ngress/bogus' });

    expect(response.statusCode).toBe(404);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('enforces the ingress rate limit on an unmatched path under the unsubscribe prefix', async () => {
    // The exemption keys STRICTLY on resolved route config, so a trailing segment
    // — which resolves to the empty 404 context — cannot inherit it.
    const response = await harness.app.inject({
      method: 'GET',
      url: `/ingress/unsubscribe/${validToken}/extra`,
    });

    expect(response.statusCode).toBe(404);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('leaves non-ingress routes untouched by the limiter', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('short-circuits with 429 when the limiter denies a throttled ingress path', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const response = await harness.app.inject({ method: 'POST', url: '/ingress/resend', payload: {} });

    expect(response.statusCode).toBe(429);
  });
});

describe('ingress rate-limit hook — wiring', () => {
  it('the unsubscribe route modules never import checkRateLimit', async () => {
    // §9.2 forbids throttling a statutory opt-out. Asserted structurally so a
    // future "just add a limiter here" cannot pass review by accident.
    const source = readFileSync(path.join(REPO_ROOT, 'worker/ingress/unsubscribe.ts'), 'utf8');
    expect(source).not.toContain('checkRateLimit');
    expect(source).not.toMatch(/from ['"][^'"]*rate-limit['"]/);
  });

  it('worker/index.ts registers the hook through the limiter module', async () => {
    // The hook body is policy, not wiring: keeping it in the module is what lets
    // the matrix above exercise the REAL predicate rather than a copy of it.
    const source = readFileSync(path.join(REPO_ROOT, 'worker/index.ts'), 'utf8');
    expect(source).toContain('registerIngressRateLimitHook(app)');
    expect(source).not.toContain("request.url.startsWith('/ingress/')");
  });
});
