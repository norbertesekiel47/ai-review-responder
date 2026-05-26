import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
const RETRY_AFTER_SECONDS = 15 * 60;

// Per-action rate-limit budgets keyed separately so a challenge+verify pair
// (one per attempt) does not drain a single shared counter and lock the user
// out after ~2 mistyped codes.
const RATE_LIMITS = { challenge: 15, verify: 8, unenroll: 5 } as const;

type MfaChallengeBody =
  | { action: 'challenge'; factorId: string }
  | { action: 'verify'; factorId: string; challengeId: string; code: string }
  | { action: 'unenroll'; factorId: string };

function parseBody(body: unknown): MfaChallengeBody | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const factorId = typeof record.factorId === 'string' ? record.factorId.trim() : '';
  if (!factorId) return null;

  if (record.action === 'challenge') {
    return { action: 'challenge', factorId };
  }

  if (record.action === 'unenroll') {
    return { action: 'unenroll', factorId };
  }

  if (record.action === 'verify') {
    const challengeId =
      typeof record.challengeId === 'string' ? record.challengeId.trim() : '';
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    if (!challengeId || !code) return null;
    return { action: 'verify', factorId, challengeId, code };
  }

  return null;
}

// Best-effort MFA audit: never block the auth action on an audit-write failure,
// but record actor actions (factor removal, verify outcomes) for the trail.
async function auditMfaEvent(
  authUserId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const [actor] = await sql<{ id: string; account_id: string | null }[]>`
      SELECT id, account_id FROM users WHERE auth_id = ${authUserId} LIMIT 1
    `;
    if (actor?.account_id) {
      await writeAccountAuditLog({
        accountId: actor.account_id,
        actorUserId: actor.id,
        eventType,
        payload,
      });
    }
  } catch (err) {
    console.error('[mfa-challenge] audit write failed:', err);
  }
}

function jsonWithCookies(
  cookieJar: NextResponse,
  body: Record<string, unknown>,
  init: { status: number; headers?: HeadersInit },
): NextResponse {
  const response = NextResponse.json(body, init);
  for (const cookie of cookieJar.cookies.getAll()) {
    response.cookies.set(cookie);
  }
  return response;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json(
        { error: 'forbidden' },
        { status: 403, headers: NO_STORE },
      );
    }
    throw err;
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400, headers: NO_STORE },
    );
  }

  const body = parseBody(rawBody);
  if (!body) {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: NO_STORE },
    );
  }

  const cookieJar = NextResponse.json({}, { headers: NO_STORE });
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

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return jsonWithCookies(
      cookieJar,
      { error: 'unauthorized' },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    const limit = await checkRateLimit(
      `mfa:${body.action}:${user.id}:${body.factorId}`,
      RATE_LIMITS[body.action],
      RETRY_AFTER_SECONDS,
      { strict: true },
    );
    if (!limit.allowed) {
      return jsonWithCookies(
        cookieJar,
        { error: 'rate_limited' },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(RETRY_AFTER_SECONDS) } },
      );
    }
  } catch (err) {
    console.error('[mfa-challenge] rate-limit strict failure:', err);
    return jsonWithCookies(
      cookieJar,
      { error: 'rate_limit_unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }

  if (body.action === 'challenge') {
    const { data, error } = await supabase.auth.mfa.challenge({
      factorId: body.factorId,
    });
    if (error || !data?.id) {
      return jsonWithCookies(
        cookieJar,
        { error: 'challenge_failed' },
        { status: 400, headers: NO_STORE },
      );
    }
    return jsonWithCookies(
      cookieJar,
      { challengeId: data.id },
      { status: 200, headers: NO_STORE },
    );
  }

  if (body.action === 'unenroll') {
    // Removing a factor is account-takeover-sensitive: require a currently
    // stepped-up (AAL2) session, not merely an enrolled factor. A lost factor
    // is handled by the documented support path, not an AAL1 self-serve removal.
    const aal = await requireCurrentAal2FromSupabase(
      supabase as unknown as SupabaseMfaAalClient,
    );
    if (!aal.ok) {
      return jsonWithCookies(
        cookieJar,
        { error: 'mfa_required' },
        { status: 403, headers: NO_STORE },
      );
    }
    const { error } = await supabase.auth.mfa.unenroll({ factorId: body.factorId });
    if (error) {
      return jsonWithCookies(
        cookieJar,
        { error: 'unenroll_failed' },
        { status: 400, headers: NO_STORE },
      );
    }
    await auditMfaEvent(user.id, 'mfa_factor_unenrolled', { factor_id: body.factorId });
    return jsonWithCookies(cookieJar, { ok: true }, { status: 200, headers: NO_STORE });
  }

  const { error } = await supabase.auth.mfa.verify({
    factorId: body.factorId,
    challengeId: body.challengeId,
    code: body.code,
  });
  if (error) {
    await auditMfaEvent(user.id, 'mfa_challenge_failed', { factor_id: body.factorId });
    return jsonWithCookies(
      cookieJar,
      { error: 'verify_failed' },
      { status: 400, headers: NO_STORE },
    );
  }

  await auditMfaEvent(user.id, 'mfa_challenge_succeeded', { factor_id: body.factorId });
  return jsonWithCookies(
    cookieJar,
    { ok: true },
    { status: 200, headers: NO_STORE },
  );
}
