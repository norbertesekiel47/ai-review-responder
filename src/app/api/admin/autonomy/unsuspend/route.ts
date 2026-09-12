import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AutonomyAccountNotFoundError } from '@/lib/auto-approval/account-lock';
import { unsuspendAccountAutonomy } from '@/lib/auto-approval/suspension';
import { internalError, requireAdminJson } from '@/lib/auth/admin-mfa-gate';
import { sql } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const UnsuspendSchema = z.strictObject({
  accountId: z.uuid(),
  note: z.string().trim().min(1).max(1_000),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminJson(request, UnsuspendSchema);
  if (!gate.ok) return gate.response;

  try {
    const result = await sql.begin((tx) => unsuspendAccountAutonomy(tx, {
      accountId: gate.data.accountId,
      actorUserId: gate.admin.id,
      note: gate.data.note,
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
