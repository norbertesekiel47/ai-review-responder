import { NextRequest, NextResponse } from 'next/server';
import type postgres from 'postgres';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError, type AppUser } from '@/lib/db/auth';
import { getOffboardingState, isOperationalUIBlocked } from '@/lib/account-offboarding/gate';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';

type NextHandler<TArgs extends unknown[] = [], TRes extends Response = Response> = (
  req: NextRequest,
  ...args: TArgs
) => Promise<TRes> | TRes;
/** The 403 the wrapper itself returns; it joins every wrapped handler's return union. */
type SameOriginForbidden = NextResponse<{ error: string }>;
type WrappedNextHandler<TArgs extends unknown[] = [], TRes extends Response = Response> = (
  req: NextRequest,
  ...args: TArgs
) => Promise<TRes | SameOriginForbidden>;

/**
 * Wraps a handler with a same-origin check.
 *
 * Returns 403 when the Origin header is absent, mismatched, or
 * NEXT_PUBLIC_APP_URL is not configured. Any other unexpected error
 * from assertSameOrigin is re-thrown so it surfaces as a 500.
 *
 * RETURN-TYPE PRESERVING (#879). `TRes` is inferred from the wrapped handler,
 * so `withSameOrigin()(h)` returns `Promise<TRes | SameOriginForbidden>` rather
 * than the old flat `Promise<Response>`. Pinning it to `Response` widened all 58
 * wrapped routes: a caller annotated `(response: NextResponse) => …` then failed
 * with TS2739, and #865 (deviation D5) worked around it at the call site. Both
 * directions are guarded in route-helpers.test.ts — one case asserts a
 * NextResponse handler stays narrowable, and a `@ts-expect-error` case asserts a
 * bare-Response handler is NOT, so re-pinning `TRes` fails the typecheck row.
 *
 * A HANDLER OPTS ITSELF OUT TWO WAYS, and both are inference, not the wrapper.
 * This comment is the single owner of that pair.
 *
 * (a) The handler ANNOTATES ITSELF `: Promise<Response>`, which pins
 * `TRes = Response`. Three wrapped handlers did; #1327 closed them. The fix is
 * always the HANDLER's own types, never a cast at the export (that was #865
 * D5's mistake): drop the annotation and let `TRes` infer, or annotate
 * `: Promise<NextResponse>`. Mechanism (a) is now caught MECHANICALLY at every
 * call site by the `same-origin-handler-return-type` rule in
 * scripts/ci/static-policy-audit.ts (#1331), which replaced the three-route type
 * assertion route-helpers.test.ts used to carry — one owner for that fact, and
 * it covers all 49 call sites rather than three. Counting opt-outs by grepping
 * `: Promise<Response>` under src/app/api overcounts to ten — the other seven
 * are GETs or inline `assertSameOrigin` callers that this wrapper never wraps.
 *
 * (b) A guard type the handler returns from declares `response: Response`, which
 * puts a bare `Response` in the inferred union and widens it just as hard —
 * dropping the annotation alone does not fix that one. import-offer's local
 * `ScopeOutcome` did; #1327 closed it. Mechanism (b) is now STRUCTURALLY
 * IMPOSSIBLE for the route guards (#1332): `Guard<TOk>` below declares
 * `response: NextResponse` once and `RoleAuthResult`, `OwnerAccountResult`,
 * `EditReplyGuard<T>` and `ScopeOutcome` are all aliases of it, so there is no
 * per-guard `response:` annotation left to get wrong. A NEW guard type that
 * re-spells the shape by hand can still reintroduce (b); write it as `Guard<T>`.
 */
export function withSameOrigin(): <TArgs extends unknown[], TRes extends Response>(
  handler: NextHandler<TArgs, TRes>
) => WrappedNextHandler<TArgs, TRes> {
  return (handler) => async (req, ...args) => {
    try {
      assertSameOrigin(req);
    } catch (err) {
      if (err instanceof SameOriginError) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
      throw err;
    }
    return handler(req, ...args);
  };
}

/** JSON response with the standard no-store cache headers (owner/account routes). */
export function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/**
 * The single error-response shape for owner/account JSON routes: `{ error: code }`
 * at `status`, with the standard no-store headers (via `jsonResponse`). Use this
 * instead of hand-writing `NextResponse.json({ error }, { status })` so every
 * dashboard error returns the same body shape and cache semantics.
 */
export function errorResponse(code: string, status: number): NextResponse {
  return jsonResponse({ error: code }, status);
}

/**
 * The single owner of the `{ ok: true, …payload } | { ok: false, response }`
 * route-guard shape (#1332). Four types declared it by hand — `RoleAuthResult`,
 * `OwnerAccountResult`, `EditReplyGuard<T>` and import-offer's `ScopeOutcome` —
 * and one of the four spelled the failure member `response: Response`, which is
 * opt-out mechanism (b) in the `withSameOrigin` comment above: a bare `Response`
 * reaching a wrapped handler's inferred return union widens the route export.
 * One declaration of `response: NextResponse` makes that unrepeatable for these
 * guards; a fifth copy would re-arm it, so new guards alias this type.
 *
 * PAYLOAD-GENERIC, not `{ value: T }`: the success member is intersected in, so
 * `Guard<{ user: AppUser }>` keeps `result.user` and `Guard<{ value: T }>` keeps
 * `result.value`. Collapsing every guard onto a single `value` field would have
 * renamed the accessor at ~60 call sites for no safety gain — the failure member
 * is the part that had to be shared, and it is.
 */
export type Guard<TOk extends object> =
  | ({ ok: true } & TOk)
  | { ok: false; response: NextResponse };

export type RoleAuthResult = Guard<{ user: AppUser }>;

/**
 * The single role-auth gate shared by every admin/owner/channel API route.
 * Runs requireRole(request, role) and maps the outcome:
 *
 *   - success           → { ok: true, user }
 *   - AuthError         → { ok: false, response } — a no-store JSON body
 *                         ({ error: message }) at the AuthError's statusCode
 *                         (401 unauthenticated / 403 forbidden).
 *   - any other failure → re-thrown, surfacing a real 5xx. An unexpected
 *                         (non-auth) failure must not be masked as a 401 —
 *                         that drift hid genuine server faults behind an
 *                         "Unauthorized" response.
 *
 * Deliberate asymmetry with requireAdminWithAal2 (the admin control-plane gate,
 * src/lib/auth/admin-mfa-gate.ts) on this exact failure mode: that gate CATCHES
 * a non-auth failure and returns a clean { error: 'internal_error' } 500, while
 * this gate RE-THROWS. Each preserves its own routes' pre-refactor behavior —
 * the owner/channel/admin routes here intentionally let server faults surface
 * as a real (un-masked) 5xx; the admin mutation routes return a uniform
 * internal_error 500. Don't unify one onto the other without accepting that
 * observable change across ~40 routes.
 *
 *   const auth = await requireRoleOr401(request, 'owner');
 *   if (!auth.ok) return auth.response;
 *   const user = auth.user;
 */
export async function requireRoleOr401(
  request: NextRequest,
  role: string,
): Promise<RoleAuthResult> {
  try {
    const user = await requireRole(request, role);
    return { ok: true, user };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, response: jsonResponse({ error: err.message }, err.statusCode) };
    }
    throw err;
  }
}

export type OwnerAccountResult = Guard<{ user: AppUser; accountId: string }>;

/**
 * Owner gate for account-scoped READ routes: requireRoleOr401(_, 'owner') →
 * account-association check. Returns the owner user + accountId on success, or
 * the inline no-store JSON response (401/403 AuthError, 403 no-account). Does
 * NOT enforce the writable-subscription gate — reads stay available to past-due
 * accounts (use requireWritableOwner for mutations). Unexpected non-auth
 * failures propagate as 5xx (see requireRoleOr401).
 */
export async function requireOwnerWithAccount(request: NextRequest): Promise<OwnerAccountResult> {
  const auth = await requireRoleOr401(request, 'owner');
  if (!auth.ok) return auth;

  if (!auth.user.accountId) {
    return { ok: false, response: jsonResponse({ error: 'No account associated with this user' }, 403) };
  }

  return { ok: true, user: auth.user, accountId: auth.user.accountId };
}

export type WritableOwnerResult = OwnerAccountResult;

/**
 * Owner gate for mutating owner/account routes: requireOwnerWithAccount →
 * writable-subscription/offboarding gate. Returns the owner user + accountId on
 * success, or the inline no-store JSON response (401 / 403 no-account /
 * 402|403 not-writable) on failure. Unexpected non-auth failures propagate as
 * 5xx (see requireRoleOr401).
 */
export async function requireWritableOwner(
  sql: postgres.Sql,
  request: NextRequest,
): Promise<WritableOwnerResult> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner;

  const writable = await assertWritableSubscriptionForAccount(owner.accountId, sql);
  if (!writable.ok) {
    return { ok: false, response: jsonResponse({ error: writable.error }, writable.status) };
  }

  return owner;
}

export type SettingsOwnerResult = OwnerAccountResult;

/**
 * Owner gate for the account-scoped `/api/settings/*` routes: rejects an
 * `?accountId` query parameter → requireOwnerWithAccount → operational-UI
 * offboarding gate. Returns the owner user + accountId on success, or the
 * inline no-store JSON response (400 account_id_not_allowed / 401 / 403
 * no-account / 403 account_offboarding_blocked) on failure. Unexpected non-auth
 * failures propagate as 5xx (see requireRoleOr401).
 *
 * The `?accountId` rejection runs BEFORE the owner is resolved: the parameter is
 * never a legitimate input on these routes, so accepting the request far enough
 * to resolve an owner would leave a tenant-selection knob half-honoured. The
 * order is the guard, not an optimization.
 *
 * Unlike requireWritableOwner this checks only the offboarding gate, not the
 * writable-subscription gate — settings reads and rival/auto-approval writes
 * stay available to past-due accounts.
 */
export async function requireSettingsOwner(
  sql: postgres.Sql,
  request: NextRequest,
): Promise<SettingsOwnerResult> {
  if (request.nextUrl.searchParams.has('accountId')) {
    return { ok: false, response: jsonResponse({ error: 'account_id_not_allowed' }, 400) };
  }

  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner;

  const offboardingState = await getOffboardingState(owner.accountId, sql);
  if (isOperationalUIBlocked(offboardingState)) {
    return { ok: false, response: jsonResponse({ error: 'account_offboarding_blocked' }, 403) };
  }

  return owner;
}
