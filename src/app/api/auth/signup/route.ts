import { NextRequest, NextResponse } from 'next/server';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { sql, supabaseServer } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { SignupSchema } from '@/lib/shared/schemas';
import { getIpKey } from '@/lib/shared/request-ip';
import { accountExistsResponse } from '@/lib/shared/auth-responses';
import { botIdBlockResponse } from '@/lib/security/botid';
import {
  createBusinessTx,
  DuplicateEmailError,
  type SelfServeBusinessTxInput,
} from '@/lib/onboarding/create-business';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Feature flag — hide the route entirely when off.
  if (!selfServeSignupEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 1b. Vercel BotID (Deep Analysis) — reject bots before we touch Redis,
  //     Supabase Auth, or the DB. Fails open on a BotID infra error.
  const botBlock = await botIdBlockResponse('/api/auth/signup');
  if (botBlock) return botBlock;

  // 2. Rate limit (strict — Redis down fails closed; we return 503 rather
  //    than silently allowing every request through, which would let an
  //    attacker saturate Supabase signUp + our DB during a Redis outage).
  try {
    const rl = await checkRateLimit(getIpKey(req, 'signup'), 5, 3600, { strict: true });
    if (!rl.allowed) {
      // Include a human-readable `message` so the client doesn't display
      // the raw `rate_limited` machine code as the form error. Same pattern
      // as the email_rate_limited branch below + the resend-confirmation
      // route — every error body the SignupFormClient could render now
      // carries a `message` field.
      return NextResponse.json(
        {
          error: 'rate_limited',
          message:
            'Too many signup attempts from your network. Please wait a few minutes and try again.',
        },
        { status: 429 },
      );
    }
  } catch (err) {
    reportCaughtError('api/auth/signup', err, { reason: 'rate_limit_strict_failure' });
    return NextResponse.json(
      {
        error: 'rate_limit_unavailable',
        message:
          'Signup is temporarily unavailable. Please try again in a moment.',
      },
      { status: 503 },
    );
  }

  // 3. Parse + validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // 4. Advisory-locked pre-check — serializes against cleanup-poller's 7-day-old
  //    candidates only. Simultaneous signups for the same email are defeated by the
  //    `users.email` UNIQUE constraint + the `DuplicateEmailError` catch below, not
  //    by this lock. The lock is released at the first tx commit; createBusinessTx
  //    runs in a fresh tx below.
  const preCheck = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${data.ownerEmail + ':signup'}))`;
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${data.ownerEmail} LIMIT 1
    `;
    return existing;
  });
  if (preCheck) {
    return accountExistsResponse();
  }

  // 5. Create Supabase Auth user. emailRedirectTo sends the owner through
  //    /api/auth/callback with flow=owner + next=/onboarding/pay so the
  //    callback route (Task 15) can steer them to the payment link after
  //    confirmation.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const emailRedirectTo = `${appUrl}/api/auth/callback?flow=owner&next=/onboarding/pay`;
  const signUpStartedAt = new Date();
  const { data: authData, error: authError } = await supabaseServer.auth.signUp({
    email: data.ownerEmail,
    password: data.password,
    options: { emailRedirectTo },
  });
  let authUser = authData.user;

  // Hosted Supabase Auth can return `{ error: null, user: null }` while still
  // creating auth.users + sending the confirmation email. Recover the id from
  // the private auth schema so the app rows are linked to the real identity.
  if (!authError && !authUser) {
    const [createdAuthUser] = await sql<{ id: string }[]>`
      SELECT id::text
      FROM auth.users
      WHERE lower(email) = ${data.ownerEmail}
        AND created_at >= ${signUpStartedAt.toISOString()}::timestamptz - interval '5 seconds'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (createdAuthUser) {
      authUser = { id: createdAuthUser.id } as NonNullable<typeof authData.user>;
    }
  }

  // Anti-enumeration obfuscation guard.
  //
  // Supabase can return `user.identities = []` for the anti-enumeration
  // duplicate-account response, but current hosted Auth can also return an
  // empty identities array for a real newly-created email signup while the
  // identity is already present in auth.identities. Do not use the response
  // shape alone as the duplicate signal. Confirm the returned id exists in
  // Auth before using it as users.auth_id; fake ids must still be rejected.
  if (authUser && Array.isArray(authUser.identities) && authUser.identities.length === 0) {
    const { data: lookupData, error: lookupError } =
      await supabaseServer.auth.admin.getUserById(authUser.id);
    const lookupEmail = lookupData.user?.email?.trim().toLowerCase();
    if (lookupError || !lookupData.user || lookupEmail !== data.ownerEmail) {
      console.warn(
        `[api/auth/signup] Supabase returned unconfirmed/fake user (empty identities) for ${data.ownerEmail} — treating as account_exists`,
      );
      return accountExistsResponse();
    }
    console.warn(
      `[api/auth/signup] Supabase returned empty identities for real new user ${data.ownerEmail}; continuing signup`,
    );
  }

  if (authError || !authUser) {
    // Disambiguate Supabase email-send rate limits (most common during dev)
    // from account-exists. Conflating them yields a confusing "account
    // exists" message when in fact the inbox is just hot. The auth.users
    // row is NOT created when this fires, so retrying after the cooldown
    // is the right path — not "go log in".
    const code = (authError as { code?: string; status?: number } | null)?.code;
    const status = (authError as { code?: string; status?: number } | null)?.status;
    const isRateLimit =
      code === 'over_email_send_rate_limit' ||
      code === 'email_send_rate_limit' ||
      status === 429;
    if (isRateLimit) {
      console.warn(
        `[api/auth/signup] Supabase email rate limit hit for ${data.ownerEmail} (code=${code}, status=${status})`,
      );
      return NextResponse.json(
        {
          error: 'email_rate_limited',
          message:
            'Too many signup attempts for this email recently. Please wait a few minutes and try again.',
        },
        { status: 429 },
      );
    }
    // Supabase may return "User already registered" (status 422) if the
    // auth_id exists even though our app users row does not — most commonly
    // an admin-created business where the owner never confirmed. Return the
    // same 409 body as the pre-check hit to avoid enumeration leaks.
    if (authError) {
      console.warn(
        `[api/auth/signup] Supabase signUp error for ${data.ownerEmail}: code=${code} status=${status} message=${authError.message}`,
      );
    }
    return accountExistsResponse();
  }
  const authId = authUser.id;

  // 6. Build the createBusinessTx input — identity-only. Business details
  //    (name, place ID, tone, etc.) are collected after Stripe payment via
  //    the /onboarding/business wizard which calls /api/onboarding/business.
  const input: SelfServeBusinessTxInput = {
    ownerEmail: data.ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone ?? null,
  };

  // 7. Run the business-creation transaction. On ANY failure we must clean
  //    up the Supabase Auth user we just created — leaving it orphaned would
  //    block the owner from re-signing up (signUp would return 422 next time)
  //    and leave the email permanently unusable until admin intervention.
  try {
    await createBusinessTx(input, { mode: 'self_serve', authId });
  } catch (err) {
    // Compensating cleanup — awaited so the in-flight delete completes before
    // the HTTP response returns. We log delete failures but do not hide the
    // original error; the user sees the proper 409/500 regardless.
    try {
      await supabaseServer.auth.admin.deleteUser(authId);
    } catch (delErr) {
      reportCaughtError('signup-cleanup', delErr, {
        reason: 'orphan_auth_user_delete_failed',
        authId,
      });
    }
    if (err instanceof DuplicateEmailError) {
      return accountExistsResponse();
    }
    reportCaughtError('api/auth/signup', err, { reason: 'create_business_tx_failed' });
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }

  // 8. Success. Client redirects to the "check your email" screen with
  //    the email pre-filled in the OTP entry form.
  const checkUrl = `/signup/check-email?email=${encodeURIComponent(data.ownerEmail)}`;
  return NextResponse.json({ redirectTo: checkUrl }, { status: 201 });
}
