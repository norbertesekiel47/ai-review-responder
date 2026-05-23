import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const { mockRequireRole, mockGetRequestScope } = vi.hoisted(() => {
  return {
    mockRequireRole: vi.fn(),
    mockGetRequestScope: vi.fn(),
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

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
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
});

// ── Tests ───────────────────────────────────────────────────────────

describe('resolveOwnerScope', () => {
  it('happy path: no cookie → calls getRequestScope with null → returns primary location', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(makeRequest());

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: LOCATION_ID });
    // null cookie → cookieLocationId is null → getRequestScope called with null
    expect(mockGetRequestScope).toHaveBeenCalledWith(ACCOUNT_ID, null);
  });

  it('cookie with valid UUID → passes that UUID to getRequestScope → returns cookie location', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(makeRequest({ locationScopeCookie: ALT_LOCATION_ID }));

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: ALT_LOCATION_ID });
    expect(mockGetRequestScope).toHaveBeenCalledWith(ACCOUNT_ID, ALT_LOCATION_ID);
  });

  it('cookie with invalid (non-UUID) value → treated as null → passes null to getRequestScope', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { resolveOwnerScope } = await importResolveOwnerScope();

    const result = await resolveOwnerScope(makeRequest({ locationScopeCookie: 'not-a-uuid' }));

    expect(result).toEqual({ accountId: ACCOUNT_ID, locationId: LOCATION_ID });
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
});
