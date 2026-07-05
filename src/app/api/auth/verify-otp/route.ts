import { NextRequest, NextResponse } from 'next/server';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { VerifyEmailOtpSchema } from '@/lib/shared/schemas';
import { getIpKey } from '@/lib/shared/request-ip';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import { onboardingDemoEnabled } from '@/lib/onboarding/flags';
import { enrollOwnerEmailChannel } from '@/lib/notifications/channels/enroll-email-owner';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/verify-otp
 *
 * Owner enters the 6-digit code from the signup confirmation email; this
 * route calls `supabase.auth.verifyOtp({ email, token, type: 'email' })`
 * via a cookie-aware server client and returns the post-confirmation
 * redirect target.
 *
 * Why not the email-link/`token_hash` path:
 *   Server-initiated `signUp()` with `supabase-js` defaults to implicit
 *   flow (there is no browser to stash a PKCE verifier in), so the email
 *   link comes back as `#access_token=...` which the server callback
 *   can't read. Email scanners also frequently consume single-use links
 *   before the user clicks. A 6-digit code sidesteps both: nothing to
 *   prefetch, no flow-type dependency, and the same `verifyOtp` ends
 *   with a session-cookie write through the `setAll` adapter.
 *
 * Rate-limit: 8/email/10min (typo retries) + 30/IP/10min (shared NAT).
 * Both strict — Redis down 503s rather than letting the route through.
 *
 * The flow is owner-only — `SELF_SERVE_SIGNUP_ENABLED` gates the entire
 * route; admin signup never goes through email confirmation (admins are
 * created via `supabaseServer.auth.admin.createUser({ email_confirm: true })`).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Feature flag — hide the route entirely when off.
  if (!selfServeSignupEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 2. Same-origin check. verifyOtp on success WRITES a session cookie,
  //    so a cross-origin caller riding a victim's open `/signup/check-email`
  //    tab could race-set a session against arbitrary input. Hard-reject.
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    throw err;
  }

  // 3. Parse + validate body. Email + 4–10 char alphanumeric token. The
  //    real bound check is in Supabase — this just keeps junk out.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = VerifyEmailOtpSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { email, token } = parsed.data;

  // 4. Rate-limit per email (8/10min) + per IP (30/10min). Strict — a
  //    Redis outage closes the route rather than allowing unbounded
  //    Supabase verifyOtp calls. Per-email is the tighter bound (a
  //    legitimate user retypes 1–3 times); per-IP is generous enough
  //    that a small office on shared NAT isn't blocked.
  try {
    const emailRl = await checkRateLimit(
      `verify-otp:email:${email}`,
      8,
      600,
      { strict: true },
    );
    if (!emailRl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
    const ipRl = await checkRateLimit(
      getIpKey(req, 'verify-otp'),
      30,
      600,
      { strict: true },
    );
    if (!ipRl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch (err) {
    reportCaughtError('verify-otp', err, { reason: 'rate_limit_strict_failure' });
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
      { status: 503 },
    );
  }

  // 5. Cookie jar for setAll to write session cookies into. We carry these
  //    forward to whichever final response we end up returning — success
  //    response gets the verifyOtp session; error responses (after a
  //    successful verify but failed role check) get the cleared signOut
  //    cookies.
  const cookieJar = NextResponse.json({});

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
            cookieJar.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'email',
  });

  if (error || !data.user) {
    // Generic message — don't leak whether the email was wrong vs. the
    // token was wrong vs. the token expired. Supabase's internal error
    // distinguishes them; we don't.
    return NextResponse.json(
      { error: 'invalid_or_expired_code' },
      { status: 400 },
    );
  }

  // 6. Defensive role check + account/business lookup. The expected case is
  //    role='owner' (the only callers who land here are self-serve signups).
  //    An admin auth_id reaching this route would be a misconfigured email
  //    template or a manual call — sign out and reject so we don't drop
  //    the caller into an unexpected redirect. After migration 034, users
  //    no longer have business_id; we read account_id and resolve the
  //    primary business for the channel enrollment INSERT in step 7.
  const [row] = await sql<{ role: string; account_id: string; business_id: string; user_id: string }[]>`
    SELECT u.id AS user_id, u.role, u.account_id, b.id AS business_id
    FROM users u
    JOIN businesses b ON b.account_id = u.account_id AND b.is_primary = TRUE
    WHERE u.auth_id = ${data.user.id}
    LIMIT 1
  `;
  if (!row || row.role !== 'owner') {
    await supabase.auth.signOut();
    // signOut wrote cleared cookies into cookieJar via setAll. Copy them
    // onto the error response so the bad session is actually cleared on
    // the client.
    const errorResponse = NextResponse.json(
      { error: 'account_incomplete' },
      { status: 500 },
    );
    for (const cookie of cookieJar.cookies.getAll()) {
      errorResponse.cookies.set(cookie);
    }
    return errorResponse;
  }

  // 7. Mark the email channel verified. The owner has now proven control
  //    of this inbox by entering the OTP. createBusinessTx deliberately
  //    skipped this INSERT at signup time, so the row only exists once
  //    the address is real. Idempotent via the partial-unique ON CONFLICT
  //    so a re-verify (rare — Supabase consumes the OTP — but possible if
  //    a previously-archived row is being resurrected) is a no-op.
  //
  //    Failure here means the owner has a valid session but no email
  //    channel. The OTP is already consumed by Supabase, so we can't
  //    cleanly ask them to retry — log loudly for manual backfill but
  //    don't block the redirect to /onboarding/pay.
  try {
    await enrollOwnerEmailChannel(sql, {
      accountId: row.account_id,
      businessId: row.business_id,
      ownerEmail: email,
    });
  } catch (err) {
    reportCaughtError('verify-otp', err, {
      reason: 'channel_enrollments_insert_failed',
      businessId: row.business_id,
    });
  }

  try {
    await enqueueAnalyticsEvent(sql, {
      eventName: 'email_verified',
      eventKey: makeAnalyticsEventKey('email_verified', [row.user_id]),
      distinctId: row.account_id,
      accountId: row.account_id,
      userId: row.user_id,
      properties: {
        account_id: row.account_id,
        user_id: row.user_id,
        signup_source: 'self_serve',
      },
    });
  } catch (err) {
    reportCaughtError('verify-otp', err, {
      reason: 'email_verified_analytics_enqueue_failed',
      userId: row.user_id,
    });
  }

  // Build the success response carrying the freshly-written session cookies.
  // When the pre-pay demo flag is on, send the owner to /onboarding/start
  // (location picker → demo generation) instead of straight to the paywall.
  const postVerifyRedirect =
    onboardingDemoEnabled()
      ? '/onboarding/start'
      : '/onboarding/pay';
  const successResponse = NextResponse.json({ redirectTo: postVerifyRedirect });
  for (const cookie of cookieJar.cookies.getAll()) {
    successResponse.cookies.set(cookie);
  }
  return successResponse;
}
