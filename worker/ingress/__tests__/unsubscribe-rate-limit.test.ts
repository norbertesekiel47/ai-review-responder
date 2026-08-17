import { readFileSync } from 'node:fs';
import net from 'node:net';
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
  sqlUnsubscribe: { begin: mockBegin },
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
import {
  buildUnsubscribeTestApp,
  REAL_HANDLER_INGRESS_PATH,
  SIBLING_INGRESS_PATHS,
  type UnsubscribeTestApp,
} from './helpers/unsubscribe-app';

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
    // Every path worker/index.ts registers, not one convenience stub. The hook is
    // general policy for all five providers and D11 records that its predecessor
    // was bypassable on every one of them, so a single-stub assertion under this
    // title claimed coverage the harness could not provide.
    const everyOtherIngressPath = [REAL_HANDLER_INGRESS_PATH, ...SIBLING_INGRESS_PATHS];

    for (const ingressPath of everyOtherIngressPath) {
      mockCheckRateLimit.mockClear();
      await harness.app.inject({ method: 'POST', url: ingressPath, payload: {} });
      expect(mockCheckRateLimit, ingressPath).toHaveBeenCalledTimes(1);
    }
    // The real Resend handler sits behind one of them, so the hook is proven to
    // run ahead of a genuine provider handler and not only ahead of a stub.
    expect(everyOtherIngressPath).toHaveLength(6);
  });

  it('the sibling ingress paths match the ones worker/index.ts registers', async () => {
    // The list above is only as good as its correspondence to the composition
    // root. A sixth provider added there with no entry here would silently drop
    // out of the matrix.
    const source = readFileSync(path.join(REPO_ROOT, 'worker/index.ts'), 'utf8');
    // flatMap, not map+filter: the capture group is `string | undefined` under
    // noUncheckedIndexedAccess, and narrowing here keeps the assertion honest —
    // a regex that stopped capturing would yield an empty set rather than a
    // TypeError, and the toEqual below would catch it.
    const registered = [...source.matchAll(/app\.(?:post|get)\('(\/ingress\/[^']*)'/g)]
      .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
      .filter((ingressPath) => !ingressPath.includes('unsubscribe'));

    expect(new Set(registered)).toEqual(
      new Set([REAL_HANDLER_INGRESS_PATH, ...SIBLING_INGRESS_PATHS]),
    );
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

/**
 * `app.inject()` cannot express this case — light-my-request normalizes the
 * request target — so it needs a real listener and a hand-written request line.
 * Resolves with the response status line.
 */
async function sendRawRequestLine(port: number, requestLine: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `${requestLine}\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    socket.on('end', () => resolve(buffer.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

describe('ingress rate-limit hook — absolute-form request targets', () => {
  it('enforces the ingress rate limit on an absolute-form request target', async () => {
    // RFC 9112 §3.2.2: an origin server MUST accept `POST http://host/path HTTP/1.1`.
    // find-my-way strips scheme+host before routing, so the route resolves — while
    // Fastify's request.url keeps the absolute string, making the decoded-raw arm
    // read false. ONLY the resolved-route arm sees this. Delete it and every
    // provider's limiter is bypassable by a one-token change to the request line.
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = harness.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a TCP port');

      const status = await sendRawRequestLine(
        address.port,
        `POST http://127.0.0.1:${address.port}/ingress/resend HTTP/1.1`,
      );

      // It really reaches the handler — the bypass would be worthless on a 404.
      // 401 is the REAL Resend handler rejecting an unsigned body, which is a
      // stronger witness than a stub's 200: routing resolved and a genuine
      // provider handler ran, both downstream of the hook under test.
      expect(status).toContain('401');
      expect(status).not.toContain('404');
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    } finally {
      // In a `finally` so an assertion failure cannot leak the listening port.
      await harness.app.close();
    }
  });

  it('still exempts the unsubscribe route when reached in absolute form', async () => {
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = harness.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a TCP port');

      const status = await sendRawRequestLine(
        address.port,
        `GET http://127.0.0.1:${address.port}/ingress/unsubscribe/${validToken} HTTP/1.1`,
      );

      // The exemption keys on resolved route config, so the absolute form cannot
      // accidentally re-throttle a statutory opt-out either.
      expect(status).toContain('302');
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });
});

describe('ingress rate-limit hook — wiring', () => {
  it('the unsubscribe route modules never import checkRateLimit', async () => {
    // §9.2 forbids throttling a statutory opt-out. Asserted structurally so a
    // future "just add a limiter here" cannot pass review by accident.
    //
    // ALL THREE modules, not just the worker's. The title says "modules" and it
    // used to read one file — while Vercel is the *more* likely place for the
    // mistake: `/api/*` is where every other mutating route in the app IS
    // limited, and the WAF runbook records that rule 1a already matches this
    // path. A limiter on the Vercel POST would violate §9.2 identically and the
    // guard would have stayed green.
    const UNSUBSCRIBE_ROUTE_MODULES = [
      'worker/ingress/unsubscribe.ts',
      'src/app/api/u/[token]/route.ts',
      'src/app/(public)/u/[token]/page.tsx',
    ];

    for (const modulePath of UNSUBSCRIBE_ROUTE_MODULES) {
      const source = readFileSync(path.join(REPO_ROOT, modulePath), 'utf8');
      expect(source, modulePath).not.toContain('checkRateLimit');
      expect(source, modulePath).not.toMatch(/from ['"][^'"]*rate-limit['"]/);
      // The Vercel-side equivalents §9.2 also forbids: BotID registration and an
      // explicit WAF challenge are throttles by another name on this path.
      expect(source, modulePath).not.toContain('checkBotId');
    }
  });

  it('worker/index.ts registers the hook through the limiter module', async () => {
    // The hook body is policy, not wiring: keeping it in the module is what lets
    // the matrix above exercise the REAL predicate rather than a copy of it.
    const source = readFileSync(path.join(REPO_ROOT, 'worker/index.ts'), 'utf8');
    expect(source).toContain('registerIngressRateLimitHook(app)');
    expect(source).not.toContain("request.url.startsWith('/ingress/')");
  });
});
