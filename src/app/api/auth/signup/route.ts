import { NextRequest, NextResponse } from 'next/server';
import { sql, supabaseServer } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { SignupSchema } from '@/lib/shared/schemas';
import { getIpKey } from '@/lib/shared/request-ip';
import { accountExistsResponse } from '@/lib/shared/auth-responses';
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Feature flag — hide the route entirely when off.
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 2. Rate limit (strict — Redis down fails closed; we return 503 rather
  //    than silently allowing every request through, which would let an
  //    attacker saturate Supabase signUp + our DB during a Redis outage).
  try {
    const rl = await checkRateLimit(getIpKey(req, 'signup'), 5, 3600, { strict: true });
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
    // Self-serve hardcodes tier. Admin retains founding/standard choice via the admin route.
    subscriptionTier: 'standard',
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
    // Compensating cleanup — awaited so the in-flight delete completes before
    // the HTTP response returns. We log delete failures but do not hide the
    // original error; the user sees the proper 409/500 regardless.
    try {
      await supabaseServer.auth.admin.deleteUser(authId);
    } catch (delErr) {
      console.error(
        `[signup-cleanup] Failed to delete orphan auth user ${authId}:`,
        delErr instanceof Error ? delErr.message : delErr,
      );
    }
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
