import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { IMPERSONATION_COOKIE_NAME, verifyImpersonationSession } from '@/lib/admin/impersonation/cookie';
import { endImpersonationSession } from '@/lib/admin/impersonation/session';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { AuthError, requireRole } from '@/lib/db/auth';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    return errorToResponse(err);
  }

  let admin;
  try {
    admin = await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode, headers: NO_STORE },
      );
    }
    return errorToResponse(err);
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // Route handlers cannot mutate request cookies; proxy handles refresh.
        },
      },
    },
  ) as SupabaseMfaAalClient;

  const aal = await requireCurrentAal2FromSupabase(supabase);
  if (!aal.ok) {
    return NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE });
  }

  const rawCookie = request.cookies.get(IMPERSONATION_COOKIE_NAME)?.value;
  let sessionId: string | null;
  try {
    sessionId = rawCookie ? verifyImpersonationSession(rawCookie) : null;
  } catch (err) {
    return errorToResponse(err);
  }
  if (!sessionId) {
    return NextResponse.json(
      { error: 'invalid_impersonation_session' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    await endImpersonationSession({ sessionId, actorUserId: admin.id });
  } catch (err) {
    return errorToResponse(err);
  }

  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set(IMPERSONATION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(0),
    maxAge: 0,
  });
  return response;
}

function errorToResponse(error: unknown): NextResponse {
  console.error('[api/admin/impersonation/end] Failed:', error);
  return NextResponse.json(
    { error: 'internal_error' },
    { status: 500, headers: NO_STORE },
  );
}
