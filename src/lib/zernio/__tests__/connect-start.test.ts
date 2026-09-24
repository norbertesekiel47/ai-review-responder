import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

// Module tests for the connect-start state machine (#1368) — no route, no
// CSRF/auth, no NextResponse. Fake `sql` answers by statement shape; Redis,
// the Zernio client and analytics enqueue are mocked.

const LOC = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'user-1';

const { mockRedis, mockZernio, mockEnqueue, mockReport } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    eval: vi.fn(),
    del: vi.fn(),
  },
  mockZernio: {
    createProfile: vi.fn(),
    startConnect: vi.fn(),
    deleteProfile: vi.fn(),
    deleteAccount: vi.fn(),
  },
  mockEnqueue: vi.fn(),
  mockReport: vi.fn(),
}));

vi.mock('@/lib/db/redis-cache', () => ({ getCacheRedis: () => mockRedis }));
vi.mock('@/lib/zernio/client', () => ({ zernioClient: mockZernio }));
vi.mock('@/lib/analytics/enqueue', () => ({ enqueueAnalyticsEvent: mockEnqueue }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: mockReport }));

import { ZernioRouteError } from '@/lib/zernio/errors';
import { lockKey, luaCASDel, luaCASUpdate, luaTokenCAS, pendingKey } from '@/lib/zernio/connect-state';
import { startZernioConnect } from '../connect-start';

interface SqlAnswers {
  account: unknown[];
  active: unknown[];
  incident: unknown[];
  orphans: unknown[];
}

function fakeSql(answers: Partial<SqlAnswers> = {}): { sql: Sql; statements: string[] } {
  const a: SqlAnswers = {
    account: [{ id: ACCOUNT, subscription_status: 'active', past_due_at: null, flags: {} }],
    active: [],
    incident: [],
    orphans: [],
    ...answers,
  };
  const statements: string[] = [];
  const fn = (strings: TemplateStringsArray) => {
    const raw = strings.join('?');
    statements.push(raw);
    if (/account_offboardings/.test(raw)) return Promise.resolve(a.account);
    if (/zernio_finalize_incidents/.test(raw)) return Promise.resolve(a.incident);
    if (/zernio_profile_id/.test(raw)) return Promise.resolve(a.orphans);
    if (/zernio_connections/.test(raw)) return Promise.resolve(a.active);
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as Sql, statements };
}

const input = { userId: USER, accountId: ACCOUNT, locationId: LOC, locationScope: 'location' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.setex.mockResolvedValue('OK');
  mockRedis.eval.mockResolvedValue(1);
  mockRedis.del.mockResolvedValue(1);
  mockZernio.createProfile.mockResolvedValue({ profileId: 'prof-1' });
  mockZernio.startConnect.mockResolvedValue({ authUrl: 'https://zernio.test/auth', state: 'st-1' });
  mockZernio.deleteProfile.mockResolvedValue(undefined);
  mockZernio.deleteAccount.mockResolvedValue(undefined);
  mockEnqueue.mockResolvedValue(undefined);
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
});

function lockReleased(): boolean {
  return mockRedis.eval.mock.calls.some((c) => c[0] === luaTokenCAS && c[2] === lockKey(LOC));
}

describe('startZernioConnect — gates before the lock', () => {
  it('403 invalid_location_scope when the location is not an active one of this account', async () => {
    const { sql } = fakeSql({ account: [] });
    expect(await startZernioConnect(sql, input)).toEqual({
      status: 403, body: { error: 'invalid_location_scope' },
    });
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('refuses a non-writable subscription with the guard status/code', async () => {
    const { sql } = fakeSql({ account: [{ id: ACCOUNT, subscription_status: 'cancelled', past_due_at: null, flags: {} }] });
    const r = await startZernioConnect(sql, input);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body).toHaveProperty('error');
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('403 account_offboarding_blocked during an active offboarding', async () => {
    const { sql } = fakeSql({ account: [{
      id: ACCOUNT, subscription_status: 'active', past_due_at: null, flags: {},
      offboarding_id: 'ob-1', offboarding_account_id: ACCOUNT, offboarding_mode: 'delete_data',
      offboarding_status: 'requested', offboarding_failed_step: null,
      offboarding_access_ends_at: null, offboarding_teardown_started_at: null,
      offboarding_purge_after: null, offboarding_purge_started_at: null,
      offboarding_purge_cancelled_at: null,
    }] });
    const r = await startZernioConnect(sql, input);
    expect(r).toEqual({ status: 403, body: { error: 'account_offboarding_blocked' } });
  });

  it('409 malformed_pending_marker on an unparseable marker', async () => {
    mockRedis.get.mockResolvedValue('{not json');
    expect(await startZernioConnect(fakeSql().sql, input)).toEqual({
      status: 409, body: { error: 'malformed_pending_marker' },
    });
  });

  it('409 finalize_unknown_admin_required on a finalize_unknown marker, however old', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({
      flowId: 'f', userId: USER, started_at: 0, status: 'finalize_unknown',
    }));
    expect(await startZernioConnect(fakeSql().sql, input)).toEqual({
      status: 409, body: { error: 'finalize_unknown_admin_required' },
    });
  });

  it('409 connect_pending (with status) on a fresh marker', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({
      flowId: 'f', userId: USER, started_at: Date.now(), status: 'oauth_in_progress',
    }));
    expect(await startZernioConnect(fakeSql().sql, input)).toEqual({
      status: 409, body: { error: 'connect_pending', status: 'oauth_in_progress' },
    });
  });

  it('a stale marker falls through to a new flow', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({
      flowId: 'f', userId: USER, started_at: Date.now() - 16 * 60_000, status: 'oauth_in_progress',
    }));
    const r = await startZernioConnect(fakeSql().sql, input);
    expect(r).toEqual({ status: 200, body: { authUrl: 'https://zernio.test/auth' } });
  });

  it('429 connect_in_progress when the request lock is held; nothing released', async () => {
    mockRedis.set.mockResolvedValueOnce(null);
    expect(await startZernioConnect(fakeSql().sql, input)).toEqual({
      status: 429, body: { error: 'connect_in_progress' },
    });
    expect(lockReleased()).toBe(false);
  });
});

describe('startZernioConnect — behind the lock', () => {
  it('throws already_connected (409) and still releases the lock', async () => {
    const { sql } = fakeSql({ active: [{ exists: 1 }] });
    await expect(startZernioConnect(sql, input)).rejects.toMatchObject({
      statusCode: 409, code: 'already_connected',
    });
    expect(lockReleased()).toBe(true);
    expect(mockZernio.createProfile).not.toHaveBeenCalled();
  });

  it('throws finalize_unknown_admin_required on an unresolved incident', async () => {
    const { sql } = fakeSql({ incident: [{ exists: 1 }] });
    await expect(startZernioConnect(sql, input)).rejects.toBeInstanceOf(ZernioRouteError);
    expect(lockReleased()).toBe(true);
  });

  it('happy path: placeholder marker, profile, state keys, CAS update, analytics, authUrl', async () => {
    const { sql } = fakeSql();
    const r = await startZernioConnect(sql, input);
    expect(r).toEqual({ status: 200, body: { authUrl: 'https://zernio.test/auth' } });

    const placeholder = mockRedis.set.mock.calls.find((c) => c[0] === pendingKey(LOC));
    expect(placeholder).toBeDefined();
    expect(JSON.parse(placeholder![1] as string)).toMatchObject({ userId: USER, status: 'starting' });
    expect(placeholder!.slice(2)).toEqual(['EX', 900]);

    expect(mockZernio.createProfile).toHaveBeenCalledWith({ name: expect.stringMatching(new RegExp(`${LOC}$`)) });
    expect(mockZernio.startConnect).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'prof-1', redirectUrl: 'http://localhost:3000/api/zernio/connect/callback',
    }));
    const cas = mockRedis.eval.mock.calls.find((c) => c[0] === luaCASUpdate);
    expect(JSON.parse(cas![4] as string)).toMatchObject({
      status: 'oauth_in_progress', profileId: 'prof-1', state: 'st-1',
    });
    expect(mockEnqueue).toHaveBeenCalledWith(sql, expect.objectContaining({
      eventName: 'gbp_connect_started',
      accountId: ACCOUNT,
      businessId: LOC,
      properties: { account_id: ACCOUNT, business_id: LOC, location_scope: 'location' },
    }));
    expect(lockReleased()).toBe(true);
    expect(mockZernio.deleteProfile).not.toHaveBeenCalled();
  });

  it('analytics failure is reported and never blocks connect', async () => {
    mockEnqueue.mockRejectedValue(new Error('outbox down'));
    const r = await startZernioConnect(fakeSql().sql, { ...input, locationScope: 'all' });
    expect(r.status).toBe(200);
    expect(mockReport).toHaveBeenCalledWith('api/zernio/connect/start', expect.any(Error),
      expect.objectContaining({ step: 'gbp_connect_started_enqueue' }));
  });

  it('orphan self-heal: account then profile deleted before createProfile; failures swallowed', async () => {
    const order: string[] = [];
    mockZernio.deleteAccount.mockImplementation(async (id: string) => { order.push(`acct:${id}`); throw new Error('404'); });
    mockZernio.deleteProfile.mockImplementation(async (id: string) => { order.push(`prof:${id}`); });
    mockZernio.createProfile.mockImplementation(async () => { order.push('create'); return { profileId: 'prof-1' }; });
    const { sql } = fakeSql({ orphans: [
      { zernio_account_id: 'za-1', zernio_profile_id: 'zp-1' },
      { zernio_account_id: null, zernio_profile_id: 'zp-2' },
    ] });
    const r = await startZernioConnect(sql, input);
    expect(r.status).toBe(200);
    expect(order).toEqual(['acct:za-1', 'prof:zp-1', 'prof:zp-2', 'create']);
    expect(mockReport).toHaveBeenCalledWith('api/zernio/connect/start', expect.any(Error),
      { step: 'orphaned_account_cleanup', accountId: 'za-1', businessId: LOC });
  });

  it('superseded CAS: throws 409, CAS-deletes the placeholder, drops state keys and the new profile', async () => {
    mockRedis.eval.mockImplementation(async (script: string) => (script === luaCASUpdate ? 0 : 1));
    await expect(startZernioConnect(fakeSql().sql, input)).rejects.toMatchObject({
      statusCode: 409, code: 'flow_superseded_during_start',
    });
    expect(mockRedis.eval.mock.calls.some((c) => c[0] === luaCASDel && c[2] === pendingKey(LOC))).toBe(true);
    expect(mockRedis.del).toHaveBeenCalledTimes(2);
    expect(mockZernio.deleteProfile).toHaveBeenCalledWith('prof-1');
    expect(lockReleased()).toBe(true);
  });

  it('missing NEXT_PUBLIC_APP_URL: throws 500 app_url_not_configured and deletes the created profile', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await expect(startZernioConnect(fakeSql().sql, input)).rejects.toMatchObject({
      statusCode: 500, code: 'app_url_not_configured',
    });
    expect(mockZernio.deleteProfile).toHaveBeenCalledWith('prof-1');
    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});
