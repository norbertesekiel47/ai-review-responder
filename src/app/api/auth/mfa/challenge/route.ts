import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
const RETRY_AFTER_SECONDS = 15 * 60;

type MfaChallengeBody =
  | { action: 'challenge'; factorId: string }
  | { action: 'verify'; factorId: string; challengeId: string; code: string };

function parseBody(body: unknown): MfaChallengeBody | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const factorId = typeof record.factorId === 'string' ? record.factorId.trim() : '';
  if (!factorId) return null;

  if (record.action === 'challenge') {
    return { action: 'challenge', factorId };
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
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    const limit = await checkRateLimit(
      `mfa_challenge:${user.id}:${body.factorId}`,
      5,
      RETRY_AFTER_SECONDS,
      { strict: true },
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(RETRY_AFTER_SECONDS) } },
      );
    }
  } catch (err) {
    console.error('[mfa-challenge] rate-limit strict failure:', err);
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }

  if (body.action === 'challenge') {
    const { data, error } = await supabase.auth.mfa.challenge({
      factorId: body.factorId,
    });
    if (error || !data?.id) {
      return NextResponse.json(
        { error: 'challenge_failed' },
        { status: 400, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { challengeId: data.id },
      { status: 200, headers: NO_STORE },
    );
  }

  const { error } = await supabase.auth.mfa.verify({
    factorId: body.factorId,
    challengeId: body.challengeId,
    code: body.code,
  });
  if (error) {
    return NextResponse.json(
      { error: 'verify_failed' },
      { status: 400, headers: NO_STORE },
    );
  }

  const response = NextResponse.json(
    { ok: true },
    { status: 200, headers: NO_STORE },
  );
  for (const cookie of cookieJar.cookies.getAll()) {
    response.cookies.set(cookie);
  }
  return response;
}
