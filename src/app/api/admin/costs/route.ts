import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

interface ProviderRow {
  provider: string;
  total_usd: number;
  call_count: number;
}

interface BusinessRow {
  business_id: string;
  business_name: string;
  subscription_tier: string;
  total_usd: number;
  call_count: number;
  today_usd: number;
}

interface DayRow {
  day: string;
  total_usd: number;
  call_count: number;
}

interface TodayTotalRow {
  total: number;
}

export interface CostData {
  days: number;
  byProvider: { provider: string; totalUsd: number; callCount: number }[];
  byBusiness: {
    businessId: string;
    businessName: string;
    subscriptionTier: string;
    totalUsd: number;
    callCount: number;
    todayUsd: number;
    dailyLimitUsd: number;
    pctOfDailyLimit: number;
  }[];
  byDay: { day: string; totalUsd: number; callCount: number }[];
  todayTotalUsd: number;
  globalDailyLimitUsd: number;
}

const TIER_LIMITS_CENTS: Record<string, number> = {
  founding: parseInt(process.env.FOUNDING_DAILY_COST_LIMIT_CENTS ?? '500', 10),
  standard: parseInt(process.env.STANDARD_DAILY_COST_LIMIT_CENTS ?? '1000', 10),
  premium: parseInt(process.env.PREMIUM_DAILY_COST_LIMIT_CENTS ?? '2000', 10),
};

const GLOBAL_DAILY_LIMIT_CENTS = parseInt(
  process.env.GLOBAL_DAILY_COST_LIMIT_CENTS ?? '10000',
  10,
);

function tierLimitCents(tier: string): number {
  return TIER_LIMITS_CENTS[tier] ?? TIER_LIMITS_CENTS['standard'] ?? 1000;
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
    const rawDays = request.nextUrl.searchParams.get('days');
    const days = Math.min(Math.max(parseInt(rawDays ?? '7', 10) || 7, 1), 90);

    const [providerRows, businessRows, dayRows, todayRows] = await Promise.all([
      sql<ProviderRow[]>`
        SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::int AS call_count
        FROM api_costs
        WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
        GROUP BY provider
        ORDER BY total_usd DESC
      `,
      sql<BusinessRow[]>`
        SELECT
          b.id AS business_id,
          b.name AS business_name,
          b.subscription_tier,
          SUM(ac.cost_usd)::float AS total_usd,
          COUNT(ac.id)::int AS call_count,
          SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd
        FROM api_costs ac
        JOIN businesses b ON ac.business_id = b.id
        WHERE ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
        GROUP BY b.id, b.name, b.subscription_tier
        ORDER BY total_usd DESC
      `,
      sql<DayRow[]>`
        SELECT
          DATE(created_at)::text AS day,
          SUM(cost_usd)::float AS total_usd,
          COUNT(*)::int AS call_count
        FROM api_costs
        WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
        GROUP BY DATE(created_at)
        ORDER BY day DESC
      `,
      sql<TodayTotalRow[]>`
        SELECT COALESCE(SUM(cost_usd), 0)::float AS total
        FROM api_costs
        WHERE created_at >= CURRENT_DATE
      `,
    ]);

    const data: CostData = {
      days,
      byProvider: providerRows.map((row) => ({
        provider: row.provider,
        totalUsd: row.total_usd,
        callCount: row.call_count,
      })),
      byBusiness: businessRows.map((row) => {
        const limitCents = tierLimitCents(row.subscription_tier);
        const limitUsd = limitCents / 100;
        const pctOfDailyLimit = Math.round((row.today_usd / limitUsd) * 100);
        return {
          businessId: row.business_id,
          businessName: row.business_name,
          subscriptionTier: row.subscription_tier,
          totalUsd: row.total_usd,
          callCount: row.call_count,
          todayUsd: row.today_usd,
          dailyLimitUsd: limitUsd,
          pctOfDailyLimit,
        };
      }),
      byDay: dayRows.map((row) => ({
        day: row.day,
        totalUsd: row.total_usd,
        callCount: row.call_count,
      })),
      todayTotalUsd: todayRows[0]?.total ?? 0,
      globalDailyLimitUsd: GLOBAL_DAILY_LIMIT_CENTS / 100,
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('[api/admin/costs] Failed to fetch cost data:', error);
    return NextResponse.json({ error: 'Failed to fetch cost data' }, { status: 500 });
  }
}
