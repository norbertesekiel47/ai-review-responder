import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';

const { mockRequireRole } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
}));

const { mockAssertWritableSubscriptionForAccount } = vi.hoisted(() => ({
  mockAssertWritableSubscriptionForAccount: vi.fn(),
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

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritableSubscriptionForAccount(...args),
}));

import {
  invalidBodyResponse,
  invalidJsonResponse,
  ownerAccountMismatchResponse,
  readLocationRouteJson,
  readOwnerForMultiLocationRoute,
} from '@/lib/locations/owner-route';
import { AuthError } from '@/lib/db/auth';

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const APP_URL = 'http://localhost:3000';

// The SUT threads `sql` into assertWritableSubscriptionForAccount, which is
// mocked above and ignores it — a sentinel stand-in is sufficient.
const fakeSql = {} as never;

function req(opts: { origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  const origin = opts.origin === undefined ? APP_URL : opts.origin;
  if (origin !== null) headers.Origin = origin;

  return new NextRequest('http://localhost:3000/api/locations/test', {
    method: 'POST',
    headers,
  });
}

function jsonReq(body: string) {
  return new NextRequest('http://localhost:3000/api/locations/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: APP_URL },
    body,
  });
}

describe('location owner route helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockReset();
    mockAssertWritableSubscriptionForAccount.mockReset();
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    process.env.MULTI_LOCATION_ENABLED = 'true';
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 404 before auth when multi-location is disabled', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';

    const result = await readOwnerForMultiLocationRoute(fakeSql, req());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      expect(await result.response.json()).toEqual({ error: 'not_found' });
    }
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('maps AuthError to the route response status and message', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const result = await readOwnerForMultiLocationRoute(fakeSql, req());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: 'Forbidden' });
    }
  });

  it('returns 403 before auth when Origin header is absent', async () => {
    mockRequireRole.mockResolvedValueOnce({ id: 'user-1', accountId: ACCOUNT_ID, role: 'owner' });

    const result = await readOwnerForMultiLocationRoute(fakeSql, req({ origin: null }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: 'forbidden' });
    }
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns an owner when auth succeeds and account is scoped', async () => {
    mockRequireRole.mockResolvedValueOnce({ id: 'user-1', accountId: ACCOUNT_ID, role: 'owner' });

    const result = await readOwnerForMultiLocationRoute(fakeSql, req());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.accountId).toBe(ACCOUNT_ID);
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID, expect.anything());
  });

  it('returns 402 when the account is past-due read-only', async () => {
    mockRequireRole.mockResolvedValueOnce({ id: 'user-1', accountId: ACCOUNT_ID, role: 'owner' });
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const result = await readOwnerForMultiLocationRoute(fakeSql, req());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(402);
      expect(await result.response.json()).toEqual({ error: 'past_due_read_only' });
    }
  });

  it('returns 403 when the authenticated user has no account', async () => {
    mockRequireRole.mockResolvedValueOnce({ id: 'user-1', accountId: null, role: 'owner' });

    const result = await readOwnerForMultiLocationRoute(fakeSql, req());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({
        error: 'No account associated with this user',
      });
    }
  });

  it('falls back to 401 when auth rejects with a non-AuthError', async () => {
    mockRequireRole.mockRejectedValueOnce(new Error('redis down'));

    const result = await readOwnerForMultiLocationRoute(fakeSql, req());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('builds the canonical account mismatch response', async () => {
    const response = ownerAccountMismatchResponse();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Account ID mismatch' });
  });
});

describe('readLocationRouteJson', () => {
  const schema = z.object({ accountId: z.string().min(1) });

  it('returns parsed data on valid JSON', async () => {
    const result = await readLocationRouteJson(jsonReq(JSON.stringify({ accountId: ACCOUNT_ID })), schema);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ accountId: ACCOUNT_ID });
  });

  it('returns invalidJsonResponse (400) on malformed JSON', async () => {
    const result = await readLocationRouteJson(jsonReq('not json'), schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({ error: 'invalid_json' });
    }
  });

  it('returns invalidBodyResponse (400) with Zod issues on schema failure', async () => {
    const result = await readLocationRouteJson(jsonReq(JSON.stringify({ accountId: '' })), schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toBe('invalid_body');
      expect(Array.isArray(body.issues)).toBe(true);
      expect(body.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('response helpers', () => {
  it('invalidJsonResponse is a 400 invalid_json', async () => {
    const response = invalidJsonResponse();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('invalidBodyResponse is a 400 invalid_body carrying the issues', async () => {
    const response = invalidBodyResponse([{ path: ['accountId'], message: 'Required' }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_body',
      issues: [{ path: ['accountId'], message: 'Required' }],
    });
  });
});
