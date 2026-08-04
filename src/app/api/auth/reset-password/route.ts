import { NextRequest, NextResponse } from 'next/server';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { ResetPasswordSchema } from '@/lib/shared/schemas';
import { requireAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';

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

  // 6. MFA step-up gate. The recovery OTP mints an AAL1 session; GoTrue refuses
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

  // 7. Parse + validate body.
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

  // 8. Build the success response up-front so the signOut call below has a
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

  // 9. Update password against the session-scoped Supabase client. We keep
  //    passing Supabase's raw message through (rather than a generic string)
  //    because it's genuinely useful in server logs and the network tab for
  //    debugging — the client itself renders only curated copy per error code
  //    (`mapResetPasswordError` in `ResetPasswordFormClient.tsx`), so the raw
  //    text never reaches the user. On error we DO NOT sign out — the recovery
  //    session must stay active so the user can retry with a valid password.
  const { error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (updateError) {
    // Backstop for the step-up gate above: if the pre-check ever drifts from
    // GoTrue's own rule, surface the refusal in the vocabulary the client will
    // handle once the reset cards learn `mfa_required`.
    //
    // Every other provider error keeps its real status. Flattening them all to
    // 400 is precisely what made an `insufficient_aal` 401 read as a password
    // validation failure and hid this bug — and it also swallowed the genuine
    // 401 of a session that lapsed mid-request, which the client knows how to
    // turn into the expired-link state.
    //
    // Matched on `code` alone, not the message text: the message is provider
    // copy that can be reworded at any time, and a bare 401 here is more likely
    // a lapsed session than an AAL refusal now that the gate above exists.
    const { code, status, message } = updateError;
    if (code === 'insufficient_aal') {
      return NextResponse.json({ error: 'mfa_required' }, { status: 403 });
    }
    // GoTrue's AuthRetryableFetchError carries status 0 for a failed fetch, and
    // Response rejects anything outside 200–599. Clamp to the old 400 default
    // rather than letting a transient network error throw out of the handler.
    const httpStatus =
      typeof status === 'number' && status >= 400 && status <= 599 ? status : 400;
    if (status === 401 || httpStatus !== status) {
      // A 401 that ISN'T insufficient_aal becomes the client's expired-link
      // state. If that's ever a misread AAL refusal, the user loops forever —
      // so make it visible rather than silent.
      reportCaughtError('reset-password', updateError, {
        reason: status === 401 ? 'update_user_unmapped_401' : 'update_user_unusable_status',
        providerCode: code,
        providerStatus: status,
      });
    }
    return NextResponse.json({ error: message }, { status: httpStatus });
  }

  // 10. Explicitly end the recovery session. Without signOut the browser
  //    cookie still represents the authenticated recovery session and a
  //    subsequent navigation to /dashboard would bypass the fresh-login
  //    requirement. signOut's cookie writes flow into `response` via the
  //    response-backed adapter above.
  await supabase.auth.signOut();

  return response;
}
