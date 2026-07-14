import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AutonomyAccountNotFoundError } from '@/lib/auto-approval/account-lock';
import { unsuspendAccountAutonomy } from '@/lib/auto-approval/suspension';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const UnsuspendSchema = z.strictObject({
  accountId: z.uuid(),
  note: z.string().trim().min(1).max(1_000),
});

async function unsuspend(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const parsed = UnsuspendSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await sql.begin((tx) => unsuspendAccountAutonomy(tx, {
      accountId: parsed.data.accountId,
      actorUserId: gate.admin.id,
      note: parsed.data.note,
    }));
    if (!result.unsuspended) {
      return NextResponse.json(
        { error: 'not_suspended' },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json({ rearmed: result.rearmed }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof AutonomyAccountNotFoundError) {
      return NextResponse.json(
        { error: 'not_suspended' },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    return internalError('[api/admin/autonomy/unsuspend] failed:', error);
  }
}

export const POST = withSameOrigin()(unsuspend);
