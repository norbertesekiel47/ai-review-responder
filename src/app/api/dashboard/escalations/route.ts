import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { listOpenEscalations } from '@/lib/escalations/list';
import { withDashboardOwnerRead } from '../policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/escalations',
    errorMessage: 'Failed to fetch escalations',
  }, async ({ accountId }) => {
    const result = await listOpenEscalations(sql, { accountId });
    return jsonResponse(result);
  });
}
