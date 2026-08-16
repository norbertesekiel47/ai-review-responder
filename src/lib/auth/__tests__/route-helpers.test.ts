// src/lib/auth/__tests__/route-helpers.test.ts
//
// TDD assertions for the composable route wrapper `withSameOrigin` and the
// owner/role gates. Mocks are hoisted so module-under-test can be imported
// cleanly.
//
// `withRateLimit` and `withSession` used to be tested here. Both were deleted in
// the H5 mechanical bundle — zero production callers, so the only thing keeping
// them alive was this file.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mock state ───────────────────────────────────────────────────────

const { mockRequireRole } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
}));

const { mockGetOffboardingState, mockIsOperationalUIBlocked } = vi.hoisted(() => ({
  mockGetOffboardingState: vi.fn(),
  mockIsOperationalUIBlocked: vi.fn(),
}));

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: mockRequireRole,
    AuthError,
  };
});

vi.mock('@/lib/account-offboarding/gate', () => ({
  getOffboardingState: mockGetOffboardingState,
  isOperationalUIBlocked: mockIsOperationalUIBlocked,
}));

// ── Import AFTER mocks ───────────────────────────────────────────────────────

import {
  withSameOrigin,
  requireRoleOr401,
  requireOwnerWithAccount,
  requireSettingsOwner,
} from '../route-helpers';
import type postgres from 'postgres';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ──────────────────────────────────────────────────────────────────

const APP_URL = 'https://app.example.com';

function makeReq(
  url = 'https://app.example.com/api/auth/signup',
  opts: { origin?: string; method?: string; secFetchSite?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.secFetchSite !== undefined) headers['sec-fetch-site'] = opts.secFetchSite;
  return new NextRequest(url, {
    method: opts.method ?? 'POST',
    headers,
  });
}

const okHandler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

// ── withSameOrigin ────────────────────────────────────────────────────────────

describe('withSameOrigin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    okHandler.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it('calls handler when Origin matches APP_URL', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, { origin: APP_URL }));

    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it('calls handler when Sec-Fetch-Site is same-origin and Origin matches APP_URL', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, {
      origin: APP_URL,
      secFetchSite: 'same-origin',
    }));

    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it('returns 403 when Sec-Fetch-Site is cross-site', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, {
      origin: APP_URL,
      secFetchSite: 'cross-site',
    }));

    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin does not match', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, { origin: 'https://evil.example.com' }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'forbidden' });
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin header is absent', async () => {
    const wrapped = withSameOrigin()(okHandler);
    // No origin header — missing Origin means SameOriginError
    const res = await wrapped(makeReq(undefined, {}));

    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('returns 403 when NEXT_PUBLIC_APP_URL is unset', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, { origin: APP_URL }));

    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('accepts trailing-slash variant of APP_URL', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, { origin: `${APP_URL}/` }));

    expect(res.status).toBe(200);
  });
});

// ── requireRoleOr401 ───────────────────────────────────────────────────────────
//
// The single role-auth gate shared by every admin/owner/channel API route.
// Contract:
//   - success → { ok: true, user }
//   - AuthError → { ok: false, response } as a no-store JSON body carrying the
//     AuthError's message + statusCode (401 unauth / 403 forbidden)
//   - any other (unexpected, non-AuthError) failure → THROWS, surfacing a real
//     5xx rather than a misleading 401-mask. This is the one deliberate
//     behavior change of the auth-gate unification.

describe('requireRoleOr401', () => {
  const fakeUser = { id: 'u-1', name: 'Owner', email: 'o@example.com', role: 'owner', accountId: 'a-1', locationId: 'b-1' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { ok: true, user } and forwards the role to requireRole', async () => {
    mockRequireRole.mockResolvedValue(fakeUser);
    const req = makeReq();

    const result = await requireRoleOr401(req, 'owner');

    expect(result).toEqual({ ok: true, user: fakeUser });
    expect(mockRequireRole).toHaveBeenCalledWith(req, 'owner');
  });

  it('forwards the admin role through to requireRole', async () => {
    mockRequireRole.mockResolvedValue({ ...fakeUser, role: 'admin' });
    const req = makeReq();

    await requireRoleOr401(req, 'admin');

    expect(mockRequireRole).toHaveBeenCalledWith(req, 'admin');
  });

  it('maps AuthError(401) to a no-store 401 JSON response', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const result = await requireRoleOr401(makeReq(), 'owner');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
    expect(result.response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('maps AuthError(403) to a 403 JSON response carrying the message', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const result = await requireRoleOr401(makeReq(), 'admin');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'Forbidden' });
  });

  it('THROWS on an unexpected non-AuthError failure (no 401-mask → real 5xx)', async () => {
    mockRequireRole.mockRejectedValue(new Error('unexpected DB crash'));

    await expect(requireRoleOr401(makeReq(), 'owner')).rejects.toThrow('unexpected DB crash');
  });
});

// ── requireOwnerWithAccount ─────────────────────────────────────────────────
//
// Owner read-gate (the account-scoped subset of requireWritableOwner, minus the
// writable-subscription check): requireRoleOr401('owner') → account presence.

describe('requireOwnerWithAccount', () => {
  const ownerUser = { id: 'u-1', name: 'Owner', email: 'o@x.com', role: 'owner', accountId: 'acct-1', locationId: 'loc-1' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { ok: true, user, accountId } when an owner with an account resolves', async () => {
    mockRequireRole.mockResolvedValue(ownerUser);

    const result = await requireOwnerWithAccount(makeReq());

    expect(result).toEqual({ ok: true, user: ownerUser, accountId: 'acct-1' });
    expect(mockRequireRole).toHaveBeenCalledWith(expect.anything(), 'owner');
  });

  it('returns 403 no-account (no-store) when the owner has no accountId', async () => {
    mockRequireRole.mockResolvedValue({ ...ownerUser, accountId: null });

    const result = await requireOwnerWithAccount(makeReq());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'No account associated with this user' });
    expect(result.response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('forwards the AuthError response (401) when auth fails', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const result = await requireOwnerWithAccount(makeReq());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(401);
  });
});

// ── requireSettingsOwner ────────────────────────────────────────────────────
//
// The /api/settings/* owner gate: ?accountId rejection → requireOwnerWithAccount
// → operational-UI offboarding gate. The rejection ordering is asserted, not
// assumed — resolving an owner first would half-honour a tenant-selection knob
// these routes never accept.

describe('requireSettingsOwner', () => {
  const ownerUser = { id: 'u-1', name: 'Owner', email: 'o@x.com', role: 'owner', accountId: 'acct-1', locationId: 'loc-1' };
  const fakeSql = {} as unknown as postgres.Sql;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOffboardingState.mockResolvedValue(null);
    mockIsOperationalUIBlocked.mockReturnValue(false);
  });

  it('requireSettingsOwner rejects an accountId query parameter with 400', async () => {
    mockRequireRole.mockResolvedValue(ownerUser);

    const result = await requireSettingsOwner(
      fakeSql,
      makeReq('https://app.example.com/api/settings/competitors?accountId=acct-2'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: 'account_id_not_allowed' });
    // Rejected BEFORE the owner is resolved — the order is the guard.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockGetOffboardingState).not.toHaveBeenCalled();
  });

  it('requireSettingsOwner returns 403 when offboarding blocks the operational UI', async () => {
    mockRequireRole.mockResolvedValue(ownerUser);
    mockGetOffboardingState.mockResolvedValue({ mode: 'delete_data' });
    mockIsOperationalUIBlocked.mockReturnValue(true);

    const result = await requireSettingsOwner(fakeSql, makeReq());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(result.response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetOffboardingState).toHaveBeenCalledWith('acct-1', fakeSql);
  });

  it('requireSettingsOwner forwards the owner when the account is not offboarding', async () => {
    mockRequireRole.mockResolvedValue(ownerUser);

    const result = await requireSettingsOwner(fakeSql, makeReq());

    expect(result).toEqual({ ok: true, user: ownerUser, accountId: 'acct-1' });
  });

  it('forwards the AuthError response (401) without touching the offboarding gate', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const result = await requireSettingsOwner(fakeSql, makeReq());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(401);
    expect(mockGetOffboardingState).not.toHaveBeenCalled();
  });
});
