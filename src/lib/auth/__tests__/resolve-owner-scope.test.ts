import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

// ── Hoisted shared state ────────────────────────────────────────────

const { mockRequireRole, mockGetRequestScope } = vi.hoisted(() => {
  return {
    mockRequireRole: vi.fn(),
    mockGetRequestScope: vi.fn(),
  };
});

// ── Mocks ───────────────────────────────────────────────────────────
// resolveOwnerScope is born-injected (sql is a parameter, A+ campaign PR 2a),
// so @/lib/db/server no longer needs mocking here — the fragment-aware
// createMockSql harness stands in for `sql` directly. getRequestScope stays
// mocked to isolate resolveOwnerScope's own subscription-gate + delegation logic.

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

vi.mock('@/lib/auth/get-request-scope', () => ({
  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
}));

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
const USER_ID = 'user-1';
const APP_URL = 'http://localhost:3000';

function ownerUser(overrides?: Partial<{ accountId: string | null }>) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides && 'accountId' in overrides ? overrides.accountId : ACCOUNT_ID,
  };
}

function makeRequest(opts?: { locationScopeCookie?: string }): NextRequest {
  const headers: Record<string, string> = { Origin: APP_URL };
  if (opts?.locationScopeCookie) {
    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
  }
  return new NextRequest(`${APP_URL}/api/test`, { method: 'POST', headers });
}

async function importResolveOwnerScope() {
  const mod = await import('@/lib/auth/resolve-owner-scope');
  return { resolveOwnerScope: mod.resolveOwnerScope, ScopeError: mod.ScopeError };
}

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  vi.clearAllMocks();
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
});

// ── Tests ───────────────────────────────────────────────────────────

describe('resolveOwnerScope', () => {
  it('happy path: no cookie → calls getRequestScope with null → returns primary location + userId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    harness.sqlReturnQueue.push([{ subscription_status: 'active', past_due_at: null, flags: {} }]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(mockSql, makeRequest());

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: LOCATION_ID, userId: USER_ID });
    // null cookie → cookieLocationId is null → getRequestScope called with null
    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, null);
  });

  it('cookie with valid UUID → passes that UUID to getRequestScope → returns cookie location + userId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    harness.sqlReturnQueue.push([{ subscription_status: 'active', past_due_at: null, flags: {} }]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(mockSql, makeRequest({ locationScopeCookie: ALT_LOCATION_ID }));

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: ALT_LOCATION_ID, userId: USER_ID });
    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, ALT_LOCATION_ID);
  });

  it('cookie with invalid (non-UUID) value → treated as null → passes null to getRequestScope', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    harness.sqlReturnQueue.push([{ subscription_status: 'active', past_due_at: null, flags: {} }]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(mockSql, makeRequest({ locationScopeCookie: 'not-a-uuid' }));

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: LOCATION_ID, userId: USER_ID });
    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, null);
  });

  it('requireRole throws AuthError → throws ScopeError with same message + statusCode', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const { resolveOwnerScope, ScopeError } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toThrow(ScopeError);
    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toMatchObject({
      message: 'Unauthorized',
      statusCode: 401,
    });
  });

  it('requireRole throws non-AuthError plain Error → wraps as ScopeError 401 (catch-all)', async () => {
    // A plain Error is not instanceof AuthError (different class identity in vitest mock context),
    // so the catch-all branch fires and wraps it as ScopeError('unauthorized', 401).
    const boom = new Error('unexpected DB crash');
    mockRequireRole.mockRejectedValue(boom);
    const { resolveOwnerScope, ScopeError } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toThrow(ScopeError);
    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toMatchObject({
      message: 'unauthorized',
      statusCode: 401,
    });
  });

  it('user.accountId is null → throws ScopeError 403 no_business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ accountId: null }));
    const { resolveOwnerScope, ScopeError } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toThrow(ScopeError);
    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toMatchObject({
      message: 'no_business',
      statusCode: 403,
    });
    // getRequestScope must NOT be called when accountId is missing.
    expect(mockGetRequestScope).not.toHaveBeenCalled();
  });

  it('non-ACTIVE subscription (cancelled) → throws ScopeError 403 subscription_inactive, getRequestScope NOT called', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    harness.sqlReturnQueue.push([{ subscription_status: 'cancelled' }]);
    const { resolveOwnerScope, ScopeError } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toThrow(ScopeError);
    expect(mockGetRequestScope).not.toHaveBeenCalled();
  });

  it('trialing subscription resolves scope (treated like active)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    harness.sqlReturnQueue.push([{ subscription_status: 'trialing', past_due_at: null, flags: {} }]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest())).resolves.toEqual({
      accountId: ACCOUNT_ID,
      locationId: LOCATION_ID,
      userId: USER_ID,
    });
    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, null);
  });

  it('past_due subscription inside recovery window resolves scope', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    harness.sqlReturnQueue.push([{
      subscription_status: 'past_due',
      past_due_at: new Date(Date.now() - 2 * 86_400_000),
      flags: {},
    }]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest())).resolves.toEqual({
      accountId: ACCOUNT_ID,
      locationId: LOCATION_ID,
      userId: USER_ID,
    });
    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, null);
  });

  it('past_due subscription after recovery window throws 402 past_due_read_only', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    harness.sqlReturnQueue.push([{
      subscription_status: 'past_due',
      past_due_at: new Date(Date.now() - 8 * 86_400_000),
      flags: {},
    }]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toMatchObject({
      message: 'past_due_read_only',
      statusCode: 402,
    });
    expect(mockGetRequestScope).not.toHaveBeenCalled();
  });

  it('past_due subscription after recovery window resolves when read-only access is allowed', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    harness.sqlReturnQueue.push([{
      subscription_status: 'past_due',
      past_due_at: new Date(Date.now() - 8 * 86_400_000),
      flags: {},
    }]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest(), { allowReadOnly: true })).resolves.toEqual({
      accountId: ACCOUNT_ID,
      locationId: LOCATION_ID,
      userId: USER_ID,
    });
    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, null);
  });

  it('account row missing → throws ScopeError 403 no_business, getRequestScope NOT called', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    harness.sqlReturnQueue.push([]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(mockSql, makeRequest())).rejects.toMatchObject({
      message: 'no_business',
      statusCode: 403,
    });
    expect(mockGetRequestScope).not.toHaveBeenCalled();
  });
});
