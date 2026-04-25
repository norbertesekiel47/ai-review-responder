import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { FinishSignupSchema } from '@/lib/shared/schemas';
import { accountExistsResponse } from '@/lib/shared/auth-responses';
import {
  createBusinessTx,
  DuplicateEmailError,
  type SelfServeBusinessTxInput,
} from '@/lib/onboarding/create-business';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Feature flag — hide the route entirely when off.
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 2. Same-origin check. Unlike the signup route (where an unauthenticated
  //    POST from a third-party origin still only costs us a Supabase.auth.signUp
  //    attempt), this route performs a DB write tied to an already-authenticated
  //    session — CSRF here could weaponize the victim's Supabase cookie to
  //    provision a business against their email. Hard-reject on Origin mismatch.
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    throw err;
  }

  // 3. Read session via cookie-bound anon client. setAll is a no-op — this
  //    handler never rewrites session cookies; any refresh the browser needs
  //    happens on the next page load through the middleware/page-level SSR path.
  const supabase = createServerClient(
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
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!user.email) {
    // Google OAuth without an email claim shouldn't happen in practice
    // (profile scope always includes email), but defensive guard — we cannot
    // create a users row without an email.
    return NextResponse.json({ error: 'account_incomplete' }, { status: 401 });
  }
  if (!user.email_confirmed_at) {
    // Defensive — Google OAuth always returns confirmed emails, but a future
    // provider misconfig (or password-signup session landing here by mistake)
    // must not be allowed to create a users + businesses row. Without this
    // guard, an unconfirmed session could provision the account before the
    // confirmation email was even clicked.
    return NextResponse.json({ error: 'account_incomplete' }, { status: 401 });
  }

  const authId = user.id;
  const ownerEmail = user.email.trim().toLowerCase();

  // 4. Rate limit per authId (strict — Redis down fails closed with 503).
  //    10/hour leaves slack for repeated validation-error retries; a legitimate
  //    owner completes this once but may bounce off the schema several times.
  try {
    const rl = await checkRateLimit(
      `finish-signup:auth:${authId}`,
      10,
      3600,
      { strict: true },
    );
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch (err) {
    console.error('[api/auth/finish-signup] rate-limit strict failure:', err);
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
      { status: 503 },
    );
  }

  // 5. Advisory-locked pre-check — serializes against cleanup-poller's 7-day-old
  //    candidates only. Simultaneous signups for the same email are defeated by the
  //    `users.email` UNIQUE constraint + the `DuplicateEmailError` catch below, not
  //    by this lock. The lock is released at the first tx commit; createBusinessTx
  //    runs in a fresh tx below.
  const preCheck = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${ownerEmail + ':signup'}))`;
    const [byAuth] = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE auth_id = ${authId} LIMIT 1
    `;
    if (byAuth) return { kind: 'already_complete' as const };
    const [byEmail] = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${ownerEmail} AND auth_id IS DISTINCT FROM ${authId} LIMIT 1
    `;
    if (byEmail) return { kind: 'email_exists' as const };
    return null;
  });
  if (preCheck?.kind === 'already_complete') {
    return NextResponse.json(
      { error: 'already_complete', message: 'Signup already complete' },
      { status: 409 },
    );
  }
  if (preCheck?.kind === 'email_exists') {
    return accountExistsResponse();
  }

  // 6. Parse + validate body AFTER the pre-check so we don't leak validation
  //    errors to unauthorized callers. (Earlier validation would be a minor
  //    enumeration leak — attackers could probe "does this session own an
  //    existing row" without supplying valid data.)
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = FinishSignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // 7. Build the createBusinessTx input — identity-only. The Google session
  //    supplies the email; the form supplies name + optional phone. Business
  //    details come later via /api/onboarding/business after Stripe payment.
  const input: SelfServeBusinessTxInput = {
    ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone ?? null,
  };

  // 8. Run the business-creation transaction.
  //    NO compensating cleanup on failure. Unlike the password-signup route
  //    (which owns the auth user it just created), this route's session user
  //    came from Google OAuth and predates the request. Deleting it would
  //    log the owner out of a legitimate Supabase identity and break any
  //    other app sharing that Supabase project. On error we just surface it.
  try {
    await createBusinessTx(input, { mode: 'self_serve', authId });
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      // Race between pre-check and tx — another request completed signup
      // for this email in the sub-millisecond gap. Same 409 body as the
      // pre-check's email_exists branch (enumeration defense).
      return accountExistsResponse();
    }
    console.error('[api/auth/finish-signup] createBusinessTx failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }

  // 9. Success. Google-confirmed email is auto-verified so we skip the
  //    /signup/check-email detour and go straight to payment.
  return NextResponse.json({ redirectTo: '/onboarding/pay' }, { status: 201 });
}
