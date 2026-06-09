import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  mockRequireOwnerWithAccount,
  mockCookieBackedServerClient,
  mockRequireAal2FromSupabase,
} = vi.hoisted(() => ({
  mockRequireOwnerWithAccount: vi.fn(),
  mockCookieBackedServerClient: vi.fn(),
  mockRequireAal2FromSupabase: vi.fn(),
}));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    requireOwnerWithAccount: mockRequireOwnerWithAccount,
  };
});

vi.mock('@/lib/db/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/auth')>();
  return {
    ...actual,
    cookieBackedServerClient: mockCookieBackedServerClient,
  };
});

vi.mock('@/lib/auth/mfa', () => ({
  requireAal2FromSupabase: mockRequireAal2FromSupabase,
}));

import {
  FRESH_AUTH_COOKIE_NAME,
  FRESH_AUTH_WINDOW_MS,
  requireDeleteDataDestructiveAuth,
  signFreshAuthStamp,
} from '../destructive-auth';

const APP_URL = 'https://app.example.com';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const NOW = new Date('2026-06-05T12:00:00.000Z');

function ownerUser() {
  return {
    id: USER_ID,
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: '99999999-8888-7777-8666-555555555555',
  };
}

function makeRequest(options: {
  origin?: string;
  freshAuthValue?: string;
  secFetchSite?: string;
} = {}): NextRequest {
  const headers: Record<string, string> = {
    origin: options.origin ?? APP_URL,
  };
  if (options.secFetchSite) headers['sec-fetch-site'] = options.secFetchSite;
  if (options.freshAuthValue) {
    headers.cookie = `${FRESH_AUTH_COOKIE_NAME}=${options.freshAuthValue}`;
  }
  return new NextRequest(`${APP_URL}/api/account/offboarding/confirm`, {
    method: 'POST',
    headers,
  });
}

function freshStamp(issuedAt = NOW): string {
  return signFreshAuthStamp({
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    issuedAt,
  });
}

describe('requireDeleteDataDestructiveAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('SESSION_COOKIE_SECRET', 'test-session-cookie-secret-at-least-32-chars');
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: ownerUser(),
      accountId: ACCOUNT_ID,
    });
    mockCookieBackedServerClient.mockReturnValue({ auth: { mfa: {} } });
    mockRequireAal2FromSupabase.mockResolvedValue({ ok: true });
  });

  it('rejects cross-origin delete-data attempts before owner auth', async () => {
    const result = await requireDeleteDataDestructiveAuth(makeRequest({
      origin: 'https://evil.example.com',
      freshAuthValue: freshStamp(),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: 'forbidden' });
    }
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockRequireAal2FromSupabase).not.toHaveBeenCalled();
  });

  it('returns the owner auth failure when no session is present', async () => {
    mockRequireOwnerWithAccount.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const result = await requireDeleteDataDestructiveAuth(makeRequest({
      freshAuthValue: freshStamp(),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
    }
    expect(mockRequireAal2FromSupabase).not.toHaveBeenCalled();
  });

  it('rejects stale fresh-auth stamps without consulting MFA state', async () => {
    const stale = new Date(NOW.getTime() - FRESH_AUTH_WINDOW_MS - 1);

    const result = await requireDeleteDataDestructiveAuth(makeRequest({
      freshAuthValue: freshStamp(stale),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: 'fresh_auth_required' });
    }
    expect(mockRequireAal2FromSupabase).not.toHaveBeenCalled();
  });

  it('rejects signed fresh-auth stamps bound to another account', async () => {
    const otherAccountStamp = signFreshAuthStamp({
      userId: USER_ID,
      accountId: 'bbbbbbbb-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      issuedAt: NOW,
    });

    const result = await requireDeleteDataDestructiveAuth(makeRequest({
      freshAuthValue: otherAccountStamp,
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: 'fresh_auth_required' });
    }
    expect(mockRequireAal2FromSupabase).not.toHaveBeenCalled();
  });

  it('rejects enrolled MFA accounts when the current session is still AAL1', async () => {
    mockRequireAal2FromSupabase.mockResolvedValueOnce({
      ok: false,
      reason: 'mfa_required',
    });

    const result = await requireDeleteDataDestructiveAuth(makeRequest({
      freshAuthValue: freshStamp(),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: 'mfa_required' });
    }
  });

  it('fails closed when Supabase cannot report the current MFA assurance level', async () => {
    mockRequireAal2FromSupabase.mockResolvedValueOnce({
      ok: false,
      reason: 'mfa_check_failed',
    });

    const result = await requireDeleteDataDestructiveAuth(makeRequest({
      freshAuthValue: freshStamp(),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: 'mfa_check_failed' });
    }
  });

  it('allows a same-origin owner with fresh auth and current AAL2', async () => {
    const result = await requireDeleteDataDestructiveAuth(makeRequest({
      freshAuthValue: freshStamp(),
    }));

    expect(result).toEqual({
      ok: true,
      user: ownerUser(),
      accountId: ACCOUNT_ID,
    });
    expect(mockCookieBackedServerClient).toHaveBeenCalledOnce();
    expect(mockRequireAal2FromSupabase).toHaveBeenCalledWith({ auth: { mfa: {} } });
  });
});
