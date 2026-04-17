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
  totalBusinesses: number;
  limit: number;
  offset: number;
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
  founding: parseInt(process.env.DAILY_COST_LIMIT_CENTS_FOUNDING ?? '500', 10),
  standard: parseInt(process.env.DAILY_COST_LIMIT_CENTS_STANDARD ?? '1000', 10),
  premium: parseInt(process.env.DAILY_COST_LIMIT_CENTS_PREMIUM ?? '2000', 10),
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
    const rawParsed = parseInt(rawDays ?? '7', 10);
    // Fall back to 7 only when parse FAILS (NaN). Preserve 0 / negatives so the
    // clamp below can correctly bring them to 1 instead of silently defaulting.
    const parsedDays = Number.isNaN(rawParsed) ? 7 : rawParsed;
    if (parsedDays > 365) {
      return NextResponse.json(
        { error: 'days parameter must be 365 or less' },
        { status: 400 },
      );
    }
    const days = Math.min(Math.max(parsedDays, 1), 365);
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10) || 20, 100);
    const offset = Math.max(parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0, 0);
    const needsRollup = days > 90;

    // Detail queries always run — cover the most recent up-to-90 days.
    const [providerRows, businessRows, businessCountRows, dayRows, todayRows] = await Promise.all([
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
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ total: number }[]>`
        SELECT COUNT(DISTINCT b.id)::int AS total
        FROM api_costs ac JOIN businesses b ON ac.business_id = b.id
        WHERE ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
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

    // Rollup queries only when range extends beyond 90 days.
    // Rollups cover the archived tail: [startDate, CURRENT_DATE - 90d).
    // Detail covers: [CURRENT_DATE - min(days, 90), CURRENT_DATE].
    let rollupProvider: ProviderRow[] = [];
    let rollupDay: DayRow[] = [];
    const rollupBusinessTotals = new Map<string, { total_usd: number; call_count: number }>();

    if (needsRollup) {
      const [provRes, dayRes, bizRes] = await Promise.all([
        sql<ProviderRow[]>`
          SELECT provider, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::int AS call_count
          FROM api_costs_daily_rollups
          WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
            AND rollup_date < CURRENT_DATE - INTERVAL '90 days'
          GROUP BY provider
        `,
        sql<DayRow[]>`
          SELECT rollup_date::text AS day, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::int AS call_count
          FROM api_costs_daily_rollups
          WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
            AND rollup_date < CURRENT_DATE - INTERVAL '90 days'
          GROUP BY rollup_date
        `,
        sql<{ business_id: string; total_usd: number; call_count: number }[]>`
          SELECT business_id, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::int AS call_count
          FROM api_costs_daily_rollups
          WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
            AND rollup_date < CURRENT_DATE - INTERVAL '90 days'
            AND business_id IS NOT NULL
          GROUP BY business_id
        `,
      ]);
      rollupProvider = provRes;
      rollupDay = dayRes;
      for (const row of bizRes) {
        rollupBusinessTotals.set(row.business_id, {
          total_usd: row.total_usd,
          call_count: row.call_count,
        });
      }
    }

    // Merge byProvider: sum detail + rollup by provider key.
    const providerMap = new Map<string, { totalUsd: number; callCount: number }>();
    for (const row of providerRows) {
      providerMap.set(row.provider, { totalUsd: row.total_usd, callCount: row.call_count });
    }
    for (const row of rollupProvider) {
      const existing = providerMap.get(row.provider);
      if (existing) {
        existing.totalUsd += row.total_usd;
        existing.callCount += row.call_count;
      } else {
        providerMap.set(row.provider, { totalUsd: row.total_usd, callCount: row.call_count });
      }
    }
    const byProvider = Array.from(providerMap.entries())
      .map(([provider, v]) => ({ provider, totalUsd: v.totalUsd, callCount: v.callCount }))
      .sort((a, b) => b.totalUsd - a.totalUsd);

    // Merge byDay: one row per date, detail OR rollup (the two ranges do not overlap).
    const dayMap = new Map<string, { totalUsd: number; callCount: number }>();
    for (const row of dayRows) {
      dayMap.set(row.day, { totalUsd: row.total_usd, callCount: row.call_count });
    }
    for (const row of rollupDay) {
      // Detail and rollup ranges are non-overlapping by construction.
      // Defensively: if a key collides, detail wins (already set above).
      if (!dayMap.has(row.day)) {
        dayMap.set(row.day, { totalUsd: row.total_usd, callCount: row.call_count });
      }
    }
    const byDay = Array.from(dayMap.entries())
      .map(([day, v]) => ({ day, totalUsd: v.totalUsd, callCount: v.callCount }))
      .sort((a, b) => b.day.localeCompare(a.day));

    // Merge byBusiness: add rollup totals to the paginated detail rows.
    const byBusiness = businessRows.map((row) => {
      const limitCents = tierLimitCents(row.subscription_tier);
      const limitUsd = limitCents / 100;
      const rollupExtra = rollupBusinessTotals.get(row.business_id);
      const totalUsd = row.total_usd + (rollupExtra?.total_usd ?? 0);
      const callCount = row.call_count + (rollupExtra?.call_count ?? 0);
      const pctOfDailyLimit = Math.round((row.today_usd / limitUsd) * 100);
      return {
        businessId: row.business_id,
        businessName: row.business_name,
        subscriptionTier: row.subscription_tier,
        totalUsd,
        callCount,
        todayUsd: row.today_usd,
        dailyLimitUsd: limitUsd,
        pctOfDailyLimit,
      };
    });

    const data: CostData = {
      days,
      totalBusinesses: businessCountRows[0]?.total ?? 0,
      limit,
      offset,
      byProvider,
      byBusiness,
      byDay,
      todayTotalUsd: todayRows[0]?.total ?? 0,
      globalDailyLimitUsd: GLOBAL_DAILY_LIMIT_CENTS / 100,
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('[api/admin/costs] Failed to fetch cost data:', error);
    return NextResponse.json({ error: 'Failed to fetch cost data' }, { status: 500 });
  }
}
