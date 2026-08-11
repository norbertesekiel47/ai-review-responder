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
    // SEQUENTIAL — do NOT re-introduce a Promise.all here (#505). Both callees
    // share the SAME `sql` client (pool = DB_POOL_MAX = 3 on Vercel) and
    // getMarginReport is itself a 3-query fan-out, so running them together put
    // 4 queries in flight against a 3-connection pool. Over the Supavisor
    // TRANSACTION pooler that pipelines the excess query onto an already-open
    // connection, whose response then parks server-side in state=active /
    // wait_event=ClientRead and is never read — a permanent Connection wedge.
    const cost = await getCostReport(sql, parsed);
    // Margin is best-effort: a fault in the new finance query must NOT take
    // down the pre-existing cost report. On failure, return the cost report
    // with `margin: null` (the admin costs page guards for a missing margin).
    const margin = await getMarginReport(sql, { limit: 20 }).catch((marginErr) => {
      reportCaughtError('api/admin/costs', marginErr, {
        failure: 'margin_report_cost_report_still_returned',
      });
      return null;
    });
    return NextResponse.json({ ...cost, margin });
  } catch (error) {
    reportCaughtError('api/admin/costs', error, { failure: 'cost_report' });
    return NextResponse.json({ error: 'Failed to fetch cost data' }, { status: 500 });
  }
}
