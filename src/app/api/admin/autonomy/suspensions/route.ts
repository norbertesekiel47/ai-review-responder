import { NextRequest, NextResponse } from 'next/server';
import { listSuspendedPolicies } from '@/lib/auto-approval/suspension';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { sql } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  try {
    const suspensions = await listSuspendedPolicies(sql);
    return NextResponse.json({ suspensions }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return internalError('[api/admin/autonomy/suspensions] list failed:', error);
  }
}
