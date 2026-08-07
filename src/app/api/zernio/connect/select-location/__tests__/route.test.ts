import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ZernioAuthError, ZernioValidationError } from '@/lib/zernio/errors';
import { luaCASRevertToOauth } from '@/lib/zernio/connect-state';

const PRIMARY_LOCATION_ID = '11111111-1111-4111-8111-111111111111';
const SECONDARY_LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const {
  mockRequireRole,
  mockRedis,
  mockSelectLocation,
  mockDeleteAccount,
  authScopeAccountRows,
  sqlCalls,
  txCalls,
  txScenario,
  mockSql,
} = vi.hoisted(() => {
  const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
  const txCalls: Array<{ raw: string; values: unknown[] }> = [];
  const authScopeAccountRows: {
    value: Array<{
      subscription_status: string;
      past_due_at: string | null;
      flags: Record<string, unknown>;
    }>;
  } = {
    value: [
      {
        subscription_status: 'active',
        past_due_at: null,
        flags: {},
      },
    ],
  };
  const txScenario = {
    // #677 replaced `needsBackfill` with Import consent: finalizeConnectionTx no
    // longer runs a needs_backfill predicate, it asks whether the owner accepted
    // the Import offer. Default 'pending' (migration 100's DEFAULT), so a test
    // must opt IN to the enqueue.
    importConsent: 'pending' as 'pending' | 'accepted' | 'declined' | 'expired' | null,
    accountSubscriptionActivatedAt: new Date('2026-05-01T00:00:00.000Z'),
    existingConnectionId: null as string | null,
  };

  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('?');
    txCalls.push({ raw, values });
    if (/subscription_activated_at[\s\S]*FROM businesses b[\s\S]*JOIN accounts a/.test(raw)) {
      return Promise.resolve([{
        subscription_status: 'active',
        subscription_tier: 'copilot',
        subscription_activated_at: txScenario.accountSubscriptionActivatedAt,
      }]);
    }
    // readImportConsent — matched on its aliased column, before the generic
    // businesses branches.
    if (/import_decision_at AS decided_at/.test(raw)) {
      return Promise.resolve(
        txScenario.importConsent === null
          ? []
          : [{ state: txScenario.importConsent, decided_at: null, expires_at: null }],
      );
    }
    // createImportOffer.
    if (/SET import_offer_expires_at/.test(raw)) {
      return Promise.resolve([]);
    }
    if (/FROM zernio_connections[\s\S]*FOR UPDATE/.test(raw)) {
      return Promise.resolve(
        txScenario.existingConnectionId
          ? [{ id: txScenario.existingConnectionId }]
          : [],
      );
    }
    return Promise.resolve([]);
  });
  // enqueueAnalyticsEvent (real implementation, called from finalizeConnectionTx)
  // now calls the injected client's `.json()` directly instead of the removed
  // `jsonb()` helper — the tx mock needs the method too.
  (mockTx as unknown as { json: (v: unknown) => unknown }).json = vi.fn((v: unknown) => v);

  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('?');
    sqlCalls.push({ raw, values });
    if (/FROM businesses/.test(raw) && /account_id/.test(raw)) {
      return Promise.resolve(authScopeAccountRows.value);
    }
    return Promise.resolve([]);
  });
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));

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
    set: vi.fn(async (..._args: unknown[]) => 'OK'),
    eval: vi.fn(async (..._args: unknown[]) => 'OK'),
    del: vi.fn(async (..._args: unknown[]) => 1),
  };

  return {
    mockRequireRole: vi.fn(),
    mockRedis,
    mockSelectLocation: vi.fn(async (_input: unknown) => ({ accountId: 'zernio-account-1' })),
    mockDeleteAccount: vi.fn(async (_accountId: unknown) => undefined),
    authScopeAccountRows,
    sqlCalls,
    txCalls,
    txScenario,
    mockSql,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/shared/csrf', () => ({
  assertSameOrigin: vi.fn(),
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
  readConnectSessionCookie: () => 'session-1',
  clearConnectSessionCookie: vi.fn(),
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    selectLocation: (input: unknown) => mockSelectLocation(input),
    deleteAccount: (accountId: unknown) => mockDeleteAccount(accountId),
  },
}));

process.env.ZERNIO_PUBLISHING_ENABLED = 'true';

import { POST } from '../route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/zernio/connect/select-location', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locationId: 'google-location-1' }),
  });
}

describe('POST /api/zernio/connect/select-location account scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    txCalls.length = 0;
    authScopeAccountRows.value = [
      {
        subscription_status: 'active',
        past_due_at: null,
        flags: {},
      },
    ];
    txScenario.importConsent = 'pending';
    txScenario.accountSubscriptionActivatedAt = new Date('2026-05-01T00:00:00.000Z');
    txScenario.existingConnectionId = null;
    mockRequireRole.mockResolvedValue({
      id: 'user-1',
      role: 'owner',
      accountId: ACCOUNT_ID,
      locationId: PRIMARY_LOCATION_ID,
    });
  });

  it('allows finalizing a secondary RepWorth location owned by the same account', async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockSelectLocation).toHaveBeenCalledWith({
      profileId: 'profile-secondary',
      pendingDataToken: 'pending-token',
      connectToken: 'connect-token',
      locationId: 'google-location-1',
    });
    expect(sqlCalls[0]?.values).toContain(SECONDARY_LOCATION_ID);
    expect(sqlCalls[0]?.values).toContain(ACCOUNT_ID);
  });

  it('uses account subscription fields under a row lock when enqueueing initial backfill', async () => {
    // The enqueue is consent-gated from #677 on; this test is about the row lock
    // and the payload, so it opts in to an accepted offer.
    txScenario.importConsent = 'accepted';

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const scopeQuery = txCalls.find((call) =>
      /subscription_activated_at[\s\S]*FROM businesses b[\s\S]*JOIN accounts a/.test(call.raw),
    );
    expect(scopeQuery?.raw).toMatch(/FOR UPDATE OF b,\s*a/i);
    expect(scopeQuery?.values).toContain(SECONDARY_LOCATION_ID);
    expect(scopeQuery?.values).toContain(ACCOUNT_ID);

    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the rendered SQL text.
    const backfillInsert = txCalls.find((call) =>
      call.values.includes('zernio_initial_backfill'),
    );
    expect(backfillInsert).toBeDefined();
    expect(backfillInsert?.raw).not.toMatch(/FROM businesses WHERE id/);

    const payload = backfillInsert?.values.find(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        (value as { business_id?: string }).business_id === SECONDARY_LOCATION_ID,
    ) as { subscription_tier?: string; subscription_activated_at?: string } | undefined;
    expect(payload).toMatchObject({
      subscription_tier: 'copilot',
      subscription_activated_at: '2026-05-01T00:00:00.000Z',
    });
  });

  it('updates a stale active connection instead of failing on the active-connection unique index', async () => {
    txScenario.existingConnectionId = 'existing-connection-1';

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(txCalls.some((call) =>
      /UPDATE zernio_connections[\s\S]*SET/.test(call.raw) &&
      call.values.includes('existing-connection-1'),
    )).toBe(true);
    expect(txCalls.some((call) =>
      /INSERT INTO zernio_connections/.test(call.raw),
    )).toBe(false);
  });

  // 8c outcome-KNOWN failure: selectLocation rejects with a typed pre-mutation
  // error. The route reverts finalizing -> oauth_in_progress (best-effort
  // luaCASRevertToOauth) and rethrows the original error; no DB transaction runs.
  it('reverts to oauth_in_progress and surfaces 400 on a ZernioValidationError', async () => {
    mockSelectLocation.mockRejectedValueOnce(
      new ZernioValidationError('bad_location', { detail: 'rejected' }),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'zernio_validation_error',
      code: 'bad_location',
    });
    // Revert CAS fired with the correct script.
    expect(
      mockRedis.eval.mock.calls.some((call) => call[0] === luaCASRevertToOauth),
    ).toBe(true);
    // Outcome known -> no finalize transaction.
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('reverts to oauth_in_progress and surfaces 502 on a ZernioAuthError', async () => {
    mockSelectLocation.mockRejectedValueOnce(
      new ZernioAuthError(401, 'stale connect token'),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'zernio_auth_error' });
    expect(
      mockRedis.eval.mock.calls.some((call) => call[0] === luaCASRevertToOauth),
    ).toBe(true);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('rejects read-only past-due owners before finalizing or calling Zernio', async () => {
    authScopeAccountRows.value = [
      {
        subscription_status: 'past_due',
        past_due_at: '2024-01-01T00:00:00.000Z',
        flags: {},
      },
    ];

    const res = await POST(makeRequest());

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockRedis.eval).not.toHaveBeenCalled();
    expect(mockSelectLocation).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });
});
