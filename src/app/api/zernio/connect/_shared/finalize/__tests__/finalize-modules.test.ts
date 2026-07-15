import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const SECONDARY_LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const {
  mockRequireRole,
  mockAssertSameOrigin,
  mockRedis,
  mockSelectLocation,
  mockDeleteAccount,
  mockSql,
  mockTx,
  mockEnqueueAnalyticsEvent,
  mockReadConnectSessionCookie,
  sqlCalls,
  txCalls,
  txScenario,
  sqlScenario,
} = vi.hoisted(() => {
  const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
  const txCalls: Array<{ raw: string; values: unknown[] }> = [];
  const txScenario = {
    needsBackfill: false,
    accountSubscriptionStatus: 'active',
    accountPastDueAt: null as string | null,
    accountFlags: {} as Record<string, unknown>,
    accountSubscriptionTier: 'copilot',
    accountSubscriptionActivatedAt: new Date(
      '2026-05-01T00:00:00.000Z',
    ) as Date | null,
    existingConnectionId: null as string | null,
    businessFound: true,
  };
  const sqlScenario = {
    businessExists: true,
    incidentInsertError: null as unknown,
  };

  const mockTx = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const raw = strings.join('?');
      txCalls.push({ raw, values });
      if (
        /subscription_activated_at[\s\S]*FROM businesses b[\s\S]*JOIN accounts a/.test(
          raw,
        )
      ) {
        return Promise.resolve(
          txScenario.businessFound
            ? [
                {
                  subscription_status: txScenario.accountSubscriptionStatus,
                  past_due_at: txScenario.accountPastDueAt,
                  flags: txScenario.accountFlags,
                  subscription_tier: txScenario.accountSubscriptionTier,
                  subscription_activated_at:
                    txScenario.accountSubscriptionActivatedAt,
                },
              ]
            : [],
        );
      }
      if (/needs_backfill/.test(raw)) {
        return Promise.resolve([{ needs_backfill: txScenario.needsBackfill }]);
      }
      if (/FROM zernio_connections[\s\S]*FOR UPDATE/.test(raw)) {
        return Promise.resolve(
          txScenario.existingConnectionId
            ? [{ id: txScenario.existingConnectionId }]
            : [],
        );
      }
      return Promise.resolve([]);
    },
  );
  // finalizeConnectionTx now binds its outbox JSONB via the injected client's
  // `.json()` (byte-identical to the removed `jsonb()` helper) instead of
  // importing the db/server singleton — the tx mock needs the method too.
  (mockTx as unknown as { json: (v: unknown) => unknown }).json = vi.fn(
    (v: unknown) => v,
  );

  const mockSql: any = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const raw = strings.join('?');
      sqlCalls.push({ raw, values });
      if (/zernio_finalize_incidents/.test(raw)) {
        if (sqlScenario.incidentInsertError) {
          return Promise.reject(sqlScenario.incidentInsertError);
        }
        return Promise.resolve([]);
      }
      if (/FROM businesses/.test(raw) && /account_id/.test(raw)) {
        return Promise.resolve(
          sqlScenario.businessExists
            ? [
                {
                  subscription_status: 'active',
                  past_due_at: null,
                  flags: {},
                },
              ]
            : [],
        );
      }
      return Promise.resolve([]);
    },
  );
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) =>
    cb(mockTx),
  );

  const mockRedis = {
    get: vi.fn(async (key: string) => {
      if (key === 'connect_locations:session-1') {
        return JSON.stringify({
          userId: 'user-1',
          businessId: SECONDARY_LOCATION_ID,
          profileId: 'profile-secondary',
          flowId: 'flow-1',
          pending_data_token: 'pending-token',
          connect_token: 'connect-token',
          locations: [{ id: 'google-location-1', name: 'Tanicia' }],
        });
      }
      if (key === `connect_pending:${SECONDARY_LOCATION_ID}`) {
        return JSON.stringify({
          flowId: 'flow-1',
          userId: 'user-1',
          status: 'oauth_in_progress',
        });
      }
      return null;
    }),
    set: vi.fn(async () => 'OK'),
    eval: vi.fn(async (): Promise<unknown> => 'OK'),
    del: vi.fn(async () => 1),
  };

  return {
    mockRequireRole: vi.fn(),
    mockAssertSameOrigin: vi.fn(),
    mockRedis,
    mockSelectLocation: vi.fn(async (_input: unknown) => ({
      accountId: 'zernio-account-1',
    })),
    mockDeleteAccount: vi.fn(async (_accountId: unknown) => undefined),
    mockSql,
    mockTx,
    mockEnqueueAnalyticsEvent: vi.fn(),
    mockReadConnectSessionCookie: vi.fn(() => 'session-1' as string | null),
    sqlCalls,
    txCalls,
    txScenario,
    sqlScenario,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/shared/csrf', () => ({
  assertSameOrigin: (...args: unknown[]) => mockAssertSameOrigin(...args),
  SameOriginError: class SameOriginError extends Error {},
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => mockRedis,
}));

vi.mock('@/lib/zernio/connect-session-cookie', () => ({
  readConnectSessionCookie: () => mockReadConnectSessionCookie(),
  clearConnectSessionCookie: vi.fn(),
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    selectLocation: (input: unknown) => mockSelectLocation(input),
    deleteAccount: (accountId: unknown) => mockDeleteAccount(accountId),
  },
}));

vi.mock('@/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: mockEnqueueAnalyticsEvent,
}));

import * as Sentry from '@sentry/nextjs';
import { SameOriginError } from '@/lib/shared/csrf';
import { AuthError } from '@/lib/db/auth';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { getCacheRedis } from '@/lib/db/redis-cache';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';
import { authorizeSelectLocation } from '../authorize';
import { transitionPendingToFinalizing } from '../pending-transition';
import { recordFinalizeUnknownAndThrow } from '../finalize-unknown';
import { finalizeConnectionTx } from '../finalize-tx';
import { recoverFromFinalizeTxFailure } from '../orphan-recovery';

type CacheRedis = ReturnType<typeof getCacheRedis>;

const STORED: ConnectLocationsBlob = {
  flowId: 'flow-1',
  state: 'state-1',
  connect_token: 'connect-token',
  pending_data_token: 'pending-token',
  profileId: 'profile-secondary',
  businessId: SECONDARY_LOCATION_ID,
  userId: 'user-1',
  locations: [
    { id: 'google-location-1', name: 'Tanicia', address: '1 Main St' },
  ],
};

const USER = {
  id: 'user-1',
  name: 'Owner',
  email: 'owner@example.com',
  role: 'owner',
  accountId: ACCOUNT_ID,
  locationId: SECONDARY_LOCATION_ID,
} as any;

function makeRequest(
  body: string | object = { locationId: 'google-location-1' },
): NextRequest {
  return new NextRequest(
    'http://localhost:3000/api/zernio/connect/select-location',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
}

async function expectRouteError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    statusCode: status,
    code,
  });
  const err = await promise.catch((e) => e);
  expect(err).toBeInstanceOf(ZernioRouteError);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  txCalls.length = 0;
  txScenario.needsBackfill = false;
  txScenario.accountSubscriptionStatus = 'active';
  txScenario.accountPastDueAt = null;
  txScenario.accountFlags = {};
  txScenario.accountSubscriptionTier = 'copilot';
  txScenario.accountSubscriptionActivatedAt = new Date(
    '2026-05-01T00:00:00.000Z',
  );
  txScenario.existingConnectionId = null;
  txScenario.businessFound = true;
  sqlScenario.businessExists = true;
  sqlScenario.incidentInsertError = null;
  process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
  mockAssertSameOrigin.mockReturnValue(undefined);
  mockReadConnectSessionCookie.mockReturnValue('session-1');
  mockRedis.get.mockImplementation(async (key: string) => {
    if (key === 'connect_locations:session-1') {
      return JSON.stringify(STORED);
    }
    if (key === `connect_pending:${SECONDARY_LOCATION_ID}`) {
      return JSON.stringify({
        flowId: 'flow-1',
        userId: 'user-1',
        status: 'oauth_in_progress',
      });
    }
    return null;
  });
  mockRedis.eval.mockResolvedValue('OK');
  mockRequireRole.mockResolvedValue(USER);
});

describe('authorizeSelectLocation', () => {
  it('returns a context on the happy path', async () => {
    const ctx = await authorizeSelectLocation(mockSql, makeRequest());
    expect(ctx.user).toBe(USER);
    expect(ctx.sessionId).toBe('session-1');
    expect(ctx.locationId).toBe('google-location-1');
    expect(ctx.stored.businessId).toBe(SECONDARY_LOCATION_ID);
  });

  it('throws 503 feature_disabled when the flag is off', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'false';
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      503,
      'feature_disabled',
    );
  });

  it('throws 403 forbidden on CSRF SameOriginError', async () => {
    mockAssertSameOrigin.mockImplementation(() => {
      throw new SameOriginError('bad origin');
    });
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      403,
      'forbidden',
    );
  });

  it('propagates a non-SameOriginError CSRF failure unchanged', async () => {
    const boom = new Error('boom');
    mockAssertSameOrigin.mockImplementation(() => {
      throw boom;
    });
    await expect(authorizeSelectLocation(mockSql, makeRequest())).rejects.toBe(boom);
  });

  it('maps AuthError 401 → unauthorized and 403 → forbidden', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('nope', 401));
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      401,
      'unauthorized',
    );
    mockRequireRole.mockRejectedValueOnce(new AuthError('nope', 403));
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      403,
      'forbidden',
    );
  });

  it('throws 403 unscoped_owner when the user has no accountId', async () => {
    mockRequireRole.mockResolvedValueOnce({ ...USER, accountId: null });
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      403,
      'unscoped_owner',
    );
  });

  it('throws 400 invalid_body only for unparseable JSON', async () => {
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest('{not json')),
      400,
      'invalid_body',
    );
  });

  it('throws 400 invalid_body for a literal null JSON body (not 500)', async () => {
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest('null')),
      400,
      'invalid_body',
    );
  });

  it('throws 400 invalid_body for a scalar JSON body (was invalid_location_id)', async () => {
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest('42')),
      400,
      'invalid_body',
    );
  });

  it('throws 400 invalid_location_id for an empty-string locationId (permissive parser)', async () => {
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest({ locationId: '' })),
      400,
      'invalid_location_id',
    );
  });

  it('throws 400 invalid_location_id for a missing locationId (not invalid_body)', async () => {
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest({})),
      400,
      'invalid_location_id',
    );
  });

  it('accepts any non-empty string locationId (not just UUIDs)', async () => {
    const ctx = await authorizeSelectLocation(
      mockSql,
      makeRequest({ locationId: 'google-location-1' }),
    );
    expect(ctx.locationId).toBe('google-location-1');
  });

  it('throws 401 connect_session_missing when the cookie is absent', async () => {
    mockReadConnectSessionCookie.mockReturnValue(null);
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      401,
      'connect_session_missing',
    );
  });

  it('throws 410 connect_session_expired when the locations blob is missing', async () => {
    mockRedis.get.mockResolvedValue(null);
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      410,
      'connect_session_expired',
    );
  });

  it('throws 410 connect_session_expired when the locations blob is unparseable', async () => {
    mockRedis.get.mockResolvedValue('{not json');
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      410,
      'connect_session_expired',
    );
  });

  it('throws 403 user_mismatch when the stored userId differs', async () => {
    mockRequireRole.mockResolvedValueOnce({ ...USER, id: 'someone-else' });
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      403,
      'user_mismatch',
    );
  });

  it('throws 403 business_mismatch when the business is not owned by the account', async () => {
    sqlScenario.businessExists = false;
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest()),
      403,
      'business_mismatch',
    );
  });

  it('throws 400 invalid_location_id when the location is not in the cached blob', async () => {
    await expectRouteError(
      authorizeSelectLocation(mockSql, makeRequest({ locationId: 'unknown-location' })),
      400,
      'invalid_location_id',
    );
  });
});

describe('transitionPendingToFinalizing', () => {
  const redis = mockRedis as unknown as CacheRedis;

  it('resolves when the CAS returns OK', async () => {
    mockRedis.eval.mockResolvedValue('OK');
    await expect(
      transitionPendingToFinalizing(redis, STORED),
    ).resolves.toBeUndefined();
  });

  it('throws 410 connect_pending_missing when the marker is absent', async () => {
    mockRedis.get.mockResolvedValue(null);
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      410,
      'connect_pending_missing',
    );
  });

  it('throws 409 malformed_pending_marker when the marker is unparseable', async () => {
    mockRedis.get.mockResolvedValue('{not json');
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      409,
      'malformed_pending_marker',
    );
  });

  it('throws 409 malformed_pending_marker for a "null" marker (not 500)', async () => {
    mockRedis.get.mockResolvedValue('null');
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      409,
      'malformed_pending_marker',
    );
  });

  it('throws 409 malformed_pending_marker for a scalar marker (was flow_changed)', async () => {
    mockRedis.get.mockResolvedValue('42');
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      409,
      'malformed_pending_marker',
    );
  });

  it('throws 410 flow_changed when the marker flowId differs', async () => {
    mockRedis.get.mockResolvedValue(
      JSON.stringify({ flowId: 'other-flow', status: 'oauth_in_progress' }),
    );
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      410,
      'flow_changed',
    );
  });

  it.each([
    [0, 410, 'flow_changed'],
    [-1, 410, 'connect_pending_missing'],
    [-2, 409, 'malformed_pending_marker'],
    [-3, 409, 'finalize_in_progress'],
  ])('maps lua result %s → %s %s', async (luaResult, status, code) => {
    mockRedis.eval.mockResolvedValue(luaResult);
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      status as number,
      code as string,
    );
  });

  it('Sentry-alerts and 409 finalize_in_progress on an unexpected lua result', async () => {
    mockRedis.eval.mockResolvedValue(42);
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      409,
      'finalize_in_progress',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'zernio_select_location_unexpected_lua_result',
      expect.objectContaining({ level: 'error' }),
    );
  });
});

describe('recordFinalizeUnknownAndThrow', () => {
  const redis = mockRedis as unknown as CacheRedis;

  it('always throws 409 finalize_unknown_admin_required on the happy path', async () => {
    await expectRouteError(
      recordFinalizeUnknownAndThrow(mockSql, {
        redis,
        stored: STORED,
        zernioErr: new Error('transient'),
      }),
      409,
      'finalize_unknown_admin_required',
    );
  });

  it('still throws 409 even when BOTH the redis eval and the sql insert reject', async () => {
    mockRedis.eval.mockRejectedValue(new Error('redis down'));
    sqlScenario.incidentInsertError = new Error('db down');
    await expectRouteError(
      recordFinalizeUnknownAndThrow(mockSql, {
        redis,
        stored: STORED,
        zernioErr: new Error('transient'),
      }),
      409,
      'finalize_unknown_admin_required',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'zernio_finalize_unknown_no_record',
      expect.objectContaining({ level: 'fatal' }),
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'zernio_finalize_unknown_db_insert_failed',
      expect.objectContaining({ level: 'error' }),
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'zernio_finalize_unknown',
      expect.anything(),
    );
  });

  it('alerts zernio_finalize_unknown_redis_cas_failed when the CAS returns a non-OK value', async () => {
    mockRedis.eval.mockResolvedValue(0);
    await expectRouteError(
      recordFinalizeUnknownAndThrow(mockSql, {
        redis,
        stored: STORED,
        zernioErr: new Error('transient'),
      }),
      409,
      'finalize_unknown_admin_required',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'zernio_finalize_unknown_redis_cas_failed',
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('treats a 23505 incident insert as persisted (no db_insert_failed alert)', async () => {
    sqlScenario.incidentInsertError = Object.assign(new Error('dup'), {
      code: '23505',
    });
    await expectRouteError(
      recordFinalizeUnknownAndThrow(mockSql, {
        redis,
        stored: STORED,
        zernioErr: new Error('transient'),
      }),
      409,
      'finalize_unknown_admin_required',
    );
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      'zernio_finalize_unknown_db_insert_failed',
      expect.anything(),
    );
    const finalCall = (Sentry.captureMessage as any).mock.calls.find(
      (c: unknown[]) => c[0] === 'zernio_finalize_unknown',
    );
    expect(finalCall?.[1]?.extra?.incidentPersisted).toBe(true);
  });
});

describe('finalizeConnectionTx', () => {
  it('inserts the connection + drain outbox in a single sql.begin', async () => {
    await finalizeConnectionTx(mockSql, {
      user: USER,
      stored: STORED,
      locationId: 'google-location-1',
      accountId: 'zernio-account-1',
    });
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(
      txCalls.some((c) => /INSERT INTO zernio_connections/.test(c.raw)),
    ).toBe(true);
    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the rendered SQL text.
    expect(txCalls.some((c) => c.values.includes('drain_pending_owner_connect'))).toBe(
      true,
    );
  });

  it('enqueues gbp_connected inside the finalize transaction', async () => {
    await finalizeConnectionTx(mockSql, {
      user: USER,
      stored: STORED,
      locationId: 'google-location-1',
      accountId: 'zernio-account-1',
    });

    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(
      mockTx,
      {
        eventName: 'gbp_connected',
        eventKey: `gbp_connected:${SECONDARY_LOCATION_ID}`,
        distinctId: ACCOUNT_ID,
        accountId: ACCOUNT_ID,
        businessId: SECONDARY_LOCATION_ID,
        properties: {
          account_id: ACCOUNT_ID,
          business_id: SECONDARY_LOCATION_ID,
          location_count: 1,
        },
      },
    );
  });

  it('does NOT enqueue initial backfill when needs_backfill is false', async () => {
    txScenario.needsBackfill = false;
    await finalizeConnectionTx(mockSql, {
      user: USER,
      stored: STORED,
      locationId: 'google-location-1',
      accountId: 'zernio-account-1',
    });
    // Topic is a bound QUEUE_NAMES value — a raw-text regex would be
    // vacuously false here even if the enqueue fired, so check the values.
    expect(txCalls.some((c) => c.values.includes('zernio_initial_backfill'))).toBe(
      false,
    );
  });

  it('enqueues initial backfill only when needs_backfill is true', async () => {
    txScenario.needsBackfill = true;
    await finalizeConnectionTx(mockSql, {
      user: USER,
      stored: STORED,
      locationId: 'google-location-1',
      accountId: 'zernio-account-1',
    });
    expect(txCalls.some((c) => c.values.includes('zernio_initial_backfill'))).toBe(
      true,
    );
  });

  it('preserves an Autopilot tier in the typed initial-backfill payload', async () => {
    txScenario.needsBackfill = true;
    txScenario.accountSubscriptionTier = 'autopilot';

    await finalizeConnectionTx(mockSql, {
      user: USER,
      stored: STORED,
      locationId: 'google-location-1',
      accountId: 'zernio-account-1',
    });

    const txJson = (mockTx as unknown as { json: ReturnType<typeof vi.fn> }).json;
    expect(
      txJson.mock.calls.some(
        ([payload]) =>
          (payload as { subscription_tier?: string }).subscription_tier ===
          'autopilot',
      ),
    ).toBe(true);
  });

  it('rejects an unsupported tier before connection or outbox writes', async () => {
    txScenario.accountSubscriptionTier = 'retired_tier';

    await expect(
      finalizeConnectionTx(mockSql, {
        user: USER,
        stored: STORED,
        locationId: 'google-location-1',
        accountId: 'zernio-account-1',
      }),
    ).rejects.toThrow('invalid_ws8_subscription_tier:retired_tier');

    expect(txCalls).toHaveLength(1);
    expect(txCalls[0]!.raw).toMatch(/FROM businesses b[\s\S]*JOIN accounts a/);
    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('updates an existing connection instead of inserting', async () => {
    txScenario.existingConnectionId = 'existing-1';
    await finalizeConnectionTx(mockSql, {
      user: USER,
      stored: STORED,
      locationId: 'google-location-1',
      accountId: 'zernio-account-1',
    });
    expect(
      txCalls.some((c) => /UPDATE zernio_connections[\s\S]*SET/.test(c.raw)),
    ).toBe(true);
    expect(
      txCalls.some((c) => /INSERT INTO zernio_connections/.test(c.raw)),
    ).toBe(false);
  });

  it('throws 403 business_mismatch when the locked row is absent', async () => {
    txScenario.businessFound = false;
    await expectRouteError(
      finalizeConnectionTx(mockSql, {
        user: USER,
        stored: STORED,
        locationId: 'google-location-1',
        accountId: 'zernio-account-1',
      }),
      403,
      'business_mismatch',
    );
  });

  it('throws 403 subscription_inactive when the account is inactive', async () => {
    txScenario.accountSubscriptionStatus = 'cancelled';
    await expectRouteError(
      finalizeConnectionTx(mockSql, {
        user: USER,
        stored: STORED,
        locationId: 'google-location-1',
        accountId: 'zernio-account-1',
      }),
      403,
      'subscription_inactive',
    );
  });
});

describe('recoverFromFinalizeTxFailure', () => {
  const redis = mockRedis as unknown as CacheRedis;

  it('maps a 23505 dbErr → 409 already_connected_by_parallel_flow and best-effort cleans up', async () => {
    const dbErr = Object.assign(new Error('dup'), { code: '23505' });
    await expectRouteError(
      recoverFromFinalizeTxFailure({
        redis,
        stored: STORED,
        accountId: 'zernio-account-1',
        dbErr,
      }),
      409,
      'already_connected_by_parallel_flow',
    );
    expect(mockDeleteAccount).toHaveBeenCalledWith('zernio-account-1');
  });

  it('rethrows the original dbErr for any non-23505 error', async () => {
    const dbErr = new Error('generic failure');
    await expect(
      recoverFromFinalizeTxFailure({
        redis,
        stored: STORED,
        accountId: 'zernio-account-1',
        dbErr,
      }),
    ).rejects.toBe(dbErr);
  });

  it('adds a Sentry breadcrumb when the pending marker is not cleared', async () => {
    mockRedis.eval.mockResolvedValue(0);
    const dbErr = Object.assign(new Error('dup'), { code: '23505' });
    await recoverFromFinalizeTxFailure({
      redis,
      stored: STORED,
      accountId: 'zernio-account-1',
      dbErr,
    }).catch(() => undefined);
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'pending_marker_not_cleared_post_accountid_failure',
      }),
    );
  });
});
