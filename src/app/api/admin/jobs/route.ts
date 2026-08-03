import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getAdminJobsData, type AdminJobsData } from '@/lib/admin/jobs-service';
import { fetchQueueHealth, type PoolWaitPayload } from '@/lib/admin/queue-health';

export const dynamic = 'force-dynamic';

type JobsData = AdminJobsData & {
  limit: number;
  offset: number;
  queueHealth: Record<string, Record<string, number>> | { unavailable: true };
  pool: PoolWaitPayload | null;
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const rawLimit = request.nextUrl.searchParams.get('limit');
    const rawOffset = request.nextUrl.searchParams.get('offset');
    const limit = Math.min(Math.max(parseInt(rawLimit ?? '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(rawOffset ?? '0', 10) || 0, 0);

    const [jobs, { queueHealth, pool }] = await Promise.all([
      getAdminJobsData(sql, { limit, offset }),
      fetchQueueHealth(),
    ]);

    const data: JobsData = {
      ...jobs,
      limit,
      offset,
      queueHealth,
      pool,
    };

    return NextResponse.json(data);
  } catch (error) {
    reportCaughtError('api/admin/jobs', error);
    return NextResponse.json({ error: 'Failed to fetch job data' }, { status: 500 });
  }
}
