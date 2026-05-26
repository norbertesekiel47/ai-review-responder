import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { requireAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { AuthError, requireRole } from '@/lib/db/auth';
import { jsonb, sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
const MAX_EXTENSION_DAYS = 7;
const DAY_MS = 86_400_000;

const GrantExtensionSchema = z.object({
  accountId: z.string().uuid(),
  days: z.number().int().min(1).max(MAX_EXTENSION_DAYS),
  ticketId: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1_000),
});

class GrantExtensionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'GrantExtensionError';
  }
}

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

  const aal = await requireAal2FromSupabase(supabase);
  if (!aal.ok) {
    return NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const parsed = GrantExtensionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE },
    );
  }

  const { accountId, days, reason, ticketId } = parsed.data;
  const grantedAt = new Date();
  const expiresAt = new Date(grantedAt.getTime() + days * DAY_MS);
  const extension = {
    granted_at: grantedAt.toISOString(),
    granted_by_user_id: admin.id,
    days,
    reason,
    ticket_id: ticketId,
    expires_at: expiresAt.toISOString(),
  };

  try {
    await sql.begin(async (tx) => {
      const result = await tx`
        UPDATE accounts
        SET flags = jsonb_set(
          COALESCE(flags, '{}'::jsonb),
          '{past_due_extension}',
          ${jsonb(extension)},
          true
        )
        WHERE id = ${accountId}::uuid
          AND subscription_status = 'past_due'
      `;

      if (result.count !== 1) {
        throw new GrantExtensionError(409, 'account_not_past_due');
      }

      await writeAccountAuditLog(
        {
          accountId,
          actorUserId: admin.id,
          eventType: 'past_due_extension_granted',
          entityType: 'account',
          entityId: accountId,
          payload: {
            days,
            reason,
            ticket_id: ticketId,
            expires_at: extension.expires_at,
          },
        },
        tx,
      );
    });
  } catch (err) {
    if (err instanceof GrantExtensionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return errorToResponse(err);
  }

  return NextResponse.json(
    { ok: true, extension: { days, expires_at: extension.expires_at } },
    { headers: NO_STORE },
  );
}

function errorToResponse(error: unknown): NextResponse {
  console.error('[api/admin/billing/grant-extension] Failed:', error);
  return NextResponse.json(
    { error: 'internal_error' },
    { status: 500, headers: NO_STORE },
  );
}
