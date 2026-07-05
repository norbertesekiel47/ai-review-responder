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
import { provisionAuthUser, deleteProvisionedAuthUser } from '@/lib/auth/provision-auth-user';

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

  // 4. Provision (or detect a duplicate of) the owner's Supabase Auth
  //    identity. emailRedirectTo sends the owner through /api/auth/callback
  //    with flow=owner + next=/onboarding/pay so the callback route (Task 15)
  //    can steer them to the payment link after confirmation.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const emailRedirectTo = `${appUrl}/api/auth/callback?flow=owner&next=/onboarding/pay`;
  const provisioned = await provisionAuthUser(sql, supabaseServer, {
    ownerEmail: data.ownerEmail,
    password: data.password,
    emailRedirectTo,
  });
  if (!provisioned.ok) {
    if (provisioned.reason === 'email_rate_limited') {
      return NextResponse.json(
        {
          error: 'email_rate_limited',
          message:
            'Too many signup attempts for this email recently. Please wait a few minutes and try again.',
        },
        { status: 429 },
      );
    }
    return accountExistsResponse();
  }
  const authId = provisioned.authId;

  // 5. Build the createBusinessTx input — identity-only. Business details
  //    (name, place ID, tone, etc.) are collected after Stripe payment via
  //    the /onboarding/business wizard which calls /api/onboarding/business.
  const input: SelfServeBusinessTxInput = {
    ownerEmail: data.ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone ?? null,
  };

  // 6. Run the business-creation transaction. On ANY failure we must clean
  //    up the Supabase Auth user we just created — leaving it orphaned would
  //    block the owner from re-signing up (signUp would return 422 next time)
  //    and leave the email permanently unusable until admin intervention.
  try {
    await createBusinessTx(sql, input, { mode: 'self_serve', authId });
  } catch (err) {
    // Compensating cleanup — awaited so the in-flight delete completes before
    // the HTTP response returns. Delete failures are logged (inside
    // deleteProvisionedAuthUser) but do not hide the original error; the
    // user sees the proper 409/500 regardless.
    await deleteProvisionedAuthUser(supabaseServer, authId);
    if (err instanceof DuplicateEmailError) {
      return accountExistsResponse();
    }
    reportCaughtError('api/auth/signup', err, { reason: 'create_business_tx_failed' });
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }

  // 7. Success. Client redirects to the "check your email" screen with
  //    the email pre-filled in the OTP entry form.
  const checkUrl = `/signup/check-email?email=${encodeURIComponent(data.ownerEmail)}`;
  return NextResponse.json({ redirectTo: checkUrl }, { status: 201 });
}
