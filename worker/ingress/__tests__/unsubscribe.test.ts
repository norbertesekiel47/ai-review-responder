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
import {
  hashUnsubscribeToken,
  mintUnsubscribeRawToken,
} from '../../../src/lib/solicitation/unsubscribe';
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

      // The failure line is the one that MOST needs correlating — an infra failure
      // is exactly when a provider retries and someone must match the retry to its
      // first attempt (intake observability[0]).
      const records = workerLogRecords(sink);
      expect(records).toHaveLength(1);
      expect(records[0]?.data).toMatchObject({
        outcome: 'failed',
        stage: 'redeem',
        hash_prefix: hashUnsubscribeToken(validToken).slice(0, 12),
      });
      expect(sink.lines()).not.toContain(validToken);
    } finally {
      sink.restore();
    }
  });

  it('the failed line hash prefix matches the one the redemption core produces', async () => {
    // Pins the adapter-local prefix LENGTH to the token module's private
    // TOKEN_HASH_LOG_PREFIX_LENGTH by comparing against a prefix the real core
    // emitted for the same token — so a drift breaks this test rather than
    // silently producing two incomparable prefixes in one log stream.
    const core = await vi.importActual<typeof import('../../../src/lib/solicitation/unsubscribe')>(
      '../../../src/lib/solicitation/unsubscribe',
    );
    const emptyTx = (() => Promise.resolve([])) as never;
    const fromCore = await core.redeemUnsubscribeToken(emptyTx, {
      rawToken: validToken,
      source: 'unsubscribe_one_click',
    });

    const sink = captureWorkerLog();
    try {
      mockRedeem.mockRejectedValue(new Error('boom'));
      await postToken(validToken);
      const records = workerLogRecords(sink);
      expect((records[0]?.data as { hash_prefix?: string }).hash_prefix).toBe(
        fromCore.tokenHashPrefix,
      );
    } finally {
      sink.restore();
    }
  });

  it('a throwing telemetry sink cannot turn a committed redemption into a 503', async () => {
    // The reply is sent BEFORE the §9.5 line and the line carries its own swallow,
    // so a log failure after COMMIT cannot flip a legally-effective opt-out into a
    // 5xx the provider retries, nor manufacture a Sentry event for it (M1).
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {
        throw new Error('EPIPE: broken pipe');
      }),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    try {
      const response = await postToken(validToken);

      expect(response.statusCode).toBe(200);
      expect(mockCaptureException).not.toHaveBeenCalled();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
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

  it('a spent token whose suppression was corrected away is 200, not a retryable 503', async () => {
    const sink = captureWorkerLog();
    try {
      // The third success-shaped outcome, and the only one the ingress had never
      // been driven with. It is the one `redemptionConfirmsSuppression` exists
      // for — and the one the adapter deliberately does NOT ask that predicate
      // about: a provider POST asks "handled?", not "is this recipient
      // suppressed?". 503 here would make the provider retry forever a token that
      // by design will never re-suppress.
      //
      // Unreachable until the audited Correction path (#645) ships, so it is
      // pinned here rather than discovered in production. This is also the case
      // that keeps the single-flight's soundness premise honest — all three
      // non-unknown outcomes map to 200, so sharing one across waiters is safe.
      mockRedeem.mockResolvedValue({
        status: 'already_redeemed_not_suppressed',
        tokenHashPrefix: 'a1b2c3d4e5f6',
      });

      const response = await postToken(validToken);

      expect(response.statusCode).toBe(200);
      expect(mockCaptureException).not.toHaveBeenCalled();
      // It still earns its §9.5 line — this is the outcome that indicates a
      // correction/replay collision, so dropping it would hide the signal.
      const records = workerLogRecords(sink);
      expect(records).toHaveLength(1);
      expect(records[0]?.data).toEqual({
        outcome: 'already_redeemed_not_suppressed',
        hash_prefix: 'a1b2c3d4e5f6',
      });
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

      // POSITIVE CONTROL FIRST. Invariant #5's highest-stakes assertion is a
      // `not.toContain`, and a `not.toContain` against an empty sink passes for
      // the wrong reason — which is precisely what the Fastify assertion that
      // used to sit here did. Prove the line was written before proving what it
      // does not contain.
      const records = workerLogRecords(sink);
      expect(records).toHaveLength(1);
      expect(records[0]?.data).toMatchObject({ outcome: 'failed', stage: 'redeem' });
      expect(sink.lines()).toContain('/ingress/unsubscribe/[REDACTED]');
      expect(sink.lines()).not.toContain(validToken);

      // Fastify's OWN sink is empty on this path, and that is a property worth
      // asserting rather than a place to hide a vacuous check: `failClosed`
      // answers the 503 itself, so the framework error handler never runs, and
      // the route carries `logLevel:'silent'`. The non-empty Fastify cases live
      // where they can actually fail — the unmatched-404 test below, and the
      // 5xx/double-send tests in worker/config/__tests__/fastify-options.test.ts.
      expect(harness.fastifyLogLines()).toEqual([]);

      const [reported] = mockCaptureException.mock.calls[0] as [Error];
      expect(reported.message).toContain('[REDACTED]');
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

// ── single-flight, at the HTTP boundary ─────────────────────────────────────
// The seam's own contract is unit-tested in unsubscribe-single-flight.test.ts.
// What only a real router can prove is that every collapsed waiter still gets its
// OWN reply and its OWN §9.5 log line — the whole point of collapsing the database
// round trip rather than the request.

/** Drains every pending microtask — the deterministic alternative to a sleep. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Holds every request inside `preHandler` until all `count` have arrived, then
 * releases them together. That is what makes "concurrent" a fact rather than a
 * hope: without it the first request could complete before the second is routed,
 * and the test would pass for the wrong reason.
 */
function buildArrivalBarrier(count: number) {
  let arrived = 0;
  let announce!: () => void;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    allArrived,
    hook: async (): Promise<void> => {
      arrived += 1;
      if (arrived === count) {
        announce();
        release();
      }
      await released;
    },
  };
}

describe('unsubscribe ingress — concurrent replays of one token', () => {
  const CONCURRENCY = 6;

  async function raceOneToken(): Promise<{
    settle: (outcome: unknown) => void;
    fail: (reason: unknown) => void;
    responses: Promise<Array<{ statusCode: number }>>;
  }> {
    const barrier = buildArrivalBarrier(CONCURRENCY);
    harness.app.addHook('preHandler', barrier.hook);

    let settle!: (outcome: unknown) => void;
    let fail!: (reason: unknown) => void;
    mockRedeem.mockReturnValue(
      new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
    );

    const responses = Promise.all(
      Array.from({ length: CONCURRENCY }, () => postToken(validToken)),
    );
    await barrier.allArrived;
    // Every request is now past preHandler; draining leaves them all parked on the
    // single shared redemption promise.
    await drainMicrotasks();
    return { settle, fail, responses };
  }

  it('opens exactly one transaction and answers every waiter 200', async () => {
    const sink = captureWorkerLog();
    try {
      const race = await raceOneToken();

      // The finding: the HMAC gate blocks forged strings, but every replay of one
      // DELIVERED token passes it and opens a transaction on the shared write pool
      // (DB_POOL_MAX=20 on the worker, against 18 concurrent BullMQ slots) — on a
      // route §9.2 forbids rate-limiting.
      expect(mockBegin).toHaveBeenCalledTimes(1);
      expect(mockRedeem).toHaveBeenCalledTimes(1);

      race.settle({ status: 'redeemed', tokenHashPrefix: 'a1b2c3d4e5f6' });
      const settled = await race.responses;

      // Nothing is shed — that is what separates this from the bulkhead owner
      // review deleted. All six get the answer the adapter would have given anyway.
      expect(settled.map((response) => response.statusCode)).toEqual(Array(6).fill(200));
      // …and each keeps its OWN line. Collapsing the observability would hide five
      // of six statutory opt-out receipts.
      const records = workerLogRecords(sink);
      expect(records).toHaveLength(CONCURRENCY);
      for (const record of records) {
        expect(record.data).toEqual({ outcome: 'redeemed', hash_prefix: 'a1b2c3d4e5f6' });
      }
    } finally {
      sink.restore();
    }
  });

  it('propagates a rejected shared redemption to every waiter as its own 503', async () => {
    const sink = captureWorkerLog();
    try {
      const race = await raceOneToken();
      race.fail(new Error('ledger write exploded'));
      const settled = await race.responses;

      expect(settled.map((response) => response.statusCode)).toEqual(Array(6).fill(503));
      // Each waiter takes the normal catch → sanitized Sentry → 503 path on its
      // own; a shared failure must not become a shared silence.
      expect(mockCaptureException).toHaveBeenCalledTimes(CONCURRENCY);
      const records = workerLogRecords(sink);
      expect(records).toHaveLength(CONCURRENCY);
      for (const record of records) {
        expect(record.data).toMatchObject({ outcome: 'failed', stage: 'redeem' });
      }
      expect(sink.lines()).not.toContain(validToken);
    } finally {
      sink.restore();
    }
  });

  it('releases the token after settle so a later replay redeems again', async () => {
    const sink = captureWorkerLog();
    try {
      const race = await raceOneToken();
      race.settle({ status: 'redeemed', tokenHashPrefix: 'a1b2c3d4e5f6' });
      await race.responses;

      mockRedeem.mockResolvedValue({
        status: 'already_suppressed',
        tokenHashPrefix: 'a1b2c3d4e5f6',
      });
      const later = await postToken(validToken);

      // A leaked entry would answer every future replay from the first outcome —
      // including one re-delivered after an audited correction removed the row.
      expect(later.statusCode).toBe(200);
      expect(mockRedeem).toHaveBeenCalledTimes(2);
    } finally {
      sink.restore();
    }
  });

  it('does not collapse two different tokens into one redemption', async () => {
    const sink = captureWorkerLog();
    try {
      const other = mintUnsubscribeRawToken();
      const barrier = buildArrivalBarrier(2);
      harness.app.addHook('preHandler', barrier.hook);

      const responses = Promise.all([postToken(validToken), postToken(other)]);
      await barrier.allArrived;
      await drainMicrotasks();

      // Keyed on the token HASH, so two distinct delivered tokens never share.
      expect(mockRedeem).toHaveBeenCalledTimes(2);
      const settled = await responses;
      expect(settled.map((response) => response.statusCode)).toEqual([200, 200]);
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

      // Positive controls, so neither negative assertion can pass against an
      // empty sink: the unmatched 404 puts a redacted URL in Fastify's log, and
      // the failed POST puts a redacted one in the worker's.
      expect(infoHarness.rawFastifyLog()).toContain('/ingress/unsubscribe/[REDACTED]');
      expect(sink.lines()).toContain('/ingress/unsubscribe/[REDACTED]');
      expect(infoHarness.rawFastifyLog()).not.toContain(validToken);
      expect(sink.lines()).not.toContain(validToken);
    } finally {
      sink.restore();
      await infoHarness.close();
    }
  });
});
