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

import { resolveCookieIdentity, resolveAdminApiIdentity } from '../verified-identity';

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

describe('resolveAdminApiIdentity', () => {
  it.each(['/api/admin/x', '/api/admin', '/api/admin/impersonation-other/start', '/api/admin/impersonationevil', '/api/admin/x/impersonation/start'])(
    'refuses a cookie-only request to %s without constructing either SDK client',
    async (path) => {
      const request = new NextRequest('https://app.example.com' + path);
      request.cookies.set('sb-session', 'valid-admin-cookie');
      await expect(resolveAdminApiIdentity(request)).resolves.toBeNull();
      expect(cookieClients.count).toBe(0);
      expect(mockGetClaims).not.toHaveBeenCalled();
      expect(mockBearerGetUser).not.toHaveBeenCalled();
    },
  );

  it.each(['/api/admin/impersonation', '/api/admin/impersonation/start', '/api/admin/impersonation/end', '/API/ADMIN/IMPERSONATION/END/'])(
    'preserves the existing cookie path at %s',
    async (path) => {
      await expect(resolveAdminApiIdentity(new NextRequest('https://app.example.com' + path))).resolves.toMatchObject({ authUserId: AUTH_ID, transport: 'cookie' });
      expect(cookieClients.count).toBe(1);
      expect(mockGetClaims).not.toHaveBeenCalled();
    },
  );

  it.each(['Bearer t', 'Basic abc', '', 'Bearer'])('does not fall back inside impersonation with Authorization %s', async (authorization) => {
    const request = new NextRequest('https://app.example.com/api/admin/impersonation/start', { headers: { authorization } });
    const identity = await resolveAdminApiIdentity(request);
    if (authorization === 'Bearer t') expect(identity?.transport).toBe('bearer');
    else expect(identity).toBeNull();
    expect(cookieClients.count).toBe(0);
  });

  it('retains cookie identity only for the permanent impersonation prefix', async () => {
    await expect(resolveAdminApiIdentity(new NextRequest('https://app.example.com/api/admin/impersonation/start'))).resolves.toEqual({
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

    await expect(resolveAdminApiIdentity(req({ authorization: 'Bearer t' }))).resolves.toEqual({
      authUserId: AUTH_ID,
      aal: 'aal2',
      transport: 'bearer',
    });
  });

  it('reads the aal claim without enforcing it', async () => {
    mockGetClaims.mockResolvedValue(claims({ aal: 'aal1' }));

    await expect(resolveAdminApiIdentity(req({ authorization: 'Bearer t' }))).resolves.toEqual({
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
      await resolveAdminApiIdentity(req({ authorization }));
      expect(cookieClients.count).toBe(0);
    }
  });

  it('is blind to role — it returns facts, and the gate decides', async () => {
    // Nothing in the seam reads a users row, so there is no role to be wrong
    // about. This is the invariant that lets requireRole stay cookie-only while
    // requireAdminWithAal2 verifies the Admin app bearer (ADR 0025 D1).
    const identity = await resolveAdminApiIdentity(req({ authorization: 'Bearer t' }));

    expect(identity).not.toBeNull();
    expect(Object.keys(identity!).sort()).toEqual(['aal', 'authUserId', 'transport']);
  });
});

// ---------------------------------------------------------------------------
// The SDK premise the whole failure classification rests on
// ---------------------------------------------------------------------------
//
// Everything above stubs `getClaims`, so none of it can tell you whether the REAL
// SDK throws or returns for a given token — and the seam's rule ("a throw from
// either SDK await is a 401, the 500 arm is driven by the returned error type")
// is only correct if attacker-supplied garbage really does arrive as a THROW.
// This block asserts that against the installed auth-js, with no stub, so a
// dependency bump that moves a shape from one channel to the other fails HERE
// with a clear reason instead of silently reclassifying an outage.

describe('@supabase/auth-js decode channel (the premise, unstubbed)', () => {
  it('throws non-AuthError for malformed tokens that pass its shape checks', async () => {
    const { createClient: realCreateClient, isAuthError } =
      await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    const real = realCreateClient('https://project.supabase.co', 'anon-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Three segments, all valid base64url, so decodeJWT's regex passes and its
    // JSON.parse (or the UTF-8 decode) is what fails. No network is reached.
    const thrownShapes = [
      'ew.e30.AA', // header decodes to `{`      → SyntaxError
      'bnVsbA.e30.AA', // header decodes to `null`   → TypeError on header.alg
      'aaaa.bbbb.cccc', // invalid UTF-8              → Error
    ];

    for (const token of thrownShapes) {
      // `.rejects.toThrow()` alone is NOT enough, and the name of this test is the
      // reason: an `AuthError` satisfies it too, so the exact channel move that
      // matters — a thrown `AuthApiError(500)`, which the seam's catch would turn
      // into a 401 and let an unauthenticated caller force admin 500s past — would
      // keep it green. Assert the CHANNEL and the KIND.
      const thrown = await real.auth
        .getClaims(token, { allowExpired: true })
        .then(() => null)
        .catch((err: unknown) => err);

      expect(thrown, `expected ${token} to THROW, not return`).not.toBeNull();
      expect(isAuthError(thrown), `expected ${token} to throw a NON-AuthError`).toBe(false);
    }
  });

  it('RETURNS an AuthError for a token that fails its shape checks', async () => {
    // The other side of the same boundary: decodeJWT's own AuthInvalidJwtError is
    // an AuthError, so getClaims' internal catch returns it. If this ever throws
    // instead, the seam still answers 401 — but the comment explaining why would
    // be wrong, which on an auth seam is its own defect.
    const { createClient: realCreateClient } =
      await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    const real = realCreateClient('https://project.supabase.co', 'anon-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const result = await real.auth.getClaims('abc', { allowExpired: true });

    expect(result.data).toBeNull();
    expect(result.error?.name).toBe('AuthInvalidJwtError');
  });
});
