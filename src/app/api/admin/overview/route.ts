import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { computeChurnRiskScore, type ChurnScore } from '@/lib/shared/churn-score';

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
    churnScore: {
      score: number;
      level: 'healthy' | 'watch' | 'at_risk';
      breakdown: Array<{ signal: string; value: string; contribution: number }>;
    };
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

    const businessIds = businessRows.map((r) => r.id);

    const metricsRows = businessIds.length > 0
      ? await sql<{
          business_id: string;
          approval_rate: number | null;
          notified_count: number;
          pending_count: number;
          days_since_approval: number | null;
          account_age_days: number;
          avg_hours_current: number | null;
          avg_hours_prev: number | null;
        }[]>`
          WITH biz AS (SELECT UNNEST(${businessIds}::uuid[]) AS id),
          notif AS (
            SELECT nd.business_id,
                   COUNT(DISTINCT nd.response_id)::int AS notified_count,
                   COUNT(DISTINCT nd.response_id) FILTER (
                     WHERE r.status IN ('approved','edited','posted','awaiting_manual_post')
                   )::int AS approved_count
            FROM notification_deliveries nd
            JOIN responses r ON r.id = nd.response_id
            WHERE nd.business_id IN (SELECT id FROM biz)
              AND nd.template = 'approval_request'
              AND nd.sent_at IS NOT NULL
              AND nd.sent_at >= CURRENT_DATE - 30
            GROUP BY nd.business_id
          ),
          resp AS (
            SELECT rp.business_id,
                   COUNT(*) FILTER (WHERE rp.status = 'pending_approval')::int AS pending_count,
                   EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(rp.approved_at)
                     FILTER (WHERE rp.status IN ('approved','edited','posted','awaiting_manual_post'))
                   )::int AS days_since_approval,
                   AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0)
                     FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 7)::float AS avg_hours_current,
                   AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0)
                     FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 35 AND rp.created_at < CURRENT_DATE - 7)::float AS avg_hours_prev
            FROM responses rp
            WHERE rp.business_id IN (SELECT id FROM biz)
            GROUP BY rp.business_id
          )
          SELECT
            b.id AS business_id,
            CASE WHEN COALESCE(n.notified_count, 0) >= 3
                 THEN n.approved_count::float / NULLIF(n.notified_count, 0)
                 ELSE NULL END AS approval_rate,
            COALESCE(n.notified_count, 0)::int AS notified_count,
            COALESCE(rp.pending_count, 0)::int AS pending_count,
            rp.days_since_approval,
            EXTRACT(DAY FROM CURRENT_TIMESTAMP - bs.created_at)::int AS account_age_days,
            rp.avg_hours_current,
            rp.avg_hours_prev
          FROM biz b
          JOIN businesses bs ON bs.id = b.id
          LEFT JOIN notif n ON n.business_id = b.id
          LEFT JOIN resp rp ON rp.business_id = b.id
        `
      : [];

    const metricsMap = new Map(metricsRows.map((r) => [r.business_id, r]));

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

        const m = metricsMap.get(row.id);

        let responseTimeTrend: 'faster_or_stable' | 'slower' | 'stopped' | null = null;
        if (m?.avg_hours_current != null && m?.avg_hours_prev != null) {
          responseTimeTrend = m.avg_hours_current > m.avg_hours_prev * 1.5 ? 'slower' : 'faster_or_stable';
        } else if (m && m.pending_count > 0 && m.days_since_approval != null && m.days_since_approval > 7) {
          responseTimeTrend = 'stopped';
        }

        const churnScore = computeChurnRiskScore({
          approvalRate: m?.approval_rate ?? null,
          notifiedResponseCount30d: m?.notified_count ?? 0,
          pendingResponseCount: m?.pending_count ?? 0,
          daysSinceLastApproval: m?.days_since_approval ?? null,
          satisfactionResponses: null,
          responseTimeTrend,
          accountAgeDays: m?.account_age_days ?? 0,
        });

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
          churnScore,
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
