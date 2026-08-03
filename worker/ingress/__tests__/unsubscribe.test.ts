import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The redemption core (T1b) is stubbed: this suite owns the ADAPTER's contract —
// outcome→status mapping, commit ordering, redaction, and the bounded telemetry.
// Database truth stays in src/lib/solicitation/__tests__/unsubscribe.integration.test.ts,
// which is where it can be asserted against a real Postgres.
const { mockBegin, mockRedeem, mockCaptureException } = vi.hoisted(() => ({
  mockBegin: vi.fn(),
  mockRedeem: vi.fn(),
  mockCaptureException: vi.fn(),
}));

vi.mock('../../../src/lib/db/server', () => ({
  sql: { begin: mockBegin },
  jsonb: (value: unknown) => value,
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
vi.mock('../../../src/lib/solicitation/unsubscribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/solicitation/unsubscribe')>();
  // Only the DB-touching function is stubbed — the HMAC admission gate stays
  // real, so every "valid token" below is one the shipped minter produced.
  return { ...actual, redeemUnsubscribeToken: mockRedeem };
});

import { resetServerConfigForTests } from '../../../src/lib/config/server';
import { resetWorkerConfigForTests } from '../../../src/lib/config/worker';
import { mintUnsubscribeRawToken } from '../../../src/lib/solicitation/unsubscribe';
import { buildUnsubscribeTestApp, type UnsubscribeTestApp } from './helpers/unsubscribe-app';

const SESSION_SECRET = 'test-session-cookie-secret-at-least-32-chars';
const APP_URL = 'https://app.repworth.test';
const REPO_ROOT = path.resolve(__dirname, '../../..');

const TX = Symbol('tx');

type ConsoleSink = { lines: () => string; restore: () => void };

/** createWorkerLogger writes JSON through console.*, not through Fastify's pino. */
function captureWorkerLog(): ConsoleSink {
  const captured: string[] = [];
  const record = (...args: unknown[]): void => {
    captured.push(args.map((arg) => String(arg)).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
  ];
  return {
    lines: () => captured.join('\n'),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

function workerLogRecords(sink: ConsoleSink): Array<Record<string, unknown>> {
  return sink
    .lines()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let harness: UnsubscribeTestApp;
let validToken: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('SESSION_COOKIE_SECRET', SESSION_SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
  resetServerConfigForTests();
  resetWorkerConfigForTests();

  mockBegin.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(TX));
  mockRedeem.mockResolvedValue({ status: 'redeemed', tokenHashPrefix: 'a1b2c3d4e5f6' });

  validToken = mintUnsubscribeRawToken();
  harness = buildUnsubscribeTestApp({ productionConfigRequired: true });
});

afterEach(async () => {
  await harness.close();
  vi.unstubAllEnvs();
  resetServerConfigForTests();
  resetWorkerConfigForTests();
});

function postToken(token: string, payload?: string) {
  return harness.app.inject({
    method: 'POST',
    url: `/ingress/unsubscribe/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: payload ?? 'List-Unsubscribe=One-Click',
  });
}

describe('unsubscribe ingress — POST', () => {
  it('returns 200 only after the suppression row commits', async () => {
    // §9.1's hardest requirement: a 2xx on an uncommitted write is a lost opt-out
    // the provider believes it delivered. Assert the ORDER, not just the status —
    // a handler that replied from inside the transaction callback would still
    // return 200 and would still be wrong.
    const order: string[] = [];
    mockRedeem.mockImplementation(async () => {
      order.push('redeem');
      return { status: 'redeemed', tokenHashPrefix: 'a1b2c3d4e5f6' };
    });
    mockBegin.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      const result = await run(TX);
      order.push('commit');
      return result;
    });
    harness.app.addHook('onSend', async () => {
      order.push('reply');
    });

    const response = await postToken(validToken);

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['redeem', 'commit', 'reply']);
  });

  it('returns 5xx and reports to Sentry when the ledger write fails', async () => {
    const sink = captureWorkerLog();
    try {
      mockRedeem.mockRejectedValue(new Error('ledger write exploded'));
      const response = await postToken(validToken);

      expect(response.statusCode).toBe(503);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      const [reported] = mockCaptureException.mock.calls[0] as [Error];
      expect(reported.message).toContain('ledger write exploded');
    } finally {
      sink.restore();
    }
  });

  it('a repeat POST of the same token is a 200 no-op and writes no second row', async () => {
    const sink = captureWorkerLog();
    try {
      mockRedeem
        .mockResolvedValueOnce({ status: 'redeemed', tokenHashPrefix: 'a1b2c3d4e5f6' })
        .mockResolvedValueOnce({ status: 'already_suppressed', tokenHashPrefix: 'a1b2c3d4e5f6' });

      const first = await postToken(validToken);
      const second = await postToken(validToken);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // One transaction per request and no retry loop: whether a second ledger row
      // exists is decided by redeemUnsubscribeToken's claim-first ordering, and the
      // adapter must not second-guess it by re-running the redemption.
      expect(mockBegin).toHaveBeenCalledTimes(2);
      expect(mockRedeem).toHaveBeenCalledTimes(2);
    } finally {
      sink.restore();
    }
  });

  it('an unknown token returns 503 and emits no per-request log line', async () => {
    const sink = captureWorkerLog();
    try {
      mockRedeem.mockResolvedValue({ status: 'unknown_token', tokenHashPrefix: 'deadbeef0000' });
      const response = await postToken(validToken);

      expect(response.statusCode).toBe(503);
      // §1.6: the route is unauthenticated AND unrate-limited, so a line per
      // unknown token is an amplification vector. Counted only.
      expect(workerLogRecords(sink)).toEqual([]);
    } finally {
      sink.restore();
    }
  });

  it('does not report an unknown token to Sentry', async () => {
    const sink = captureWorkerLog();
    try {
      mockRedeem.mockResolvedValue({ status: 'unknown_token', tokenHashPrefix: 'deadbeef0000' });
      await postToken(validToken);
      // Worker Sentry has no error sampling and no dedup, so scanner traffic
      // treated as an exception is unbounded event volume.
      expect(mockCaptureException).not.toHaveBeenCalled();
    } finally {
      sink.restore();
    }
  });

  it('a forged token never opens a transaction', async () => {
    const sink = captureWorkerLog();
    try {
      const response = await postToken('forged.token');
      expect(response.statusCode).toBe(503);
      // §1.4a: the admission gate runs FIRST, so a forged string costs one HMAC
      // compare and no connection at all.
      expect(mockBegin).not.toHaveBeenCalled();
      expect(mockRedeem).not.toHaveBeenCalled();
    } finally {
      sink.restore();
    }
  });

  it('returns 503 without letting the raw token reach the error log', async () => {
    const sink = captureWorkerLog();
    try {
      // The realistic leak: an error whose own text carries the request URL.
      mockRedeem.mockRejectedValue(
        new Error(`boom while redeeming /ingress/unsubscribe/${validToken}`),
      );
      const response = await postToken(validToken);

      expect(response.statusCode).toBe(503);
      expect(sink.lines()).not.toContain(validToken);
      expect(harness.rawFastifyLog()).not.toContain(validToken);
      const [reported] = mockCaptureException.mock.calls[0] as [Error];
      expect(reported.message).not.toContain(validToken);
      expect(String(reported.stack)).not.toContain(validToken);
    } finally {
      sink.restore();
    }
  });

  it('never logs the raw token or the raw handle', async () => {
    const sink = captureWorkerLog();
    try {
      mockRedeem.mockResolvedValue({ status: 'redeemed', tokenHashPrefix: 'a1b2c3d4e5f6' });
      await postToken(validToken);

      const records = workerLogRecords(sink);
      expect(records).toHaveLength(1);
      // §9.5: the token_hash prefix is the only loggable form. Note the field is
      // `hash_prefix`, not `token_hash_prefix` — createWorkerLogger routes object
      // args through the analytics blocked-key sanitizer, which DROPS any key
      // containing "token", so the correlating value would silently vanish.
      expect(records[0]?.data).toEqual({ outcome: 'redeemed', hash_prefix: 'a1b2c3d4e5f6' });
      expect(sink.lines()).not.toContain(validToken);
      expect(sink.lines()).not.toContain('@');
    } finally {
      sink.restore();
    }
  });

  it('parses an RFC 8058 form-urlencoded body and ignores its contents', async () => {
    const sink = captureWorkerLog();
    try {
      const canonical = await postToken(validToken, 'List-Unsubscribe=One-Click');
      const junk = await postToken(validToken, 'anything=at&all=here');

      expect(canonical.statusCode).toBe(200);
      expect(junk.statusCode).toBe(200);
      // The token comes from the path, never the body — both requests redeem the
      // same token with the same source.
      for (const call of mockRedeem.mock.calls) {
        expect(call[1]).toEqual({ rawToken: validToken, source: 'unsubscribe_one_click' });
      }
    } finally {
      sink.restore();
    }
  });

  it('an oversized request body is rejected before the handler runs', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/ingress/unsubscribe/${validToken}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `List-Unsubscribe=${'x'.repeat(2048)}`,
    });

    expect(response.statusCode).toBe(413);
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it('redeems and writes a ledger row while SOLICITATION_SEND_ENABLED is off', async () => {
    const sink = captureWorkerLog();
    try {
      // DR1: the flag masters SENDING only. Redemption stays fully live when it is
      // off — a delivered link must keep working after sending is paused.
      vi.stubEnv('SOLICITATION_SEND_ENABLED', 'false');
      resetServerConfigForTests();
      resetWorkerConfigForTests();

      const response = await postToken(validToken);

      expect(response.statusCode).toBe(200);
      expect(mockRedeem).toHaveBeenCalledTimes(1);
      // Structural, not incidental: nothing on this path may read the flag.
      const source = readFileSync(path.join(REPO_ROOT, 'worker/ingress/unsubscribe.ts'), 'utf8');
      expect(source).not.toContain('SOLICITATION_SEND_ENABLED');
      expect(source).not.toContain('solicitationSendEnabled');
    } finally {
      sink.restore();
    }
  });
});

describe('unsubscribe ingress — GET', () => {
  it('GET redirects to the landing page with a 302', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/ingress/unsubscribe/${validToken}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${APP_URL}/u/${encodeURIComponent(validToken)}`);
    // The redirect writes nothing — §5.4's neutral page decides what the human sees.
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it('encodes reserved characters when building the landing page redirect', async () => {
    // Fastify decodes the path parameter, so a token delivered as `a%2Fb` arrives
    // as `a/b`. Re-encoding is load-bearing: without it the redirect target is a
    // TWO-segment path that 404s instead of reaching the neutral page.
    const response = await harness.app.inject({
      method: 'GET',
      url: '/ingress/unsubscribe/a%2Fb%3Fc%23d',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${APP_URL}/u/a%2Fb%3Fc%23d`);
  });
});

describe('unsubscribe ingress — logging', () => {
  it('does not emit any request log line for the unsubscribe routes', async () => {
    // `logLevel: 'silent'` on the route, driven at the INFO lane where Fastify
    // would otherwise write `incoming request` before onRequest and before the
    // handler, copying the raw URL verbatim.
    const infoHarness = buildUnsubscribeTestApp({ productionConfigRequired: false });
    const sink = captureWorkerLog();
    try {
      await infoHarness.app.inject({ method: 'GET', url: `/ingress/unsubscribe/${validToken}` });
      await infoHarness.app.inject({
        method: 'POST',
        url: `/ingress/unsubscribe/${validToken}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });
      expect(infoHarness.fastifyLogLines()).toEqual([]);

      // A sibling provider still logs — the silencing is scoped, not global.
      await infoHarness.app.inject({ method: 'POST', url: '/ingress/resend', payload: {} });
      expect(infoHarness.fastifyLogLines().length).toBeGreaterThan(0);
    } finally {
      sink.restore();
      await infoHarness.close();
    }
  });

  it('an unmatched path carrying a real token never logs the raw token', async () => {
    // The case route-level silencing can NEVER reach: an unmatched path resolves
    // to no route, so it carries no route config. Only the global request
    // serializer + redact rule cover it.
    const infoHarness = buildUnsubscribeTestApp({ productionConfigRequired: false });
    const sink = captureWorkerLog();
    try {
      const response = await infoHarness.app.inject({
        method: 'GET',
        url: `/ingress/unsubscribe/${validToken}/extra`,
      });

      expect(response.statusCode).toBe(404);
      expect(infoHarness.rawFastifyLog()).not.toContain(validToken);
      expect(infoHarness.rawFastifyLog()).toContain('/ingress/unsubscribe/[REDACTED]');
    } finally {
      sink.restore();
      await infoHarness.close();
    }
  });

  it('request logging enabled still never emits a raw unsubscribe token', async () => {
    // Explicitly at the INFO lane. The production default of `warn` hides the
    // level-30 shapes, which is exactly what let this class survive several
    // reviews — so the assertion has to run with logging turned up, not down.
    const infoHarness = buildUnsubscribeTestApp({ productionConfigRequired: false });
    const sink = captureWorkerLog();
    try {
      mockRedeem.mockRejectedValue(new Error(`boom at /ingress/unsubscribe/${validToken}`));

      await infoHarness.app.inject({
        method: 'POST',
        url: `/ingress/unsubscribe/${validToken}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });
      await infoHarness.app.inject({ method: 'GET', url: `/ingress/unsubscribe/${validToken}` });
      await infoHarness.app.inject({
        method: 'GET',
        url: `/ingress/unsubscribe/${validToken}/extra`,
      });

      expect(infoHarness.rawFastifyLog()).not.toContain(validToken);
      expect(sink.lines()).not.toContain(validToken);
    } finally {
      sink.restore();
      await infoHarness.close();
    }
  });
});
