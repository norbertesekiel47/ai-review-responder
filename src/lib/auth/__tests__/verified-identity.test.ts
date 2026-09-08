// src/lib/auth/__tests__/verified-identity.test.ts
//
// The seam's OWN contract, as its two callers see it. ./admin-transport-seam.test.ts
// drives the seam through the gate and therefore only ever observes what the gate
// chose to expose; this file asserts the `VerifiedIdentity` shape directly —
// including `transport`, which the gate discards and which #1185 (`src/proxy.ts`)
// and #1186 (CORS) are the first consumers of.
//
// It also pins the seam's ONE structural promise: it decides nothing. No role is
// read, no AAL is enforced, no flag is consulted — an `aal1` non-admin resolves
// exactly as successfully as an `aal2` admin, and the refusal is the gate's job.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockGetClaims, mockBearerGetUser, mockCookieGetUser, mockCookieAal, cookieClients } =
  vi.hoisted(() => ({
    mockGetClaims: vi.fn(),
    mockBearerGetUser: vi.fn(),
    mockCookieGetUser: vi.fn(),
    mockCookieAal: vi.fn(),
    cookieClients: { count: 0 },
  }));

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: () => ({
      auth: {
        getClaims: (...a: unknown[]) => mockGetClaims(...a),
        getUser: (...a: unknown[]) => mockBearerGetUser(...a),
      },
    }),
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => {
    cookieClients.count += 1;
    return {
      auth: {
        getUser: (...a: unknown[]) => mockCookieGetUser(...a),
        mfa: { getAuthenticatorAssuranceLevel: (...a: unknown[]) => mockCookieAal(...a) },
      },
    };
  },
}));

vi.mock('@/lib/db/server', () => ({ sql: () => Promise.resolve([]) }));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { resolveCookieIdentity, resolveDualModeIdentity } from '../verified-identity';

const AUTH_ID = 'auth-1';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/x', { method: 'POST', headers });
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      claims: {
        sub: AUTH_ID,
        aal: 'aal2',
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...overrides,
      },
      header: { alg: 'ES256', kid: 'k', typ: 'JWT' },
      signature: new Uint8Array(),
    },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieClients.count = 0;
  mockCookieGetUser.mockResolvedValue({ data: { user: { id: AUTH_ID } }, error: null });
  mockCookieAal.mockResolvedValue({
    data: { currentLevel: 'aal2', nextLevel: 'aal2' },
    error: null,
  });
  mockGetClaims.mockResolvedValue(claims());
  mockBearerGetUser.mockResolvedValue({ data: { user: { id: AUTH_ID } }, error: null });
});

describe('resolveCookieIdentity', () => {
  it('reports the cookie transport and the AAL verbatim', async () => {
    await expect(resolveCookieIdentity(req())).resolves.toEqual({
      authUserId: AUTH_ID,
      aal: 'aal2',
      transport: 'cookie',
    });
  });

  it('passes a non-aal2 level through instead of refusing it', async () => {
    // The seam DECIDES NOTHING: 'aal1' is a fact it reports, and turning it into
    // mfa_required is the gate's job. A seam that refused here would put the
    // enforcement in two places, which is how the proxy and the gate ended up
    // disagreeing about lenient vs strict AAL in the first place.
    mockCookieAal.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    await expect(resolveCookieIdentity(req())).resolves.toEqual({
      authUserId: AUTH_ID,
      aal: 'aal1',
      transport: 'cookie',
    });
  });

  it('normalizes an unreadable AAL to null rather than inventing a level', async () => {
    for (const outcome of [
      { data: null, error: new Error('unreachable') },
      { data: null, error: null },
      { data: { currentLevel: null, nextLevel: null }, error: null },
    ]) {
      mockCookieAal.mockResolvedValue(outcome);
      await expect(resolveCookieIdentity(req())).resolves.toMatchObject({ aal: null });
    }
  });

  it('returns null when there is no live cookie session', async () => {
    mockCookieGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(resolveCookieIdentity(req())).resolves.toBeNull();
    // The AAL read is skipped once identity fails — no point paying for it.
    expect(mockCookieAal).not.toHaveBeenCalled();
  });
});

describe('resolveDualModeIdentity', () => {
  it('delegates to the cookie resolver when no Authorization header is present', async () => {
    await expect(resolveDualModeIdentity(req())).resolves.toEqual({
      authUserId: AUTH_ID,
      aal: 'aal2',
      transport: 'cookie',
    });
    expect(cookieClients.count).toBe(1);
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it('reports the bearer transport and takes authUserId from the VERIFIED claims', async () => {
    // claims.sub, not getUser().data.user.id: getClaims is the locally verified
    // source, so it owns the identity. They agree here by construction, and the
    // divergent stub proves which one the seam actually reads.
    mockBearerGetUser.mockResolvedValue({ data: { user: { id: 'a-different-id' } }, error: null });

    await expect(resolveDualModeIdentity(req({ authorization: 'Bearer t' }))).resolves.toEqual({
      authUserId: AUTH_ID,
      aal: 'aal2',
      transport: 'bearer',
    });
  });

  it('reads the aal claim without enforcing it', async () => {
    mockGetClaims.mockResolvedValue(claims({ aal: 'aal1' }));

    await expect(resolveDualModeIdentity(req({ authorization: 'Bearer t' }))).resolves.toEqual({
      authUserId: AUTH_ID,
      aal: 'aal1',
      transport: 'bearer',
    });
  });

  it('never constructs a cookie client once an Authorization header is present', async () => {
    // The no-fallback rule at the seam's own boundary. The gate-level suite proves
    // the refusal; this proves the cookie transport is not even reached, which is
    // what makes "a bearer wins" structural rather than incidental.
    for (const authorization of ['Bearer t', 'Basic abc', '', 'Bearer']) {
      cookieClients.count = 0;
      await resolveDualModeIdentity(req({ authorization }));
      expect(cookieClients.count).toBe(0);
    }
  });

  it('is blind to role — it returns facts, and the gate decides', async () => {
    // Nothing in the seam reads a users row, so there is no role to be wrong
    // about. This is the invariant that lets requireRole stay cookie-only while
    // requireAdminWithAal2 goes dual-mode (ADR 0025 D1).
    const identity = await resolveDualModeIdentity(req({ authorization: 'Bearer t' }));

    expect(identity).not.toBeNull();
    expect(Object.keys(identity!).sort()).toEqual(['aal', 'authUserId', 'transport']);
  });
});
