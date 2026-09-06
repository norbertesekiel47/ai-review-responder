// src/app/q/[businessId]/__tests__/route.test.ts
//
// Task 1 eval suite for the public QR redirect route (docs/context/review-qr.md
// "QR redirect") — authored FAILING before the route exists; Task 5 turns it
// green. The /r/google/[responseId] route-test pattern (vi.hoisted +
// vi.mock('@/lib/db/server')), but the fake is call-indexed: call 0 is the
// resolve SELECT, call 1 is the analytics INSERT. The real module and the
// real enqueueAnalyticsEvent run against the fake.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db } = vi.hoisted(() => {
  const state = {
    rowsPerCall: [] as unknown[][],
    calls: [] as { text: string; values: unknown[] }[],
    failOnCall: -1,
    stallOnCall: -1,
  };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const index = state.calls.length;
    state.calls.push({ text: strings.join('?'), values });
    if (index === state.failOnCall) throw new Error('insert failed');
    if (index === state.stallOnCall) return new Promise<unknown[]>(() => {}); // never settles
    return state.rowsPerCall[index] ?? [];
  };
  return { db: { state, sql: Object.assign(fn, { json: (v: unknown) => v }) } };
});

// Partial mock of next/server: everything real EXCEPT `after`, which queues
// its callback instead of scheduling post-response work (there is no
// response lifecycle under vitest). flushAfter() below drains the queue —
// tests asserting on the analytics insert flush first; the stalled-insert
// regression test deliberately does NOT.
const { afterQueue } = vi.hoisted(() => ({
  afterQueue: [] as Array<() => void | Promise<void>>,
}));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: () => void | Promise<void>) => {
      afterQueue.push(task);
    },
  };
});

async function flushAfter(): Promise<void> {
  for (const task of afterQueue.splice(0)) await task();
}

vi.mock('@/lib/db/server', () => ({ sql: db.sql }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

const { loggerFake } = vi.hoisted(() => ({ loggerFake: { log: vi.fn() } }));
vi.mock('@/lib/shared/logger', () => ({ createWorkerLogger: () => loggerFake }));

import { GET } from '../route';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

const BUSINESS_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec603';
const ACCOUNT_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec604';
const CANONICAL_PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const HEX_CID = '0x89c259af336b3341:0x66df8e2a5b7cdb51';
const WRITE_REVIEW_URL = `https://search.google.com/local/writereview?placeid=${CANONICAL_PLACE_ID}`;

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    google_place_id: CANONICAL_PLACE_ID,
    archived_at: null,
    account_id: ACCOUNT_UUID,
    subscription_status: 'active',
    ...overrides,
  };
}

function call(businessId: string) {
  return GET({} as never, { params: Promise.resolve({ businessId }) });
}

beforeEach(() => {
  db.state.rowsPerCall = [];
  db.state.calls = [];
  db.state.failOnCall = -1;
  db.state.stallOnCall = -1;
  afterQueue.length = 0;
  loggerFake.log.mockClear();
  vi.mocked(reportCaughtError).mockClear();
});

describe('GET /q/[businessId]', () => {
  it('redirects an active-subscription location with a canonical place id to the Google write-review URL', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(WRITE_REVIEW_URL);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns the unavailable page for a cancelled or pending_payment account', async () => {
    for (const status of ['cancelled', 'pending_payment']) {
      db.state.rowsPerCall = [[liveRow({ subscription_status: status })]];
      db.state.calls = [];
      const res = await call(BUSINESS_UUID);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('Review link unavailable');
    }
  });

  it('returns the unavailable page for an archived location', async () => {
    db.state.rowsPerCall = [[liveRow({ archived_at: new Date('2026-08-01T00:00:00Z') })]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('returns the unavailable page when google_place_id is a legacy hex CID', async () => {
    db.state.rowsPerCall = [[liveRow({ google_place_id: HEX_CID })]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('returns the unavailable page for a malformed or unknown business id', async () => {
    const malformed = await call('not-a-uuid');
    expect(malformed.status).toBe(200);
    expect(db.state.calls).toHaveLength(0); // no DB touch on a malformed id

    db.state.rowsPerCall = [[]];
    const unknown = await call(BUSINESS_UUID);
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get('location')).toBeNull();
  });

  it('still redirects when the analytics insert fails', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    db.state.failOnCall = 1; // the INSERT
    const res = await call(BUSINESS_UUID);
    await flushAfter(); // run the deferred (failing) insert — the 302 stands
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(WRITE_REVIEW_URL);
  });

  it('returns the 302 before a stalled analytics insert resolves', async () => {
    // Adversarial R1 A1: the old code AWAITED the insert on the critical
    // path, so a stalled INSERT delayed or killed the redirect. Under
    // after() the GET resolves with only the resolve SELECT issued; the
    // never-settling call 1 would hang this test if the await came back.
    db.state.rowsPerCall = [[liveRow()]];
    db.state.stallOnCall = 1; // the INSERT never settles
    const res = await call(BUSINESS_UUID);
    // Deliberately NO flushAfter() here.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(WRITE_REVIEW_URL);
    expect(db.state.calls).toHaveLength(1); // the resolve SELECT only, so far
  });

  it('records a qr_scan_redirected analytics event on a successful redirect', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(302);
    await flushAfter();
    expect(db.state.calls).toHaveLength(2);
    // Optional chaining: index access stays possibly-undefined under
    // noUncheckedIndexedAccess (codex R3 #1).
    const insert = db.state.calls[1];
    expect(insert?.text).toContain('analytics_events');
    expect(insert?.values).toContain('qr_scan_redirected');
    expect(insert?.values).toContain(ACCOUNT_UUID);
    expect(insert?.values).toContain(BUSINESS_UUID);
  });

  it('never redirects anywhere but the constructed Google write-review URL', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    const res = await call(BUSINESS_UUID);
    expect(res.headers.get('location')).toMatch(
      /^https:\/\/search\.google\.com\/local\/writereview\?placeid=/,
    );
  });

  it('redirects trialing and past_due subscriptions and an uppercase UUID', async () => {
    for (const status of ['trialing', 'past_due']) {
      db.state.rowsPerCall = [[liveRow({ subscription_status: status })]];
      db.state.calls = [];
      expect((await call(BUSINESS_UUID.toUpperCase())).status).toBe(302);
    }
  });

  it('two scans of the same QR produce distinct analytics event keys', async () => {
    // Codex R1 M7: a deterministic per-business key would dedupe on
    // ON CONFLICT (event_key) and silently UNDERCOUNT repeat scans.
    const keys: string[] = [];
    for (let scan = 0; scan < 2; scan += 1) {
      db.state.rowsPerCall = [[liveRow()]];
      db.state.calls = [];
      await call(BUSINESS_UUID);
      await flushAfter();
      const insert = db.state.calls[1];
      const key = insert?.values.find(
        (value) => typeof value === 'string' && value.startsWith('qr_scan_redirected:'),
      );
      expect(key).toBeDefined();
      keys.push(key as string);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('ships account_id and business_id in the analytics event properties', async () => {
    // Codex R1 M3/M4: AnalyticsDispatchPoller forwards ONLY the properties
    // JSON (plus $insert_id) to PostHog — the DB columns never reach it.
    db.state.rowsPerCall = [[liveRow()]];
    await call(BUSINESS_UUID);
    await flushAfter();
    const insert = db.state.calls[1];
    const properties = insert?.values.find(
      (value) => typeof value === 'object' && value !== null && !(value instanceof Date),
    ) as Record<string, unknown>;
    expect(properties).toMatchObject({
      account_id: ACCOUNT_UUID,
      business_id: BUSINESS_UUID,
    });
  });

  it('returns unavailable for a missing google_place_id without recording analytics', async () => {
    db.state.rowsPerCall = [[liveRow({ google_place_id: null })]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(200);
    await flushAfter(); // nothing was deferred on a refusal
    expect(db.state.calls).toHaveLength(1); // the resolve SELECT only — no INSERT
  });

  it('serves one identical no-store unavailable page for every refusal, reason-coded in the log only', async () => {
    // Codex R1 M11–M13: the page must not leak WHICH refusal fired (that
    // distinction belongs to the log line), and every response is no-store.
    const bodies: string[] = [];
    const refusals: Array<[Record<string, unknown> | null, string]> = [
      [null, 'not_found'],
      [liveRow({ subscription_status: 'cancelled' }), 'subscription'],
      [liveRow({ archived_at: new Date('2026-08-01T00:00:00Z') }), 'archived'],
      [liveRow({ google_place_id: HEX_CID }), 'bad_place_id'],
      [liveRow({ google_place_id: null }), 'bad_place_id'],
    ];
    for (const [row, reason] of refusals) {
      db.state.rowsPerCall = [row === null ? [] : [row]];
      db.state.calls = [];
      loggerFake.log.mockClear();
      const res = await call(BUSINESS_UUID);
      expect(res.headers.get('cache-control')).toBe('no-store');
      bodies.push(await res.text());
      expect(loggerFake.log).toHaveBeenCalledWith(
        'qr_redirect_unavailable',
        expect.objectContaining({ reason }),
      );
    }
    // The malformed-id leg refuses BEFORE the DB and must be
    // indistinguishable from every other refusal (codex R2).
    loggerFake.log.mockClear();
    const malformed = await call('not-a-uuid');
    expect(malformed.headers.get('cache-control')).toBe('no-store');
    bodies.push(await malformed.text());
    expect(loggerFake.log).toHaveBeenCalledWith(
      'qr_redirect_unavailable',
      expect.objectContaining({ reason: 'bad_id' }),
    );
    expect(new Set(bodies).size).toBe(1); // byte-identical across ALL refusals
  });

  it('reports the analytics failure when the insert throws', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    db.state.failOnCall = 1;
    await call(BUSINESS_UUID);
    await flushAfter();
    expect(reportCaughtError).toHaveBeenCalledTimes(1);
  });
});
