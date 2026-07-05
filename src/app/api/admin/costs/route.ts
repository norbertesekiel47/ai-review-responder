import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { parseCostQuery, getCostReport } from '@/lib/admin/cost-report-service';
import { getMarginReport } from '@/lib/admin/margin-service';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = parseCostQuery(request.nextUrl.searchParams);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const [cost, margin] = await Promise.all([
      getCostReport(sql, parsed),
      // Margin is best-effort: a fault in the new finance query must NOT take
      // down the pre-existing cost report. On failure, return the cost report
      // with `margin: null` (the admin costs page guards for a missing margin).
      getMarginReport(sql, { limit: 20 }).catch((marginErr) => {
        reportCaughtError('api/admin/costs', marginErr, {
          failure: 'margin_report_cost_report_still_returned',
        });
        return null;
      }),
    ]);
    return NextResponse.json({ ...cost, margin });
  } catch (error) {
    reportCaughtError('api/admin/costs', error, { failure: 'cost_report' });
    return NextResponse.json({ error: 'Failed to fetch cost data' }, { status: 500 });
  }
}
