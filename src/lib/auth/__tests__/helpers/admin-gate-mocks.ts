// src/lib/auth/__tests__/helpers/admin-gate-mocks.ts
//
// TEST-ONLY. The single owner of the mock triple every admin route suite needs in
// order to exercise the REAL `requireAdminWithAal2` (#1184, carrying forward
// #1183's stated debt).
//
// WHY THIS EXISTS. #1183 moved the admin gate's identity read below it, into the
// **Admin transport** seam (`@/lib/auth/verified-identity`). Twenty-two admin route
// suites absorbed that by pasting the SAME shim — a `resolveAdminApiIdentity` stand-
// in plus a `loadAppUser` stand-in, byte-identical in all twenty-two, verified by
// hash. #1183's resolution comment names both the debt and its miss mode: a shim
// that drifts, or is pasted slightly wrong, produces a suite whose 401/403
// assertions pass while no authorization code runs at all. #1184 adds more
// consumers, so the logic gets ONE owner instead of another copy.
//
// WHAT THIS HELPER DOES AND DOES NOT PROVE. It gives a suite a faithful stand-in
// for the gate's dependencies; it does not verify a credential, because nothing
// here verifies a token. The identity a suite configures is the identity the gate
// sees. The real seam and the real refusal contract are proven WITHOUT this helper
// by `src/lib/auth/__tests__/{admin-mfa-gate,verified-identity,admin-transport-seam}.test.ts`,
// which is what keeps its consumers from becoming the only — and therefore
// circular — evidence that admin authorization works. (Count them with
// `rg -l admin-gate-mocks src | wc -l` rather than trusting a number written
// here: every figure of that kind in this file's history has gone stale.)
//
// HOW TO CONSUME IT. `vi.mock` factories are hoisted ABOVE imports, so a plain
// top-level import of this module referenced from a factory is a TDZ error at
// collection time. Reach it through a `vi.hoisted` dynamic import — the shape
// `src/app/api/admin/costs/__tests__/route.test.ts` already uses for
// `worker/__tests__/helpers/mock-sql.ts`:
//
//   const { mockRequireRole, mockRequireCurrentAal2FromSupabase, mockLoadAppUser,
//           mockResolveAdminApiIdentity } = await vi.hoisted(async () => {
//     const { makeAdminGateMocks } = await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
//     return { ...makeAdminGateMocks() };
//   });
//
//   vi.mock('@/lib/auth/verified-identity', () => ({
//     resolveAdminApiIdentity: mockResolveAdminApiIdentity,
//   }));
//   vi.mock('@/lib/auth/mfa', () => ({
//     requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
//   }));
//   vi.mock('@/lib/db/auth', () => adminAuthModuleMock(mockRequireRole, mockLoadAppUser));
//
// A suite whose `@/lib/db/auth` mock genuinely needs more members spreads that
// result and adds them. An earlier version of this note claimed the factory had to
// stay per-suite because "its OTHER members differ"; the standards review measured
// it and found ten suites spelling the identical four members with `AuthError`
// re-declared in each, so the claim was false and `adminAuthModuleMock` replaced it.
//
// WHAT IT MUST NOT DO. It may not import `@/lib/db/auth` or
// `@/lib/auth/verified-identity` at runtime — it stands in for both, and importing
// one would pull the real module into a suite that mocked it. `import type` only.
// It DOES import `@/lib/auth/admin-transport` for real, and that is the point of
// the next paragraph.
import { vi, type Mock } from 'vitest';
import { NextRequest } from 'next/server';
import { isBearerRequest, readBearerToken } from '@/lib/auth/admin-transport';
import { isAdminImpersonationApiRoute, normalizePath } from '@/lib/shared/protected-routes';
import type { VerifiedIdentity } from '@/lib/auth/verified-identity';

/**
 * The `AuthError` suites construct to drive the gate's refusal arms
 * (`new AuthError('Forbidden', 403)`). A real class, because the shim reads
 * `statusCode` off what `mockRequireRole` rejects with.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** The two suite-facing controls, plus the two stand-ins the gate consumes. */
export interface AdminGateMocks {
  /**
   * Says whether there is a live admin. Suites keep driving it exactly as they did
   * before #1183: resolve an admin user, or reject with an `AuthError` carrying a
   * `statusCode`.
   */
  mockRequireRole: Mock;
  /** Says whether the AAL2 step-up passed. `{ ok }` / `{ ok: false, reason }`. */
  mockRequireCurrentAal2FromSupabase: Mock;
  /** Stand-in for `@/lib/db/auth` `loadAppUser`. */
  mockLoadAppUser: Mock;
  /**
   * Stand-in for `@/lib/auth/verified-identity` `resolveAdminApiIdentity`. A `Mock`
   * rather than a bare function so a suite can assert WHICH request reached the
   * seam — which is what makes a bearer test a transport test.
   */
  mockResolveAdminApiIdentity: Mock;
}

/** The shape `requireCurrentAal2FromSupabase` answers with. */
interface AalAnswer {
  ok?: boolean;
  reason?: string;
}

/**
 * The AAL mapping, byte-for-byte the one the twenty-two copies spelled: a passing
 * step-up is `'aal2'`; an explicit `mfa_check_failed` is `null`, which the gate
 * reports as "I could not read it"; anything else is `'aal1'`, which the gate
 * reports as `mfa_required`. Two DIFFERENT answers the Admin app acts on
 * differently, so collapsing them here would make every `mfa_check_failed`
 * assertion in the repo vacuous.
 */
function aalFrom(answer: AalAnswer | null | undefined): string | null {
  if (answer?.ok) return 'aal2';
  if (answer?.reason === 'mfa_check_failed') return null;
  return 'aal1';
}

/**
 * Builds one suite's gate-dependency mocks.
 *
 * The resolver reproduces what the real seam tells the gate, driven by
 * `mockRequireRole`:
 *
 *   - rejects with `statusCode` 401 → `null`. No live credential on the chosen
 *     transport; the gate answers 401 `Unauthorized`.
 *   - rejects with `statusCode` 403 → an identity is still returned, and
 *     `mockLoadAppUser` reports `null`. "Authenticated but not an admin" is the
 *     gate's 403 `Forbidden`, and the seam is the wrong layer to decide it — it
 *     decides nothing (ADR 0025 D1).
 *   - rejects with anything else → the throw propagates, so the gate's catch turns
 *     it into the clean 500 `internal_error`.
 *   - resolves → an identity carrying the AAL the step-up mock reported.
 *
 * Credential presence is derived from the real request and production path/header
 * predicates. Ordinary calls need a syntactically valid bearer; only the permanent
 * impersonation prefix may use cookies. This mock never verifies token authenticity:
 * SDK-boundary suites own that proof. The early refusal keeps a route suite from
 * silently asserting successful cookie access after #1203.
 *
 * `loadAppUser` deliberately reuses the outcome `mockRequireRole` ALREADY produced
 * rather than calling it a second time. A `...Once` control would be consumed by the
 * resolver, and the second call would fall through to the suite's `beforeEach`
 * default — silently turning a 403 case into a success.
 */
export function makeAdminGateMocks(): AdminGateMocks {
  const mockRequireRole: Mock = vi.fn();
  const mockRequireCurrentAal2FromSupabase: Mock = vi.fn();

  const mockLoadAppUser: Mock = vi.fn(async () => {
    const last = mockRequireRole.mock.results.at(-1);
    if (!last) return null;
    try {
      return await last.value;
    } catch {
      return null;
    }
  });

  // The return type is the REAL `VerifiedIdentity`, not an inline literal: this
  // function stands in for `resolveAdminApiIdentity`, and an untyped literal lets
  // the seam's shape drift away from its stand-in silently across 30 suites.
  const mockResolveAdminApiIdentity: Mock = vi.fn(
    async (request: NextRequest): Promise<VerifiedIdentity | null> => {
      const cookieException = isAdminImpersonationApiRoute(normalizePath(request.nextUrl.pathname)) && !isBearerRequest(request);
      if (!cookieException && readBearerToken(request) === null) return null;
      try {
        await mockRequireRole(request, 'admin');
      } catch (err) {
        const status = (err as { statusCode?: number } | null)?.statusCode;
        if (status === 401) return null; // no live credential → the gate's 401
        if (status !== 403) throw err; // a real fault → the gate's 500
        // 403 is "authenticated but not an admin"; loadAppUser reports that.
      }

      const aal = aalFrom((await mockRequireCurrentAal2FromSupabase()) as AalAnswer | null);
      const transport: VerifiedIdentity['transport'] = cookieException ? 'cookie' : 'bearer';

      return { authUserId: 'auth-1', aal, transport };
    },
  );

  return {
    mockRequireRole,
    mockRequireCurrentAal2FromSupabase,
    mockLoadAppUser,
    mockResolveAdminApiIdentity,
  };
}

/**
 * The `vi.mock('@/lib/db/auth', …)` factory body every folded admin read suite
 * needs, spelled once.
 *
 * Ten suites had pasted these four members verbatim, `AuthError` re-declared in
 * each — 140 lines of exactly the duplication this helper exists to retire. The
 * shim's original note said their OTHER members differ; for these ten that was
 * simply not true, and the standards review caught it.
 *
 *   vi.mock('@/lib/db/auth', () => adminAuthModuleMock(mockRequireRole, mockLoadAppUser));
 *
 * A suite that genuinely needs more spreads the result and adds them.
 */
export function adminAuthModuleMock(
  mockRequireRole: Mock,
  mockLoadAppUser: Mock,
): Record<string, unknown> {
  return {
    requireRole: mockRequireRole,
    loadAppUser: mockLoadAppUser,
    // The gate's identity seam builds a cookie-backed client; the suites that
    // reach it only need the shape, never a real client.
    cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
    AuthError,
  };
}

/** Synthetic bearer request for route tests; explicit Authorization overrides win. */
export function adminBearerRequest(
  input: ConstructorParameters<typeof NextRequest>[0],
  init?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  const headers = new Headers(init?.headers);
  if (!headers.has('authorization')) headers.set('authorization', 'Bearer test-admin-access-token');
  return new NextRequest(input, { ...init, headers });
}
