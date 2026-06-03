import { NextRequest, NextResponse } from 'next/server';
import { IMPERSONATION_COOKIE_NAME, verifyImpersonationSession } from '@/lib/admin/impersonation/cookie';
import { endImpersonationSession } from '@/lib/admin/impersonation/session';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

async function endImpersonation(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;
  const admin = gate.admin;

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

// CSRF by construction: same-origin enforced at the export, not inside the gate.
export const POST = withSameOrigin()(endImpersonation);
