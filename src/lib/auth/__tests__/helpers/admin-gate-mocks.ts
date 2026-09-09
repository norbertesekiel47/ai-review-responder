// src/lib/auth/__tests__/helpers/admin-gate-mocks.ts
//
// TEST-ONLY. The single owner of the mock triple every admin route suite needs in
// order to exercise the REAL `requireAdminWithAal2` (#1184, carrying forward
// #1183's stated debt).
//
// WHY THIS EXISTS. #1183 moved the admin gate's identity read below it, into the
// **Admin transport** seam (`@/lib/auth/verified-identity`). Twenty-two admin route
// suites absorbed that by pasting the SAME shim — a `resolveDualModeIdentity` stand-
// in plus a `loadAppUser` stand-in, byte-identical in all twenty-two, verified by
// hash. #1183's resolution comment names both the debt and its miss mode: a shim
// that drifts, or is pasted slightly wrong, produces a suite whose 401/403
// assertions pass while no authorization code runs at all. #1184 adds seven more
// consumers, so the logic gets ONE owner instead of a twenty-ninth copy.
//
// HOW TO CONSUME IT. `vi.mock` factories are hoisted ABOVE imports, so a plain
// top-level import of this module referenced from a factory is a TDZ error at
// collection time. Reach it through a `vi.hoisted` dynamic import — the shape
// `src/app/api/admin/costs/__tests__/route.test.ts` already uses for
// `worker/__tests__/helpers/mock-sql.ts`:
//
//   const { mockRequireRole, mockRequireCurrentAal2FromSupabase, mockLoadAppUser,
//           mockResolveDualModeIdentity } = await vi.hoisted(async () => {
//     const { makeAdminGateMocks } = await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
//     return { ...makeAdminGateMocks() };
//   });
//
//   vi.mock('@/lib/auth/verified-identity', () => ({
//     resolveDualModeIdentity: mockResolveDualModeIdentity,
//   }));
//   vi.mock('@/lib/auth/mfa', () => ({
//     requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
//   }));
//   vi.mock('@/lib/db/auth', () => ({
//     requireRole: mockRequireRole,
//     loadAppUser: mockLoadAppUser,
//     cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
//     AuthError: /* the suite's own class */,
//   }));
//
// The `@/lib/db/auth` factory stays per-suite on purpose: its OTHER members differ
// (some suites need `AuthError` as a local class, some re-export more), and this
// helper owns the gate LOGIC, not every suite's mock surface.
//
// WHAT IT MUST NOT DO. It may not import `@/lib/db/auth` or
// `@/lib/auth/verified-identity` at runtime — it stands in for both, and importing
// one would pull the real module into a suite that mocked it. `import type` only.
// It DOES import `@/lib/auth/admin-transport` for real, and that is the point of
// the next paragraph.
import { vi, type Mock } from 'vitest';
import { isBearerRequest } from '@/lib/auth/admin-transport';
import type { AdminTransport } from '@/lib/auth/admin-transport';

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
   * Stand-in for `@/lib/auth/verified-identity` `resolveDualModeIdentity`. A `Mock`
   * rather than a bare function so a suite can assert WHICH request reached the
   * seam — which is what makes a bearer test a transport test.
   */
  mockResolveDualModeIdentity: Mock;
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
 * TRANSPORT IS DERIVED FROM THE REQUEST, never from a knob the test sets. The gate
 * reads only `authUserId` and `aal` (`src/lib/auth/admin-mfa-gate.ts`), so a
 * `transport: 'bearer'` a test simply asserts into existence would reproduce the
 * cookie test's 200 without an `Authorization` header ever being sent — the bearer
 * case would then assert nothing the cookie case does not. Calling the PRODUCTION
 * `isBearerRequest` instead means a suite proves bearer mode the only way that
 * counts: by building a request that carries the header, and by the same predicate
 * `src/proxy.ts` takes in #1185 (ADR 0025 D6 — one owner for that test).
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

  const mockResolveDualModeIdentity: Mock = vi.fn(async (request: unknown) => {
    try {
      await mockRequireRole(request, 'admin');
    } catch (err) {
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 401) return null; // no live credential → the gate's 401
      if (status !== 403) throw err; // a real fault → the gate's 500
      // 403 is "authenticated but not an admin"; loadAppUser reports that.
    }

    const aal = aalFrom((await mockRequireCurrentAal2FromSupabase()) as AalAnswer | null);
    const transport: AdminTransport = isBearerRequest(request as { headers: Headers })
      ? 'bearer'
      : 'cookie';

    return { authUserId: 'auth-1', aal, transport };
  });

  return {
    mockRequireRole,
    mockRequireCurrentAal2FromSupabase,
    mockLoadAppUser,
    mockResolveDualModeIdentity,
  };
}
