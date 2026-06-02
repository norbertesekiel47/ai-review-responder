import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import {
  assertImpersonationCookieConfigured,
  signImpersonationSession,
  IMPERSONATION_COOKIE_NAME,
} from '@/lib/admin/impersonation/cookie';
import { ImpersonationStartError, startImpersonationSession } from '@/lib/admin/impersonation/session';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { AuthError, requireRole } from '@/lib/db/auth';
import { sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

const StartImpersonationSchema = z.object({
  accountId: z.uuid(),
  impersonatedUserId: z.uuid(),
  ticketId: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1_000),
});

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

  try {
    assertImpersonationCookieConfigured();
  } catch (err) {
    return errorToResponse(err);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const parsed = StartImpersonationSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE },
    );
  }

  const { accountId, impersonatedUserId, ticketId, reason } = parsed.data;

  try {
    const [owner] = await sql<{ id: string; account_id: string }[]>`
      SELECT u.id, u.account_id
      FROM users u
      WHERE u.id = ${impersonatedUserId}::uuid
        AND u.account_id = ${accountId}::uuid
        AND u.role = 'owner'
        AND u.auth_id IS NOT NULL
      LIMIT 1
    `;

    if (!owner) {
      return NextResponse.json(
        { error: 'impersonated_user_not_found' },
        { status: 404, headers: NO_STORE },
      );
    }

    const { sessionId, expiresAt } = await startImpersonationSession({
      actorUserId: admin.id,
      impersonatedUserId,
      accountId,
      ticketId,
      reason,
    });

    const response = NextResponse.json(
      {
        sessionId,
        viewUrl: `/admin/impersonate/${sessionId}/view`,
        expiresAt: expiresAt.toISOString(),
      },
      { headers: NO_STORE },
    );
    response.cookies.set(IMPERSONATION_COOKIE_NAME, signImpersonationSession(sessionId), {
      httpOnly: true,
      // strict: this privileged support cookie has no legitimate cross-site flow.
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: expiresAt,
    });
    return response;
  } catch (err) {
    if (err instanceof ImpersonationStartError) {
      return NextResponse.json({ error: err.code }, { status: 409, headers: NO_STORE });
    }
    return errorToResponse(err);
  }
}

function errorToResponse(error: unknown): NextResponse {
  console.error('[api/admin/impersonation/start] Failed:', error);
  return NextResponse.json(
    { error: 'internal_error' },
    { status: 500, headers: NO_STORE },
  );
}
