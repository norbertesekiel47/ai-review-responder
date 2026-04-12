import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

interface SystemHealthRow {
  count: number;
}

interface CostRow {
  total: number;
}

interface BusinessRow {
  id: string;
  name: string;
  subscription_status: string;
  last_sync_at: Date | null;
  pending_approval_count: number;
  total_responses: number;
  completed_responses: number;
  avg_response_time_hours: number | null;
  last_activity: Date | null;
}

export interface OverviewData {
  systemHealth: {
    pendingOutbox: number;
    failedJobs: number;
    todayCostUsd: number;
    notificationFailures24h: number;
  };
  totalBusinesses: number;
  limit: number;
  offset: number;
  businesses: {
    id: string;
    name: string;
    subscriptionStatus: string;
    lastSyncAt: string | null;
    pendingApprovalCount: number;
    totalResponses: number;
    completedResponses: number;
    responseRate: number;
    avgResponseTimeHours: number | null;
    lastActivity: string | null;
  }[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10) || 20, 100);
    const offset = Math.max(parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0, 0);

    const [
      pendingOutboxRows,
      failedJobsRows,
      todayCostRows,
      notifFailureRows,
      businessRows,
      businessCountRows,
    ] = await Promise.all([
      sql<SystemHealthRow[]>`
        SELECT COUNT(*)::int AS count FROM job_outbox WHERE status = 'pending'
      `,
      sql<SystemHealthRow[]>`
        SELECT COUNT(*)::int AS count FROM job_outbox WHERE status = 'failed'
      `,
      sql<CostRow[]>`
        SELECT COALESCE(SUM(cost_usd), 0)::float AS total FROM api_costs WHERE created_at >= CURRENT_DATE
      `,
      sql<SystemHealthRow[]>`
        SELECT COUNT(*)::int AS count FROM notification_deliveries WHERE failed_at IS NOT NULL AND failed_at >= NOW() - INTERVAL '24 hours'
      `,
      sql<BusinessRow[]>`
        SELECT
          b.id, b.name, b.subscription_status, b.last_sync_at,
          COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count,
          COUNT(resp.id)::int AS total_responses,
          COUNT(CASE WHEN resp.status IN ('posted', 'awaiting_manual_post', 'approved', 'edited') THEN 1 END)::int AS completed_responses,
          ROUND(EXTRACT(EPOCH FROM AVG(CASE WHEN resp.approved_at IS NOT NULL THEN resp.approved_at - resp.created_at END)) / 3600.0, 1)::float AS avg_response_time_hours,
          MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity
        FROM businesses b
        LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded'
        GROUP BY b.id, b.name, b.subscription_status, b.last_sync_at
        ORDER BY COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END) DESC, b.name ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM businesses`,
    ]);

    const data: OverviewData = {
      systemHealth: {
        pendingOutbox: pendingOutboxRows[0]?.count ?? 0,
        failedJobs: failedJobsRows[0]?.count ?? 0,
        todayCostUsd: todayCostRows[0]?.total ?? 0,
        notificationFailures24h: notifFailureRows[0]?.count ?? 0,
      },
      totalBusinesses: businessCountRows[0]?.total ?? 0,
      limit,
      offset,
      businesses: businessRows.map((row) => {
        const responseRate =
          row.total_responses > 0
            ? Math.round((row.completed_responses / row.total_responses) * 100)
            : 0;
        return {
          id: row.id,
          name: row.name,
          subscriptionStatus: row.subscription_status,
          lastSyncAt: row.last_sync_at ? row.last_sync_at.toISOString() : null,
          pendingApprovalCount: row.pending_approval_count,
          totalResponses: row.total_responses,
          completedResponses: row.completed_responses,
          responseRate,
          avgResponseTimeHours: row.avg_response_time_hours ?? null,
          lastActivity: row.last_activity ? row.last_activity.toISOString() : null,
        };
      }),
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('[api/admin/overview] Failed to fetch overview:', error);
    return NextResponse.json(
      { error: 'Failed to fetch overview' },
      { status: 500 },
    );
  }
}
