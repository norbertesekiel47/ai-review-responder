import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError, cookieBackedServerClient, type AppUser } from '@/lib/db/auth';
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
 * Wraps a handler with a fixed-window rate limit using the cache Redis instance.
 *
 * Always runs in strict mode — if Redis is unavailable the wrapper returns 503
 * rather than silently allowing the request (auth endpoints need budget
 * enforcement, not fail-open behaviour).
 *
 * @param keyFn  Derives the Redis key from the incoming request (e.g. by IP or email).
 * @param maxRequests  Maximum allowed calls within the window.
 * @param windowSeconds  Rolling window length in seconds.
 */
export function withRateLimit(
  keyFn: (req: NextRequest) => string,
  maxRequests: number,
  windowSeconds: number,
): (handler: NextHandler) => NextHandler {
  return (handler) => async (req) => {
    try {
      const result = await checkRateLimit(keyFn(req), maxRequests, windowSeconds, { strict: true });
      if (!result.allowed) {
        return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
      }
    } catch (err) {
      console.error('[route-helpers/withRateLimit] strict failure:', err);
      return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
    }
    return handler(req);
  };
}

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

/**
 * Wraps a handler with a Supabase session check.
 *
 * Reads cookies from the incoming NextRequest (read-only — setAll is a no-op
 * because auth routes do not need to write session cookies back). Returns 401
 * when no authenticated user is found; otherwise calls the inner handler with
 * a typed `{ user }` session object as the first argument.
 */
export function withSession(
  handler: (session: { user: User }, req: NextRequest) => Promise<Response> | Response,
): NextHandler {
  return async (req) => {
    const supabase = cookieBackedServerClient(req);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    return handler({ user }, req);
  };
}

/** JSON response with the standard no-store cache headers (owner/account routes). */
export function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
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
 * writable-subscription gate (past-due read-only enforced). Returns the owner
 * user + accountId on success, or the inline no-store JSON response
 * (401 / 403 no-account / 402|403 not-writable) on failure. Unexpected non-auth
 * failures propagate as 5xx (see requireRoleOr401).
 */
export async function requireWritableOwner(request: NextRequest): Promise<WritableOwnerResult> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner;

  const writable = await assertWritableSubscriptionForAccount(owner.accountId);
  if (!writable.ok) {
    return { ok: false, response: jsonResponse({ error: writable.error }, writable.status) };
  }

  return owner;
}
