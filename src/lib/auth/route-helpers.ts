import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

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
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return req.cookies.getAll();
          },
          setAll() {
            // No-op by design. Supabase access-token refresh that would otherwise
            // write new cookies is silently discarded here. Relies on the browser
            // Supabase client refreshing via its own cookie writes on the next page
            // load. Acceptable for short-lived API routes; the trade-off is that
            // long-hanging routes may see stale access tokens if the browser's
            // refresh hasn't fired yet. Not a security issue (getUser validates
            // against Supabase directly), just a potential 401 that triggers a
            // browser-side refresh round-trip.
          },
        },
      },
    );

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

export type AdminAuthResult =
  | { ok: true; user: Awaited<ReturnType<typeof requireRole>> }
  | { ok: false; response: NextResponse };

export type OwnerAuthResult =
  | { ok: true; user: Awaited<ReturnType<typeof requireRole>> }
  | { ok: false; response: NextResponse };

/**
 * Owner-role gate shared by the owner/account API routes: runs
 * requireRole(_, 'owner') and maps an AuthError to its no-store JSON response,
 * falling back to a 401 for any other failure (the routes' long-standing
 * behavior). Returns the resolved owner user on success.
 *
 *   const auth = await requireOwnerOr401(request);
 *   if (!auth.ok) return auth.response;
 *   const user = auth.user;
 */
export async function requireOwnerOr401(request: NextRequest): Promise<OwnerAuthResult> {
  try {
    const user = await requireRole(request, 'owner');
    return { ok: true, user };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, response: jsonResponse({ error: err.message }, err.statusCode) };
    }
    return { ok: false, response: jsonResponse({ error: 'Unauthorized' }, 401) };
  }
}

/**
 * Admin-role gate shared by the admin API routes: runs `requireRole(_, 'admin')`
 * and maps an AuthError to its HTTP response, falling back to a 401 for any
 * other failure (the routes' long-standing behavior — an unexpected error is
 * surfaced as Unauthorized, not a 5xx). Returns the resolved user on success.
 *
 *   const auth = await requireAdminOr401(request);
 *   if (!auth.ok) return auth.response;
 *   // auth.user is the admin AppUser
 */
export async function requireAdminOr401(request: NextRequest): Promise<AdminAuthResult> {
  try {
    const user = await requireRole(request, 'admin');
    return { ok: true, user };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, response: NextResponse.json({ error: err.message }, { status: err.statusCode }) };
    }
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
}
