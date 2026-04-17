import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

interface ProviderRow {
  provider: string;
  total_usd: number;
  call_count: number;
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

    // Parse limit/offset: NaN → default, negatives → clamp (not silently pass through).
    // parseInt('-5') returns -5 which is truthy; `|| 20` wouldn't fire, so a naïve
    // Math.min(-5, 100) would produce LIMIT -5 and crash the query.
    const rawLimit = request.nextUrl.searchParams.get('limit');
    const parsedLimit = parseInt(rawLimit ?? '20', 10);
    const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);

    const rawOffset = request.nextUrl.searchParams.get('offset');
    const parsedOffset = parseInt(rawOffset ?? '0', 10);
    const offset = Number.isNaN(parsedOffset) ? 0 : Math.max(parsedOffset, 0);

    const needsRollup = days > 90;

    // Detail queries always run — cover the most recent up-to-90 days.
    // byBusiness aggregation no longer pre-joins/paginates here; we merge with
    // rollup totals below and paginate on combined totals so businesses with
    // only archived activity don't disappear from reporting.
    const [providerRows, detailBusinessRows, dayRows, todayRows] = await Promise.all([
      sql<ProviderRow[]>`
        SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::int AS call_count
        FROM api_costs
        WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
        GROUP BY provider
        ORDER BY total_usd DESC
      `,
      sql<{ business_id: string; total_usd: number; call_count: number; today_usd: number }[]>`
        SELECT
          business_id,
          SUM(cost_usd)::float AS total_usd,
          COUNT(*)::int AS call_count,
          SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd
        FROM api_costs
        WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
          AND business_id IS NOT NULL
        GROUP BY business_id
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

    // Merge byDay: ADDITIVE. Detail and rollup never reference the same source
    // row (archival deletes from detail atomically as it writes to rollup), so
    // their per-day sums are always over disjoint row sets and can be summed
    // without double-counting. This is robust to partial archival batches,
    // backlog catch-up, and edge cases where a single day has rows in both
    // tables simultaneously.
    const dayMap = new Map<string, { totalUsd: number; callCount: number }>();
    for (const row of dayRows) {
      dayMap.set(row.day, { totalUsd: row.total_usd, callCount: row.call_count });
    }
    for (const row of rollupDay) {
      const existing = dayMap.get(row.day);
      if (existing) {
        existing.totalUsd += row.total_usd;
        existing.callCount += row.call_count;
      } else {
        dayMap.set(row.day, { totalUsd: row.total_usd, callCount: row.call_count });
      }
    }
    const byDay = Array.from(dayMap.entries())
      .map(([day, v]) => ({ day, totalUsd: v.totalUsd, callCount: v.callCount }))
      .sort((a, b) => b.day.localeCompare(a.day));

    // Build combined byBusiness aggregate (detail + rollup), THEN sort and paginate.
    // This ensures businesses with only archived activity still appear, and ordering
    // reflects combined totals — not detail-only totals.
    // today_usd stays detail-only (today is always within the last 90d).
    type BusinessAgg = { total_usd: number; call_count: number; today_usd: number };
    const combinedBusiness = new Map<string, BusinessAgg>();
    for (const row of detailBusinessRows) {
      combinedBusiness.set(row.business_id, {
        total_usd: row.total_usd,
        call_count: row.call_count,
        today_usd: row.today_usd,
      });
    }
    for (const [bizId, rollup] of rollupBusinessTotals) {
      const existing = combinedBusiness.get(bizId);
      if (existing) {
        existing.total_usd += rollup.total_usd;
        existing.call_count += rollup.call_count;
      } else {
        combinedBusiness.set(bizId, {
          total_usd: rollup.total_usd,
          call_count: rollup.call_count,
          today_usd: 0,
        });
      }
    }

    // Sort by combined total_usd DESC, then paginate.
    const sortedBusinessIds = Array.from(combinedBusiness.entries())
      .sort((a, b) => b[1].total_usd - a[1].total_usd)
      .map(([id]) => id);
    const totalBusinesses = sortedBusinessIds.length;
    const pageBusinessIds = sortedBusinessIds.slice(offset, offset + limit);

    // Fetch names + tiers for just the paginated page.
    const pageBusinesses = pageBusinessIds.length > 0
      ? await sql<{ id: string; name: string; subscription_tier: string }[]>`
          SELECT id, name, subscription_tier
          FROM businesses
          WHERE id IN ${sql(pageBusinessIds)}
        `
      : [];
    const bizInfoMap = new Map(pageBusinesses.map((b) => [b.id, b]));

    // Build byBusiness preserving the paginated order.
    const byBusiness = pageBusinessIds
      .map((bizId) => {
        const info = bizInfoMap.get(bizId);
        if (!info) return null; // Business row missing (deleted mid-query) — skip.
        const agg = combinedBusiness.get(bizId);
        if (!agg) return null;
        const limitCents = tierLimitCents(info.subscription_tier);
        const limitUsd = limitCents / 100;
        const pctOfDailyLimit = Math.round((agg.today_usd / limitUsd) * 100);
        return {
          businessId: bizId,
          businessName: info.name,
          subscriptionTier: info.subscription_tier,
          totalUsd: agg.total_usd,
          callCount: agg.call_count,
          todayUsd: agg.today_usd,
          dailyLimitUsd: limitUsd,
          pctOfDailyLimit,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const data: CostData = {
      days,
      totalBusinesses,
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
