import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const { mockRequireRole, mockGetRequestScope, mockSql } = vi.hoisted(() => {
  return {
    mockRequireRole: vi.fn(),
    mockGetRequestScope: vi.fn(),
    // Tagged-template sql`...` mock. Default resolves to an ACTIVE account so
    // the subscription gate passes; individual tests override with mockResolvedValueOnce.
    mockSql: vi.fn(),
  };
});

// ── Mocks ───────────────────────────────────────────────────────────

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

vi.mock('@/lib/db/server', () => ({
  sql: (...args: unknown[]) => mockSql(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
  // Default: accounts.subscription_status lookup returns ACTIVE.
  mockSql.mockResolvedValue([{ subscription_status: 'active' }]);
});

// ── Tests ───────────────────────────────────────────────────────────

describe('resolveOwnerScope', () => {
  it('happy path: no cookie → calls getRequestScope with null → returns primary location + userId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(makeRequest());

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: LOCATION_ID, userId: USER_ID });
    // null cookie → cookieLocationId is null → getRequestScope called with null
    expect(mockGetRequestScope).toHaveBeenCalledWith(ACCOUNT_ID, null);
  });

  it('cookie with valid UUID → passes that UUID to getRequestScope → returns cookie location + userId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(makeRequest({ locationScopeCookie: ALT_LOCATION_ID }));

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: ALT_LOCATION_ID, userId: USER_ID });
    expect(mockGetRequestScope).toHaveBeenCalledWith(ACCOUNT_ID, ALT_LOCATION_ID);
  });

  it('cookie with invalid (non-UUID) value → treated as null → passes null to getRequestScope', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(makeRequest({ locationScopeCookie: 'not-a-uuid' }));

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: LOCATION_ID, userId: USER_ID });
    expect(mockGetRequestScope).toHaveBeenCalledWith(ACCOUNT_ID, null);
  });

  it('requireRole throws AuthError → throws ScopeError with same message + statusCode', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const { resolveOwnerScope, ScopeError } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(makeRequest())).rejects.toThrow(ScopeError);
    await expect(resolveOwnerScope(makeRequest())).rejects.toMatchObject({
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

    await expect(resolveOwnerScope(makeRequest())).rejects.toThrow(ScopeError);
    await expect(resolveOwnerScope(makeRequest())).rejects.toMatchObject({
      message: 'unauthorized',
      statusCode: 401,
    });
  });

  it('user.accountId is null → throws ScopeError 403 no_business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ accountId: null }));
    const { resolveOwnerScope, ScopeError } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(makeRequest())).rejects.toThrow(ScopeError);
    await expect(resolveOwnerScope(makeRequest())).rejects.toMatchObject({
      message: 'no_business',
      statusCode: 403,
    });
    // getRequestScope must NOT be called when accountId is missing.
    expect(mockGetRequestScope).not.toHaveBeenCalled();
  });

  it('non-ACTIVE subscription (cancelled) → throws ScopeError 403 subscription_inactive, getRequestScope NOT called', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSql.mockResolvedValueOnce([{ subscription_status: 'cancelled' }]);
    const { resolveOwnerScope, ScopeError } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(makeRequest())).rejects.toThrow(ScopeError);
    expect(mockGetRequestScope).not.toHaveBeenCalled();
  });

  it('non-ACTIVE subscription error carries message subscription_inactive + statusCode 403', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSql.mockResolvedValueOnce([{ subscription_status: 'past_due' }]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(makeRequest())).rejects.toMatchObject({
      message: 'subscription_inactive',
      statusCode: 403,
    });
    expect(mockGetRequestScope).not.toHaveBeenCalled();
  });

  it('account row missing → throws ScopeError 403 no_business, getRequestScope NOT called', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSql.mockResolvedValueOnce([]);
    const { resolveOwnerScope } = await importResolveOwnerScope();

    await expect(resolveOwnerScope(makeRequest())).rejects.toMatchObject({
      message: 'no_business',
      statusCode: 403,
    });
    expect(mockGetRequestScope).not.toHaveBeenCalled();
  });
});
