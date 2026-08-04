import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { getAdminDemos } from '@/lib/admin/demos-service';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const demos = await getAdminDemos(sql);

    return NextResponse.json(demos);
  } catch (error) {
    reportCaughtError('api/demos', error);
    return NextResponse.json(
      { error: 'Failed to fetch demos' },
      { status: 500 },
    );
  }
}
