import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { ResetPasswordSchema } from '@/lib/shared/schemas';
import { requireAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { mapUpdateUserError } from '@/lib/auth/reset-password-error';

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
 * No flag gate: `SELF_SERVE_SIGNUP_ENABLED` now means only "strangers may mint
 * accounts" (`docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`),
 * so it must not disable password recovery for owners — under the beta posture
 * the flag is off and admin-invited owners arrive here from the invite email.
 * The boundary is the recovery session itself plus the role lookup and the
 * strict 5/hr per-authId limit below.
 *
 * `redirectTo` is the caller's next location after the password is updated.
 * Owners land on `/login`; admins land on `/admin/login`.
 */
// Nine sequential security guards (CSRF, session, role lookup, rate limit,
// AAL step-up, body validation, provider write, session
// teardown), each a hard-reject branch; the updateError taxonomy already
// moved out to mapUpdateUserError. Splitting the remaining guards into
// helper functions would trade one linear, readable sequence for
// indirection across several single-call files without reducing the actual
// number of security-relevant branches.
// fallow-ignore-next-line complexity
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
  //    post-update client (step 8) uses a response-backed adapter so signOut
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

  // `isOwner` now only decides the post-write redirect target (step 7) — it is
  // no longer an entitlement branch.
  const isOwner = row.role === 'owner';

  // 4. Rate limit per authId (5/hour, strict — Redis down fails closed with
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

  // 5. MFA step-up gate. The recovery OTP mints an AAL1 session; GoTrue refuses
  //    a password write on it whenever the account has a verified factor.
  //    requireAal2FromSupabase reads the same verified-factor list GoTrue
  //    stamps into the session, so it tracks the provider's refusal without a
  //    second round-trip. Placed BEFORE the body parse so a refused request
  //    never destructures the plaintext password, and AFTER the rate limit so
  //    a scripted prober spends its own 5/hr budget. Fails CLOSED: an
  //    unreadable AAL is not permission to write a password. 403 (not 401)
  //    because the client reads 401 as "recovery session lapsed" and would
  //    bounce the user to /forgot-password for a fresh link that fails
  //    identically.
  let aal: Awaited<ReturnType<typeof requireAal2FromSupabase>>;
  try {
    aal = await requireAal2FromSupabase(
      readOnlySupabase as unknown as SupabaseMfaAalClient,
    );
  } catch (err) {
    reportCaughtError('reset-password', err, { reason: 'aal_probe_threw' });
    return NextResponse.json({ error: 'mfa_check_failed' }, { status: 403 });
  }
  if (!aal.ok) {
    return NextResponse.json({ error: aal.reason }, { status: 403 });
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

  // 8. Update password against the session-scoped Supabase client. We keep
  //    passing Supabase's raw message through (rather than a generic string)
  //    because it's genuinely useful in server logs and the network tab for
  //    debugging — the client itself renders only curated copy per error code
  //    (`mapResetPasswordError` in `ResetPasswordFormClient.tsx`), so the raw
  //    text never reaches the user. On error we DO NOT sign out — the recovery
  //    session must stay active so the user can retry with a valid password.
  //    The error taxonomy itself lives in `mapUpdateUserError` (invariant #12:
  //    error-handling branches over ~30 lines get their own tested module).
  const { error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (updateError) {
    const mapped = mapUpdateUserError(updateError);
    if (mapped.report) {
      reportCaughtError('reset-password', updateError, mapped.report);
    }
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  // 9. Explicitly end the recovery session. Without signOut the browser
  //    cookie still represents the authenticated recovery session and a
  //    subsequent navigation to /dashboard would bypass the fresh-login
  //    requirement. signOut's cookie writes flow into `response` via the
  //    response-backed adapter above.
  await supabase.auth.signOut();

  return response;
}
