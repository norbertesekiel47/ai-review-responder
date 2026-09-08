// src/lib/auth/__tests__/admin-transport-seam.test.ts
//
// THE dual-mode contract for #1183 (ADR 0025 D1-D4, D9, D10). One file, because
// the thing under test is a single contract — **Verified admin** reachable from
// EITHER **Admin transport** — and splitting it across the gate, the seam and the
// owner gate would let a reader believe each half was the whole.
//
// EVERYTHING IS MOCKED AT THE SDK BOUNDARY, never at a module boundary: only
// `@supabase/ssr`, `@supabase/supabase-js` and `@/lib/db/server` are replaced, so
// the gate, the seam, the predicate and `loadAppUser` all run for real. Mocking
// `@/lib/db/auth`'s exports instead would prove nothing about the cookie path,
// because `getCurrentUser` calls `cookieBackedServerClient` and `loadAppUser`
// through module scope, where an export mock never intercepts.
//
// Every refusal case asserts status + exact JSON body + Cache-Control + the
// ABSENCE of a Location header. A cross-origin API must not redirect (ADR D9), and
// a redirect is exactly the regression a status-only assertion misses. The one
// exception is "cookie + cross-origin still 403", which pins withSameOrigin()'s
// OWN response shape: that wrapper sets no cache header
// (src/lib/auth/route-helpers.ts:33) and this ticket does not touch it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockCreateClient,
  mockGetClaims,
  mockBearerGetUser,
  mockCookieGetUser,
  mockCookieAal,
  sqlRows,
  cookieClientCalls,
} = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockGetClaims: vi.fn(),
  mockBearerGetUser: vi.fn(),
  mockCookieGetUser: vi.fn(),
  mockCookieAal: vi.fn(),
  sqlRows: { next: [] as unknown[], error: null as Error | null },
  cookieClientCalls: { count: 0 },
}));

// The bearer client. createClient is mocked so the options the seam passes are
// observable and so no network call is ever attempted.
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: (...args: unknown[]) => {
      mockCreateClient(...args);
      return {
        auth: {
          getClaims: (...a: unknown[]) => mockGetClaims(...a),
          getUser: (...a: unknown[]) => mockBearerGetUser(...a),
        },
      };
    },
  };
});

// The cookie client. cookieClientCalls.count is the fallback detector: several
// cases assert the cookie path was NEVER entered, and counting construction is the
// only way to prove a bearer refusal did not quietly retry the other transport.
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => {
    cookieClientCalls.count += 1;
    return {
      auth: {
        getUser: (...a: unknown[]) => mockCookieGetUser(...a),
        mfa: {
          getAuthenticatorAssuranceLevel: (...a: unknown[]) => mockCookieAal(...a),
        },
      },
    };
  },
}));

vi.mock('@/lib/db/server', () => ({
  sql: () => (sqlRows.error ? Promise.reject(sqlRows.error) : Promise.resolve(sqlRows.next)),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

import { AuthError as SupabaseAuthError } from '@supabase/supabase-js';
import { requireAdminWithAal2 } from '../admin-mfa-gate';
import { requireRoleOr401, withSameOrigin } from '../route-helpers';
import { requireRole, AuthError } from '@/lib/db/auth';

const AUTH_ID = 'auth-1';
const TOKEN = 't';

const ADMIN_ROW = {
  id: 'user-1',
  name: 'Root',
  email: 'root@example.com',
  role: 'admin',
  account_id: null,
  primary_location_id: null,
};
const ADMIN = {
  id: 'user-1',
  name: 'Root',
  email: 'root@example.com',
  role: 'admin',
  accountId: null,
  locationId: null,
};
const OWNER_ROW = { ...ADMIN_ROW, id: 'user-2', role: 'owner' };

/** A NextRequest with the given headers. No body: the gate must not read one. */
function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/x', { method: 'POST', headers });
}
function bearerReq(token = TOKEN): NextRequest {
  return req({ authorization: `Bearer ${token}` });
}

/** Claims as auth-js returns them: `{ data: { claims, header, signature }, error: null }`. */
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

/**
 * An AuthError carrying a specific `name`. auth-js's own predicates are name-based
 * (`lib/errors.js:49-51, 222-224`), so this is how a real AuthRetryableFetchError or
 * AuthApiError presents itself to the seam.
 */
function namedAuthError(name: string, status?: number): SupabaseAuthError {
  const err = new SupabaseAuthError('boom', status);
  Object.defineProperty(err, 'name', { value: name, configurable: true });
  return err;
}

async function expectRefusal(
  response: Response,
  status: number,
  body: unknown,
  { noStore = true }: { noStore?: boolean } = {},
) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
  expect(response.headers.get('Location')).toBeNull();
  expect(response.headers.get('Cache-Control')).toBe(noStore ? 'no-store, private' : null);
}

function refusalOf(result: { ok: boolean; response?: Response }): Response {
  if (result.ok || !result.response) throw new Error('expected a refusal');
  return result.response;
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieClientCalls.count = 0;
  sqlRows.next = [ADMIN_ROW];
  sqlRows.error = null;
  delete process.env.MFA_ENFORCEMENT_ENABLED;

  mockCookieGetUser.mockResolvedValue({ data: { user: { id: AUTH_ID } }, error: null });
  mockCookieAal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });
  mockGetClaims.mockResolvedValue(claims());
  mockBearerGetUser.mockResolvedValue({ data: { user: { id: AUTH_ID } }, error: null });
});

// ---------------------------------------------------------------------------
// The happy paths, one per transport
// ---------------------------------------------------------------------------

describe('requireAdminWithAal2 — dual-mode', () => {
  it('cookie ok', async () => {
    const result = await requireAdminWithAal2(req());

    expect(result).toEqual({ ok: true, admin: ADMIN });
    // The seam reports the transport; the GATE's result shape is unchanged, so
    // ci:admin-aal2's credited shape stays exactly what it was.
    expect(result).not.toHaveProperty('transport');
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it('bearer ok', async () => {
    const result = await requireAdminWithAal2(bearerReq());

    expect(result).toEqual({ ok: true, admin: ADMIN });
    // Token-sensitive, not merely "some getUser happened": the liveness call must
    // be made against the PRESENTED bearer. Dropping it would leave a revoked
    // admin working for up to JWT_EXP (3600s) — ADR 0025 D3.
    expect(mockBearerGetUser).toHaveBeenCalledWith(TOKEN);
    expect(mockGetClaims).toHaveBeenCalledWith(TOKEN, { allowExpired: true });
    expect(cookieClientCalls.count).toBe(0);
  });

  it('the bearer client is built with persistSession and autoRefreshToken off', async () => {
    await requireAdminWithAal2(bearerReq());

    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://project.supabase.co',
      'anon-key',
      expect.objectContaining({
        auth: expect.objectContaining({ persistSession: false, autoRefreshToken: false }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Role and AAL refusals
// ---------------------------------------------------------------------------

describe('requireAdminWithAal2 — role and assurance refusals', () => {
  it('bearer aal1', async () => {
    mockGetClaims.mockResolvedValue(claims({ aal: 'aal1' }));

    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 403, {
      error: 'mfa_required',
    });
  });

  it('cookie aal1 remains forbidden without an enrolled factor', async () => {
    // The STRICT test (currentLevel === 'aal2'), never the proxy's lenient
    // nextLevel form: an unenrolled admin has nextLevel 'aal1' too, and the lenient
    // form would let them through. MFA_ENFORCEMENT_ENABLED is deliberately unset —
    // ADR 0025 D10: that flag never reaches this gate.
    mockCookieAal.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
      error: null,
    });

    await expectRefusal(refusalOf(await requireAdminWithAal2(req())), 403, {
      error: 'mfa_required',
    });
  });

  it('unreadable AAL returns mfa_check_failed on both transports', async () => {
    // mfa_check_failed and mfa_required are DIFFERENT answers: the Admin app reads
    // mfa_required and runs its own challenge, while mfa_check_failed says the
    // assurance level could not be read at all. Collapsing them strands a client.
    for (const overrides of [{ aal: undefined }, { aal: null }, { aal: 42 }]) {
      mockGetClaims.mockResolvedValue(claims(overrides));
      await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 403, {
        error: 'mfa_check_failed',
      });
    }

    const cookieCases = [
      { data: null, error: new Error('aal lookup failed') },
      { data: null, error: null },
      { data: { currentLevel: null, nextLevel: null }, error: null },
    ];
    for (const outcome of cookieCases) {
      mockCookieAal.mockResolvedValue(outcome);
      await expectRefusal(refusalOf(await requireAdminWithAal2(req())), 403, {
        error: 'mfa_check_failed',
      });
    }
  });

  it('bearer non-admin', async () => {
    sqlRows.next = [OWNER_ROW];

    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 403, {
      error: 'Forbidden',
    });
  });

  it('bearer with no users row', async () => {
    sqlRows.next = [];

    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 403, {
      error: 'Forbidden',
    });
  });

  it('verified cookie without an application user is Forbidden', async () => {
    // Declared cookie delta: today's requireRole path answers 401 here, because
    // getCurrentUser returns null and requireAuth cannot tell "no session" from
    // "no users row". The ticket's refusal table binds BOTH transports to 403.
    sqlRows.next = [];

    await expectRefusal(refusalOf(await requireAdminWithAal2(req())), 403, {
      error: 'Forbidden',
    });
  });
});

// ---------------------------------------------------------------------------
// Bearer verification refusals
// ---------------------------------------------------------------------------

describe('requireAdminWithAal2 — bearer verification', () => {
  it('bearer expired', async () => {
    // getClaims is called with allowExpired, so expiry is a DATA case rather than a
    // thrown plain Error the seam would have to classify by message.
    mockGetClaims.mockResolvedValue(claims({ exp: Math.floor(Date.now() / 1000) - 1 }));

    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 401, {
      error: 'Unauthorized',
    });
    expect(mockBearerGetUser).not.toHaveBeenCalled();

    mockGetClaims.mockResolvedValue(claims({ exp: undefined }));
    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 401, {
      error: 'Unauthorized',
    });
    expect(mockBearerGetUser).not.toHaveBeenCalled();
  });

  it('bearer with a forged signature', async () => {
    mockGetClaims.mockResolvedValue({ data: null, error: namedAuthError('AuthInvalidJwtError') });

    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 401, {
      error: 'Unauthorized',
    });
    expect(mockBearerGetUser).not.toHaveBeenCalled();
  });

  it('bearer revoked (the getUser arm)', async () => {
    // The revocation arm, with a VALID admin cookie also present. getClaims alone
    // cannot see a revoked session (it verifies a signature that is still good), so
    // this is the test that fails if getUser is ever "optimized" away — and the
    // cookie makes it also fail if a refusal quietly retries the other transport.
    mockBearerGetUser.mockResolvedValue({
      data: { user: null },
      error: namedAuthError('AuthSessionMissingError'),
    });

    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 401, {
      error: 'Unauthorized',
    });
    expect(mockBearerGetUser).toHaveBeenCalledWith(TOKEN);
    expect(cookieClientCalls.count).toBe(0);
  });

  it('a returned 4xx AuthApiError stays Unauthorized', async () => {
    mockGetClaims.mockResolvedValue({ data: null, error: namedAuthError('AuthApiError', 401) });

    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 401, {
      error: 'Unauthorized',
    });
  });

  it('a Supabase transport fault is internal_error, not Unauthorized', async () => {
    // An admin-wide Supabase outage must be a 500 someone is paged for, not 401s
    // nobody looks at. Infra faults arrive through the RETURNED channel, because
    // _request -> handleError raises an AuthError that both calls catch and return.
    const infra = [
      namedAuthError('AuthRetryableFetchError', 0),
      namedAuthError('AuthApiError', 500),
      namedAuthError('AuthApiError', 503),
    ];

    for (const error of infra) {
      mockGetClaims.mockResolvedValue({ data: null, error });
      await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 500, {
        error: 'internal_error',
      });
    }

    mockGetClaims.mockResolvedValue(claims());
    for (const error of infra) {
      mockBearerGetUser.mockResolvedValue({ data: { user: null }, error });
      await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 500, {
        error: 'internal_error',
      });
    }

    // Our own code failing is still a 500: loadAppUser is outside the two SDK
    // awaits, so its throw is not the malformed-token boundary.
    mockBearerGetUser.mockResolvedValue({ data: { user: { id: AUTH_ID } }, error: null });
    sqlRows.error = new Error('pool exhausted');
    await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 500, {
      error: 'internal_error',
    });
  });

  it('malformed JWT JSON and header shapes remain Unauthorized', async () => {
    // Measured, not assumed: auth-js decodeJWT regex-checks the three segments and
    // then JSON.parses them, so `ew.e30.AA` (header decodes to `{`),
    // `bnVsbA.e30.AA` (header decodes to `null`) and `aaaa.bbbb.cccc` escape
    // getClaims as raw SyntaxError / TypeError / Error rather than through its
    // AuthError channel. Treating an escaping throw as 500 would let an
    // UNAUTHENTICATED caller force 500s on the admin control plane with a
    // two-character token.
    const thrown = [
      new SyntaxError('Expected property name or } in JSON at position 1'),
      new TypeError("Cannot read properties of null (reading 'alg')"),
      new Error('Invalid UTF-8 sequence'),
    ];

    for (const err of thrown) {
      vi.clearAllMocks();
      cookieClientCalls.count = 0;
      mockGetClaims.mockRejectedValue(err);

      await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 401, {
        error: 'Unauthorized',
      });
      expect(mockBearerGetUser).not.toHaveBeenCalled();
      expect(cookieClientCalls.count).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The cookie arm keeps its own refusals
// ---------------------------------------------------------------------------

describe('requireAdminWithAal2 — cookie refusals', () => {
  it('cookie authentication failures preserve the refusal contract', async () => {
    // A returned cookie auth error must be a 401, never thrown into the gate's
    // internal_error handler. The AAL read would succeed in both cases, so only the
    // identity step can produce the refusal.
    const outcomes = [
      { data: { user: null }, error: null },
      { data: { user: null }, error: namedAuthError('AuthSessionMissingError') },
    ];

    for (const outcome of outcomes) {
      mockCookieGetUser.mockResolvedValue(outcome);
      await expectRefusal(refusalOf(await requireAdminWithAal2(req())), 401, {
        error: 'Unauthorized',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Transport precedence — a bearer wins, and never falls back
// ---------------------------------------------------------------------------

describe('Admin transport precedence', () => {
  it('a malformed Authorization header does not fall back to the cookie', async () => {
    // Presence of the header IS the transport choice (ADR 0025 D7, the glossary's
    // "a bearer wins"). Every shape here is refused 401 even though the cookie
    // session beside it is a perfectly good aal2 admin — and the cookie client is
    // never even constructed.
    const malformed = ['', '   ', 'Basic abc', 'Bearer', 'Bearer  ', 'Bearer t extra'];

    for (const authorization of malformed) {
      cookieClientCalls.count = 0;
      mockGetClaims.mockClear();

      await expectRefusal(
        refusalOf(await requireAdminWithAal2(req({ authorization }))),
        401,
        { error: 'Unauthorized' },
      );
      expect(cookieClientCalls.count).toBe(0);
      expect(mockGetClaims).not.toHaveBeenCalled();
    }
  });

  it('cookie + cross-origin still 403', async () => {
    // CSRF is applied at the export, not in the gate (ADR 0025 D8 leaves
    // withSameOriginUnlessBearer to #1185). This pins that the dual-mode rewire did
    // not weaken it: the wrapper refuses BEFORE the gate is entered, with its own
    // body and — deliberately — no Cache-Control of its own.
    const handler = vi.fn(async (request: NextRequest) => {
      const gate = await requireAdminWithAal2(request);
      return gate.ok ? new Response('ok') : gate.response;
    });
    const wrapped = withSameOrigin()(handler);

    const response = await wrapped(req({ origin: 'https://evil.example.com' }));

    await expectRefusal(response, 403, { error: 'forbidden' }, { noStore: false });
    expect(handler).not.toHaveBeenCalled();
    expect(cookieClientCalls.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The owner API's auth surface must NOT widen (ADR 0025 D1)
// ---------------------------------------------------------------------------

describe('requireRole stays cookie-only', () => {
  beforeEach(() => {
    // No cookie session at all: any success below would mean the bearer was read.
    mockCookieGetUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  it('an owner route rejects a bearer', async () => {
    sqlRows.next = [OWNER_ROW];

    const auth = await requireRoleOr401(bearerReq(), 'owner');

    expect(auth.ok).toBe(false);
    await expectRefusal(refusalOf(auth), 401, { error: 'Unauthorized' });
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it('requireRole remains cookie-only for admin and mixed roles', async () => {
    // The owner case alone is passed by an implementation that enables the bearer
    // only when the requested roles include 'admin'. These two close that.
    const adminAuth = await requireRoleOr401(bearerReq(), 'admin');
    expect(adminAuth.ok).toBe(false);
    await expectRefusal(refusalOf(adminAuth), 401, { error: 'Unauthorized' });

    await expect(requireRole(bearerReq(), 'owner', 'admin')).rejects.toBeInstanceOf(AuthError);
    await expect(requireRole(bearerReq(), 'owner', 'admin')).rejects.toMatchObject({
      message: 'Unauthorized',
      statusCode: 401,
    });
    expect(mockGetClaims).not.toHaveBeenCalled();
  });
});
