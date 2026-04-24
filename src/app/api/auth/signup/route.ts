import { NextRequest, NextResponse } from 'next/server';
import { sql, supabaseServer } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { SignupSchema } from '@/lib/shared/schemas';
import {
  createBusinessTx,
  DuplicateEmailError,
  type BusinessTxInput,
  type PlaceIdInput,
} from '@/lib/onboarding/create-business';

export const dynamic = 'force-dynamic';

// ── Local helpers (copied from src/app/api/admin/businesses/route.ts
//    for isolation — intentionally duplicated rather than exported) ──

function splitCommaOrNewline(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitParagraphs(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ipKey(req: NextRequest): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return `signup:ip:${ip}`;
}

// Standard "no enumeration leak" response used for both the advisory-locked
// pre-check hit and the Supabase signUp error path. Returning the same body
// from both paths prevents callers from using response timing/content to
// probe which emails have Supabase Auth identities vs app users rows.
function accountExistsResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'account_exists',
      message:
        'An account with this email already exists. Try logging in or use forgot password.',
    },
    { status: 409 },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Feature flag — hide the route entirely when off.
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 2. Rate limit (strict — Redis down fails closed; we return 503 rather
  //    than silently allowing every request through, which would let an
  //    attacker saturate Supabase signUp + our DB during a Redis outage).
  try {
    const rl = await checkRateLimit(ipKey(req), 5, 3600, { strict: true });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch (err) {
    console.error('[api/auth/signup] rate-limit strict failure:', err);
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
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

  // 4. Advisory-locked email pre-check. The lock on hashtext(email + ':signup')
  //    serializes against the CleanupAbandonedSignupsPoller (Task 19): the
  //    poller must take the same lock before deleting an abandoned-signup
  //    auth user, so we can't race with it and create an orphan.
  //    Short tx — take lock, SELECT, commit. createBusinessTx runs in its
  //    own independent tx later.
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
  const { data: authData, error: authError } = await supabaseServer.auth.signUp({
    email: data.ownerEmail,
    password: data.password,
    options: { emailRedirectTo },
  });
  if (authError || !authData.user) {
    // Supabase may return "User already registered" (status 422) if the
    // auth_id exists even though our app users row does not — most commonly
    // an admin-created business where the owner never confirmed. Return the
    // same 409 body as the pre-check hit to avoid enumeration leaks.
    return accountExistsResponse();
  }
  const authId = authData.user.id;

  // 6. Build the createBusinessTx input. PlaceIdInput is a discriminated
  //    union — verified path carries the canonical ID, unverified path
  //    carries the raw Maps URL for the validator worker to resolve.
  const placeIdInput: PlaceIdInput = data.googlePlaceId
    ? {
        placeIdVerified: true,
        placeId: data.googlePlaceId,
        googleMapsUrl: data.googleMapsUrl ?? null,
      }
    : {
        placeIdVerified: false,
        placeId: null,
        googleMapsUrl: data.googleMapsUrl!,
      };

  const input: BusinessTxInput = {
    ownerEmail: data.ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone ?? null,
    businessName: data.businessName,
    category: data.category ?? null,
    tone: data.tone ?? null,
    productsServices: data.productsServices ?? null,
    staffNames: splitCommaOrNewline(data.staffNames),
    highlightFacts: splitCommaOrNewline(data.highlightFacts),
    avoidFacts: splitCommaOrNewline(data.avoidFacts),
    sampleResponses: splitParagraphs(data.sampleResponses),
    subscriptionTier: data.subscriptionTier,
    website: data.website ?? null,
    placeId: placeIdInput,
  };

  // 7. Run the business-creation transaction. On ANY failure we must clean
  //    up the Supabase Auth user we just created — leaving it orphaned would
  //    block the owner from re-signing up (signUp would return 422 next time)
  //    and leave the email permanently unusable until admin intervention.
  try {
    await createBusinessTx(input, { mode: 'self_serve', authId });
  } catch (err) {
    // Compensating cleanup — best-effort. We log delete failures but do not
    // hide the original error; the user sees the proper 409/500 regardless.
    await supabaseServer.auth.admin.deleteUser(authId).catch((delErr) => {
      console.error(
        `[api/auth/signup] Failed to delete orphan auth user ${authId}:`,
        delErr,
      );
    });
    if (err instanceof DuplicateEmailError) {
      return accountExistsResponse();
    }
    console.error('[api/auth/signup] createBusinessTx failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }

  // 8. Success. Client redirects to the "check your email" screen; the
  //    Supabase confirmation email contains the real emailRedirectTo link.
  return NextResponse.json({ redirectTo: '/signup/check-email' }, { status: 201 });
}
