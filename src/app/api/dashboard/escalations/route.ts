import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { listOpenEscalations } from '@/lib/escalations/list';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  const result = await listOpenEscalations(sql, { accountId: owner.accountId });
  return jsonResponse(result);
}
