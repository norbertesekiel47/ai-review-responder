// src/lib/auth/__tests__/admin-gate-mocks.test.ts
//
// Two jobs, and the second is the reason this file exists at all.
//
// 1. The shared gate-dependency shim is now the single owner of a mapping that every
//    admin route suite which imports it depends on — plus
//    `src/lib/admin/__tests__/denorm-queries.test.ts`. Deliberately no count here:
//    #1184 alone moved it twice, so a number in prose is a claim that goes stale
//    between tickets while still reading as verified. `CONSUMER_SPECIFIER` below is
//    the thing to grep when you want today's list. A shim that quietly answers
//    "admin, aal2" for every input turns every 401/403 assertion in those suites
//    green while proving nothing, so the mapping gets its own tests rather than
//    being verified only through the suites that trust it.
//
// 2. THE ANTI-VACUITY PIN. #1184's whole claim is that the nine folded Admin API
//    reads are now protected by `requireAdminWithAal2`. A suite that stubs
//    `@/lib/auth/admin-mfa-gate` itself would assert the same statuses with no
//    authorization code running at all — the gate's refusals would be values the
//    test invented. The pin reads those nine suites and refuses that shape.
//
//    Deliberately scoped to the nine, not repo-wide. Four other admin suites mock
//    the gate legitimately (`suppressions`, `solicitation/breaker` get-route,
//    `channels/bindings`, `_shared/channels/resolve-actor` — they are testing
//    something other than the gate), so a blanket rule would need an allowlist,
//    which is a mechanism this ticket did not ask for and a later reader would have
//    to maintain. The nine are the routes whose protection this ticket asserts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { adminBearerRequest, makeAdminGateMocks } from './helpers/admin-gate-mocks';

class TestAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const ADMIN = { id: 'admin-1', role: 'admin', accountId: null, locationId: null };

function cookieRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/impersonation/start');
}

function bearerRequest(token = 'test-admin-access-token'): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/overview', {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('makeAdminGateMocks — the identity mapping the gate consumes', () => {
  it('refuses ordinary cookie-only requests before invoking role/AAL mocks', async () => {
    const mocks = makeAdminGateMocks();
    const request = new NextRequest('http://localhost:3000/api/admin/nav-counts');
    request.cookies.set('sb-session', 'valid-admin-cookie');
    await expect(mocks.mockResolveAdminApiIdentity(request)).resolves.toBeNull();
    expect(mocks.mockRequireRole).not.toHaveBeenCalled();
    expect(mocks.mockRequireCurrentAal2FromSupabase).not.toHaveBeenCalled();
  });

  it('the bearer request fixture keeps explicit malformed headers and request options', () => {
    const request = adminBearerRequest('http://localhost:3000/api/admin/businesses', { method: 'POST', headers: { authorization: '', 'content-type': 'application/json' }, body: '{}' });
    expect(request.headers.get('authorization')).toBe('');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.method).toBe('POST');
    expect(adminBearerRequest('http://localhost:3000/api/admin/nav-counts').headers.get('authorization')).toBe('Bearer test-admin-access-token');
  });

  it('a 401 rejection resolves to no identity, which is the gate 401 arm', async () => {
    const { mockRequireRole, mockResolveAdminApiIdentity } = makeAdminGateMocks();
    mockRequireRole.mockRejectedValue(new TestAuthError('Unauthenticated', 401));

    await expect(mockResolveAdminApiIdentity(cookieRequest())).resolves.toBeNull();
  });

  it('a 403 rejection still yields an identity, and loadAppUser reports the missing admin', async () => {
    // The seam DECIDES NOTHING (ADR 0025 D1): "authenticated but not an admin" is the
    // gate's call, made from loadAppUser's answer. Collapsing this onto the 401 arm
    // would make every "non-admin is Forbidden" assertion in the repo test the shim.
    const { mockRequireRole, mockRequireCurrentAal2FromSupabase, mockLoadAppUser, mockResolveAdminApiIdentity } =
      makeAdminGateMocks();
    mockRequireRole.mockRejectedValue(new TestAuthError('Forbidden', 403));
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });

    await expect(mockResolveAdminApiIdentity(cookieRequest())).resolves.toMatchObject({
      authUserId: 'auth-1',
      aal: 'aal2',
    });
    await expect(mockLoadAppUser()).resolves.toBeNull();
  });

  it('any other throw propagates, so the gate answers internal_error rather than a refusal', async () => {
    const { mockRequireRole, mockResolveAdminApiIdentity } = makeAdminGateMocks();
    mockRequireRole.mockRejectedValue(new Error('supabase unreachable'));

    await expect(mockResolveAdminApiIdentity(cookieRequest())).rejects.toThrow('supabase unreachable');
  });

  it('loadAppUser reuses the outcome requireRole already produced, never a second call', async () => {
    // A `...Once` control would be consumed by the resolver, and the second call
    // would fall through to the suite's beforeEach default — silently turning a
    // refusal case into a success. This is the trap the 22 pasted copies documented.
    const { mockRequireRole, mockRequireCurrentAal2FromSupabase, mockLoadAppUser, mockResolveAdminApiIdentity } =
      makeAdminGateMocks();
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockRequireRole.mockResolvedValueOnce(ADMIN).mockResolvedValue(null);

    await mockResolveAdminApiIdentity(cookieRequest());

    await expect(mockLoadAppUser()).resolves.toEqual(ADMIN);
    expect(mockRequireRole).toHaveBeenCalledTimes(1);
  });

  it('maps the three AAL answers apart — aal2, unreadable, and everything else', async () => {
    const { mockRequireRole, mockRequireCurrentAal2FromSupabase, mockResolveAdminApiIdentity } =
      makeAdminGateMocks();
    mockRequireRole.mockResolvedValue(ADMIN);

    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    expect((await mockResolveAdminApiIdentity(cookieRequest()))?.aal).toBe('aal2');

    // null is "I could not read it" → the gate's mfa_check_failed, which the Admin
    // app treats differently from mfa_required. Two answers, not one.
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_check_failed' });
    expect((await mockResolveAdminApiIdentity(cookieRequest()))?.aal).toBeNull();

    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });
    expect((await mockResolveAdminApiIdentity(cookieRequest()))?.aal).toBe('aal1');
  });

  it('derives transport from the request through the production predicate, not a knob', async () => {
    // The gate reads only authUserId and aal, so a transport a test simply asserted
    // into existence would make every "bearer ok" case a second spelling of the
    // cookie case. Deriving it means a suite can only get 'bearer' by sending the
    // header — and by the same predicate src/proxy.ts takes in #1185.
    const { mockRequireRole, mockRequireCurrentAal2FromSupabase, mockResolveAdminApiIdentity } =
      makeAdminGateMocks();
    mockRequireRole.mockResolvedValue(ADMIN);
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });

    expect((await mockResolveAdminApiIdentity(cookieRequest()))?.transport).toBe('cookie');
    expect((await mockResolveAdminApiIdentity(bearerRequest()))?.transport).toBe('bearer');
  });

  it('a malformed Authorization header is refused without cookie fallback', async () => {
    // isBearerRequest is header PRESENCE, which is what stops a malformed header
    // from falling back to the cookie's authority (see admin-transport.ts).
    const { mockRequireRole, mockRequireCurrentAal2FromSupabase, mockResolveAdminApiIdentity } =
      makeAdminGateMocks();
    mockRequireRole.mockResolvedValue(ADMIN);
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });

    const malformed = new NextRequest('http://localhost:3000/api/admin/overview', {
      headers: { authorization: 'Basic abc' },
    });
    await expect(mockResolveAdminApiIdentity(malformed)).resolves.toBeNull();
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('each call builds independent mocks, so one suite cannot leak into another', async () => {
    const first = makeAdminGateMocks();
    const second = makeAdminGateMocks();
    first.mockRequireRole.mockResolvedValue(ADMIN);

    expect(second.mockRequireRole).not.toBe(first.mockRequireRole);
    await expect(second.mockLoadAppUser()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The anti-vacuity pin
// ---------------------------------------------------------------------------

/** The nine reads #1184 folded onto requireAdminWithAal2, by their suite. */
const FOLDED_SUITES = [
  'src/app/api/admin/costs/__tests__/route.test.ts',
  'src/app/api/admin/businesses/__tests__/route.test.ts',
  'src/app/api/admin/businesses/[id]/__tests__/route.test.ts',
  'src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts',
  'src/app/api/admin/demos/__tests__/route.test.ts',
  'src/app/api/admin/jobs/__tests__/route.test.ts',
  'src/app/api/admin/nav-counts/__tests__/route.test.ts',
  'src/app/api/admin/notifications/__tests__/route.test.ts',
  'src/app/api/admin/overview/__tests__/route.test.ts',
] as const;

/**
 * The import specifier a folded suite must actually carry. Matching the bare string
 * `admin-gate-mocks` was satisfied by a suite's own header PROSE — every one of the
 * nine mentions the shim by name in a comment — so the check passed on a suite that
 * had stopped importing it. The specifier, quotes included, is the import.
 */
const CONSUMER_SPECIFIER = "'@/lib/auth/__tests__/helpers/admin-gate-mocks'";

/**
 * WHAT THIS PIN CANNOT SEE. It is a text scan, so it catches the shape a suite would
 * plausibly regress into and nothing cleverer: a computed specifier
 * (`vi.mock(GATE, …)`), a path alias that resolves to the same module under another
 * name, or a mock installed from an imported setup file all read as clean here. That
 * limit is recorded rather than closed — closing it means resolving modules, which is
 * a mechanism this ticket did not ask for. The pin is a guardrail against drift, not
 * a proof that no suite can ever stub the gate.
 */
const GATE_STUB = /vi\.(?:mock|doMock)\(\s*['"]@\/lib\/auth\/admin-mfa-gate['"]/;
const RELATIVE_GATE_STUB = /vi\.(?:mock|doMock)\(\s*['"][./]+[^'"]*admin-mfa-gate['"]/;

function readSuite(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8');
}

describe('the nine folded admin read suites exercise the REAL gate', () => {
  it.each(FOLDED_SUITES)('%s does not stub the admin MFA gate', (relative) => {
    const text = readSuite(relative);

    // Stubbing the gate would let the suite assert 401/403/200 with no
    // authorization code running: the refusals would be values it invented.
    // `vi.doMock` is the same hole spelled lazily — it is not hoisted, so a suite
    // reaching for it after a dynamic `import('../route')` gets exactly the stub
    // `vi.mock` would have given it.
    expect(text).not.toMatch(GATE_STUB);
    // A relative specifier resolving to the same module is the same hole again.
    expect(text).not.toMatch(RELATIVE_GATE_STUB);
  });

  it.each(FOLDED_SUITES)('%s drives the gate through the shared shim', (relative) => {
    const text = readSuite(relative);

    // The other half of the same guarantee: the suite reaches the gate's
    // dependencies through the one owner, so a future change to the mapping
    // reaches all nine instead of drifting in eight of them.
    expect(text).toContain(CONSUMER_SPECIFIER);
    expect(text).toContain('makeAdminGateMocks');
    expect(text).toMatch(/vi\.mock\(\s*['"]@\/lib\/auth\/verified-identity['"]/);
  });

  it('no suite carries a hand-rolled copy of the resolver the shim owns', () => {
    // The #1183 shape, duplicated verbatim in 22 files. One owner is the point of
    // the helper; a 23rd copy would re-open the drift it closed.
    for (const relative of FOLDED_SUITES) {
      expect(readSuite(relative), relative).not.toContain('resolveAdminApiIdentity: async');
    }
  });
});
