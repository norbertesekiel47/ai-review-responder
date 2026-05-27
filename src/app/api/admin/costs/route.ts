import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { parseCostQuery, getCostReport } from '@/lib/admin/cost-report-service';
import { getMarginReport } from '@/lib/admin/margin-service';

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
      getCostReport(parsed),
      // Margin is best-effort: a fault in the new finance query must NOT take
      // down the pre-existing cost report. On failure, return the cost report
      // with `margin: null` (the admin costs page guards for a missing margin).
      getMarginReport({ limit: 20 }).catch((marginErr) => {
        console.error(
          '[api/admin/costs] margin computation failed (cost report still returned):',
          marginErr,
        );
        return null;
      }),
    ]);
    return NextResponse.json({ ...cost, margin });
  } catch (error) {
    console.error('[api/admin/costs] Failed to fetch cost data:', error);
    return NextResponse.json({ error: 'Failed to fetch cost data' }, { status: 500 });
  }
}
