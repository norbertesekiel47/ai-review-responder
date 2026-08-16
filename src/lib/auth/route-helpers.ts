import { NextRequest, NextResponse } from 'next/server';
import type postgres from 'postgres';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError, type AppUser } from '@/lib/db/auth';
import { getOffboardingState, isOperationalUIBlocked } from '@/lib/account-offboarding/gate';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';

type NextHandler<TArgs extends unknown[] = []> = (
  req: NextRequest,
  ...args: TArgs
) => Promise<Response> | Response;
type WrappedNextHandler<TArgs extends unknown[] = []> = (
  req: NextRequest,
  ...args: TArgs
) => Promise<Response>;

/**
 * Wraps a handler with a same-origin check.
 *
 * Returns 403 when the Origin header is absent, mismatched, or
 * NEXT_PUBLIC_APP_URL is not configured. Any other unexpected error
 * from assertSameOrigin is re-thrown so it surfaces as a 500.
 */
export function withSameOrigin(): <TArgs extends unknown[]>(
  handler: NextHandler<TArgs>
) => WrappedNextHandler<TArgs> {
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

export type RoleAuthResult =
  | { ok: true; user: AppUser }
  | { ok: false; response: NextResponse };

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

export type OwnerAccountResult =
  | { ok: true; user: AppUser; accountId: string }
  | { ok: false; response: NextResponse };

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
