import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

// Module tests for the onboarding-start flow (#1368) — no route, no session,
// no BotID, no NextResponse. A fake `sql` answers by statement shape and
// records every statement (top-level and in-transaction) in order.

const { mockCheckRateLimit, mockReserve, mockReport, CostCeilingExceeded } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockReserve: vi.fn(),
  mockReport: vi.fn(),
  CostCeilingExceeded: class CostCeilingExceeded extends Error {},
}));

vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('@/lib/costs/onboarding-demo-cost-guard', () => ({
  reserveOnboardingDemoBudget: mockReserve,
  CostCeilingExceeded,
}));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: mockReport }));

import { startOnboarding } from '../start';

const AUTH_ID = 'auth-1';
const BIZ = {
  id: 'b0000000-0000-4000-8000-000000000001',
  account_id: 'a0000000-0000-4000-8000-000000000001',
  user_id: 'u0000000-0000-4000-8000-000000000001',
  subscription_status: 'pending_payment',
  place_id_verified: false,
  google_maps_url: null,
};
const PLACE_BODY = {
  inputMode: 'autocomplete',
  googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
  businessName: 'Acme Cafe',
  prefilledCategory: 'Restaurant',
};
const URL_BODY = {
  inputMode: 'url',
  googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@1,2,17z',
  businessName: 'Acme Cafe',
};

interface Fake {
  sql: Sql;
  statements: string[];
  jsonValues: unknown[];
  began: () => number;
}

function fakeSql(opts: {
  bizRow?: unknown[];
  forUpdate?: unknown[];
  txFails?: Error;
} = {}): Fake {
  const statements: string[] = [];
  const jsonValues: unknown[] = [];
  let begins = 0;
  const answer = (raw: string): unknown[] => {
    if (/FROM users u/.test(raw)) return opts.bizRow ?? [BIZ];
    if (/FOR UPDATE/.test(raw)) return opts.forUpdate ?? [{ id: BIZ.id, place_id_verified: false, google_maps_url: null }];
    if (/RETURNING id/.test(raw)) return [{ id: 'outbox-1' }];
    return [];
  };
  const tag = (strings: TemplateStringsArray) => {
    const raw = strings.join('?');
    statements.push(raw);
    return Promise.resolve(answer(raw));
  };
  const tx = Object.assign(tag, {
    json: (v: unknown) => { jsonValues.push(v); return v; },
  });
  const sql = Object.assign(tag, {
    begin: async (cb: (t: typeof tx) => Promise<unknown>) => {
      begins += 1;
      if (opts.txFails) throw opts.txFails;
      return cb(tx);
    },
  });
  return { sql: sql as unknown as Sql, statements, jsonValues, began: () => begins };
}

const release = vi.fn();

function input(body: unknown = PLACE_BODY) {
  return { authId: AUTH_ID, clientIp: '203.0.113.9', readJsonBody: vi.fn(async () => body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  release.mockResolvedValue(undefined);
  mockReserve.mockResolvedValue({ release, date: '2026-09-24' });
});

describe('startOnboarding — gates before the body is read', () => {
  it('404 account_incomplete when no owner/primary business row resolves', async () => {
    const f = fakeSql({ bizRow: [] });
    const i = input();
    expect(await startOnboarding(f.sql, i)).toEqual({
      kind: 'json', status: 404, body: { error: 'account_incomplete' },
    });
    expect(i.readJsonBody).not.toHaveBeenCalled();
    expect(f.began()).toBe(0);
  });

  it('409 subscription_inactive (echoing the status) when not pending_payment', async () => {
    const f = fakeSql({ bizRow: [{ ...BIZ, subscription_status: 'active' }] });
    expect(await startOnboarding(f.sql, input())).toEqual({
      kind: 'json', status: 409, body: { error: 'subscription_inactive', subscriptionStatus: 'active' },
    });
  });

  it('idempotent 200 redirect when a place is already captured, before any rate limit', async () => {
    const f = fakeSql({ bizRow: [{ ...BIZ, google_maps_url: 'https://maps' }] });
    expect(await startOnboarding(f.sql, input())).toEqual({
      kind: 'json', status: 200, body: { redirectTo: '/onboarding/demo', demoQueued: false },
    });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('429 on the outer per-auth-id limit, body never read', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const i = input();
    expect(await startOnboarding(fakeSql().sql, i)).toEqual({
      kind: 'json', status: 429, body: { error: 'rate_limited' },
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(`onboarding-start:auth:${AUTH_ID}`, 10, 3600, { strict: true });
    expect(i.readJsonBody).not.toHaveBeenCalled();
  });

  it('503 rate_limit_unavailable when the outer strict limiter throws', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('redis'));
    const r = await startOnboarding(fakeSql().sql, input());
    expect(r).toEqual({ kind: 'json', status: 503, body: { error: 'rate_limit_unavailable' } });
    expect(mockReport).toHaveBeenCalledWith('api/onboarding/start', expect.any(Error), { reason: 'rate_limit_strict_failure' });
  });
});

describe('startOnboarding — body', () => {
  it('400 invalid_json when the body is not JSON', async () => {
    const i = { ...input(), readJsonBody: vi.fn(async () => { throw new SyntaxError('bad'); }) };
    expect(await startOnboarding(fakeSql().sql, i)).toEqual({
      kind: 'json', status: 400, body: { error: 'invalid_json' },
    });
  });

  it('hands a schema failure back as invalid_body with the ZodError', async () => {
    const r = await startOnboarding(fakeSql().sql, input({ inputMode: 'autocomplete' }));
    expect(r.kind).toBe('invalid_body');
  });
});

describe('startOnboarding — demo gates', () => {
  it('uses the per-user, per-IP and global demo limits in that order', async () => {
    await startOnboarding(fakeSql().sql, input());
    expect(mockCheckRateLimit.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      [`onboarding-start:auth:${AUTH_ID}`, 10, 3600],
      [`onboarding-demo:user:${AUTH_ID}`, 3, 86400],
      ['onboarding-demo:ip:203.0.113.9', 5, 86400],
      ['onboarding-demo:global', 200, 3600],
    ]);
  });

  it('a demo rate limit blocks the demo but still activates; no reservation', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });
    const f = fakeSql();
    const r = await startOnboarding(f.sql, input());
    expect(r).toEqual({
      kind: 'json', status: 200,
      body: { redirectTo: '/onboarding/demo', demoQueued: false, reason: 'rate_limit' },
    });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(f.statements.some((s) => /UPDATE businesses/.test(s))).toBe(true);
    expect(f.statements.some((s) => /INSERT INTO onboarding_demos/.test(s))).toBe(false);
  });

  it('503 when a demo limiter throws', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true }).mockRejectedValueOnce(new Error('x'));
    expect(await startOnboarding(fakeSql().sql, input())).toEqual({
      kind: 'json', status: 503, body: { error: 'rate_limit_unavailable' },
    });
  });

  it('cost ceiling blocks the demo with reason cost_ceiling', async () => {
    mockReserve.mockRejectedValueOnce(new CostCeilingExceeded('ceiling'));
    const r = await startOnboarding(fakeSql().sql, input());
    expect(r.kind === 'json' && r.body).toEqual({
      redirectTo: '/onboarding/demo', demoQueued: false, reason: 'cost_ceiling',
    });
  });

  it('503 redis_unavailable when the reservation fails otherwise', async () => {
    mockReserve.mockRejectedValueOnce(new Error('redis'));
    const f = fakeSql();
    expect(await startOnboarding(f.sql, input())).toEqual({
      kind: 'json', status: 503, body: { error: 'redis_unavailable' },
    });
    expect(f.began()).toBe(0);
  });
});

describe('startOnboarding — activation transaction', () => {
  it('happy path: lock → FOR UPDATE → business → account → demo → outbox; demoQueued', async () => {
    const f = fakeSql();
    const r = await startOnboarding(f.sql, input());
    expect(r).toEqual({
      kind: 'json', status: 200,
      body: { redirectTo: '/onboarding/demo', demoQueued: true, reason: null },
    });
    const txStatements = f.statements.slice(1).map((s) => s.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(txStatements).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext(?))',
      'SELECT id, place_id_verified,',
      'UPDATE businesses SET',
      'UPDATE accounts SET',
      'INSERT INTO onboarding_demos',
      'INSERT INTO job_outbox',
    ]);
    expect(f.jsonValues).toEqual([expect.objectContaining({
      googlePlaceId: PLACE_BODY.googlePlaceId,
      businessName: 'Acme Cafe',
      category: 'Restaurant',
      cost_reservation_date: '2026-09-24',
    })]);
    expect(release).not.toHaveBeenCalled();
  });

  it('a Maps URL queues place-id validation inside the transaction', async () => {
    const f = fakeSql();
    await startOnboarding(f.sql, input(URL_BODY));
    expect(f.jsonValues[0]).toEqual(expect.objectContaining({
      business_id: BIZ.id, google_maps_url: URL_BODY.googleMapsUrl,
    }));
  });

  it('idempotency loser: commits nothing new, releases the reservation, demoQueued false', async () => {
    const f = fakeSql({ forUpdate: [{ id: BIZ.id, place_id_verified: true, google_maps_url: null }] });
    const r = await startOnboarding(f.sql, input());
    expect(r.kind === 'json' && r.body.demoQueued).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.statements.some((s) => /UPDATE businesses/.test(s))).toBe(false);
  });

  it('transaction failure: releases the reservation and answers a reported 500', async () => {
    const boom = new Error('tx');
    const r = await startOnboarding(fakeSql({ txFails: boom }).sql, input());
    expect(r).toEqual({ kind: 'json', status: 500, body: { error: 'internal_error' } });
    expect(release).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith('api/onboarding/start', boom, { reason: 'transaction_failed', businessId: BIZ.id });
  });
});
