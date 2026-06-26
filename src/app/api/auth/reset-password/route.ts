import { NextRequest, NextResponse } from 'next/server';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { ResetPasswordSchema } from '@/lib/shared/schemas';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/reset-password
 *
 * Terminal step of the password-recovery flow. By the time this handler runs,
 * the user has already clicked the recovery email link, `/api/auth/callback`
 * has exchanged the recovery code for a session, and the session cookie is
 * bound to this request. We do NOT take a `role` from the body — the session
 * identity + the `users.role` column are the source of truth.
 *
 * Role-based flag gate: owners are gated on `SELF_SERVE_SIGNUP_ENABLED` (the
 * whole self-serve surface hides when the flag is off), but admin callers are
 * never gated — admins need a functional reset flow regardless of rollout
 * state.
 *
 * `redirectTo` is the caller's next location after the password is updated.
 * Owners land on `/login`; admins land on `/admin/login`.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Same-origin check. Password updates against an active Supabase session
  //    are a prime CSRF target — without this, a malicious page could ride
  //    the owner's recovery-flow session cookie to silently rotate their
  //    password. Hard-reject on Origin mismatch.
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    throw err;
  }

  // 2. Read session via cookie-bound anon client. setAll is a no-op for the
  //    session-read client — we never want getUser() to rewrite cookies. The
  //    post-update client (step 7) uses a response-backed adapter so signOut
  //    can actually clear the recovery session.
  const readOnlySupabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only — see comment above.
        },
      },
    },
  );

  const {
    data: { user },
  } = await readOnlySupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 3. Look up role. A valid Supabase session but NO `users` row means the
  //    Supabase identity exists without a corresponding app-scope row —
  //    always a bug (either a failed signup cleanup or a manual identity
  //    creation). Surface as 500 `account_incomplete` so the frontend can
  //    show a recovery CTA rather than silently 404-ing.
  const [row] = await sql<{ role: string }[]>`
    SELECT role FROM users WHERE auth_id = ${user.id} LIMIT 1
  `;
  if (!row) {
    return NextResponse.json(
      { error: 'account_incomplete' },
      { status: 500 },
    );
  }

  if (row.role !== 'owner' && row.role !== 'admin') {
    const response = NextResponse.json(
      { error: 'unsupported_role', redirectTo: '/admin/login' },
      { status: 403 },
    );
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return req.cookies.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      },
    );
    await supabase.auth.signOut();
    return response;
  }

  // 4. Role-based flag gate. Admin reset flow must work regardless of the
  //    self-serve rollout. Only owners 404 when the flag is off.
  const isOwner = row.role === 'owner';
  if (isOwner && !selfServeSignupEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 5. Rate limit per authId (5/hour, strict — Redis down fails closed with
  //    503). A password reset is a one-shot for a legitimate user; 5/hr
  //    covers typo-retries without leaving headroom for brute-force.
  try {
    const rl = await checkRateLimit(
      `reset-pw:auth:${user.id}`,
      5,
      3600,
      { strict: true },
    );
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch (err) {
    reportCaughtError('reset-password', err, { reason: 'rate_limit_strict_failure' });
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
      { status: 503 },
    );
  }

  // 6. Parse + validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = ResetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // 7. Build the success response up-front so the signOut call below has a
  //    cookie jar to write cleared session cookies into. Response-backed
  //    adapter: setAll writes to `response.cookies`. We only reach this point
  //    when we're about to mutate the session — any earlier exit branch uses
  //    a fresh NextResponse (no cookies to clear).
  const redirectTo = isOwner ? '/login' : '/admin/login';
  const response = NextResponse.json({ redirectTo });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // 8. Update password against the session-scoped Supabase client. Surfacing
  //    Supabase's error message (e.g. "New password should be different from
  //    the old one") is preferable to a generic 400 because the caller has
  //    already been through the recovery-email gauntlet — no enumeration
  //    concern at this step. On error we DO NOT sign out — the recovery
  //    session must stay active so the user can retry with a valid password.
  const { error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 400 });
  }

  // 9. Explicitly end the recovery session. Without signOut the browser
  //    cookie still represents the authenticated recovery session and a
  //    subsequent navigation to /dashboard would bypass the fresh-login
  //    requirement. signOut's cookie writes flow into `response` via the
  //    response-backed adapter above.
  await supabase.auth.signOut();

  return response;
}
