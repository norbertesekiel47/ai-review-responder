import { sql } from '@/lib/db/server';
import { asAccountId } from '@/lib/shared/ids';
import type { AccountId } from '@/lib/shared/ids';

// ── Types ─────────────────────────────────────────────────────────────

export interface ProviderRow {
  provider: string;
  total_usd: number;
  call_count: number;
}

export interface DayRow {
  day: string;
  total_usd: number;
  call_count: number;
}

export interface TodayTotalRow {
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

export interface CostQuery {
  days: number;
  limit: number;
  offset: number;
  accountId: AccountId | '';
}

// ── Module-level helpers ──────────────────────────────────────────────

// Strict non-negative integer parse — mirrors `safeParseLimitCents` in
// src/lib/costs/tracker.ts. parseInt is too permissive (accepts prefixes,
// truncates decimals, stops at underscores), so a value like "1000abc" or
// "10_000" or "12.5" would silently apply the WRONG budget math on the
// admin dashboard. Require digits-only, validate as a safe integer, else
// fall back to default.
export function safeLimit(envVal: string | undefined, fallback: number): number {
  if (envVal === undefined || envVal === null) return fallback;
  const trimmed = envVal.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const TIER_LIMITS_CENTS: Record<string, number> = {
  founders: safeLimit(process.env.DAILY_COST_LIMIT_CENTS_FOUNDING, 500),
  founding: safeLimit(process.env.DAILY_COST_LIMIT_CENTS_FOUNDING, 500), // legacy alias
  standard: safeLimit(process.env.DAILY_COST_LIMIT_CENTS_STANDARD, 1000),
  premium: safeLimit(process.env.DAILY_COST_LIMIT_CENTS_PREMIUM, 2000),
};

const GLOBAL_DAILY_LIMIT_CENTS = safeLimit(
  process.env.GLOBAL_DAILY_COST_LIMIT_CENTS,
  10_000,
);

export function tierLimitCents(tier: string): number {
  return TIER_LIMITS_CENTS[tier] ?? TIER_LIMITS_CENTS['standard'] ?? 1000;
}

// ── parseCostQuery ────────────────────────────────────────────────────

export function parseCostQuery(params: URLSearchParams): CostQuery | { error: string } {
  const rawDays = params.get('days');
  const rawParsed = parseInt(rawDays ?? '7', 10);
  // Fall back to 7 only when parse FAILS (NaN). Preserve 0 / negatives so the
  // clamp below can correctly bring them to 1 instead of silently defaulting.
  const parsedDays = Number.isNaN(rawParsed) ? 7 : rawParsed;
  if (parsedDays > 365) {
    return { error: 'days parameter must be 365 or less' };
  }
  const days = Math.min(Math.max(parsedDays, 1), 365);

  // Parse limit/offset: NaN → default, negatives → clamp (not silently pass through).
  // parseInt('-5') returns -5 which is truthy; `|| 20` wouldn't fire, so a naïve
  // Math.min(-5, 100) would produce LIMIT -5 and crash the query.
  const rawLimit = params.get('limit');
  const parsedLimit = parseInt(rawLimit ?? '20', 10);
  const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);

  const rawOffset = params.get('offset');
  const parsedOffset = parseInt(rawOffset ?? '0', 10);
  const offset = Number.isNaN(parsedOffset) ? 0 : Math.max(parsedOffset, 0);

  // VAL-ADMIN-002: Optional account_id filter enables idx_api_costs_account
  // index for account-level cost aggregation without a JOIN to businesses.
  const rawAccountId = params.get('account_id') ?? '';
  const accountId: AccountId | '' = rawAccountId ? asAccountId(rawAccountId) : '';

  return { days, limit, offset, accountId };
}

// ── getCostReport ─────────────────────────────────────────────────────

export async function getCostReport(q: CostQuery): Promise<CostData> {
  const { days, limit, offset, accountId } = q;
  const needsRollup = days > 90;

  // Detail queries always run — cover the most recent up-to-90 days.
  // byBusiness is now fully server-side: UNION of detail + rollup inside a
  // CTE, aggregated by business_id, sorted and paginated in SQL. This avoids
  // loading all business aggregates into Node at larger scale.
  //
  // call_count is returned as ::float (not ::int) to preserve full precision
  // for aggregated BIGINT values. Postgres INTEGER tops out at 2.1B; at
  // platform scale cumulative call counts could cross that. JS numbers
  // safely represent integers up to 2^53 so ::float handles realistic totals.
  const [providerRows, byBusinessRows, businessCountRows, dayRows, todayRows] = await Promise.all([
    // byProvider: When account_id is provided, filter api_costs directly
    // by account_id (uses idx_api_costs_account) instead of scanning all rows.
    accountId
      ? sql<ProviderRow[]>`
          SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count
          FROM api_costs
          WHERE account_id = ${accountId}::uuid
            AND created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
          GROUP BY provider
          ORDER BY total_usd DESC
        `
      : sql<ProviderRow[]>`
          SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count
          FROM api_costs
          WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
          GROUP BY provider
          ORDER BY total_usd DESC
        `,
    // byBusiness: server-side aggregation + pagination.
    // When accountId is provided, filter by account_id directly on api_costs
    // (VAL-ADMIN-002), enabling idx_api_costs_account index scan.
    // When needsRollup: UNION detail + rollup, sum per business, sort, paginate.
    // When not: direct aggregate from api_costs only.
    //
    // Boundary semantics: ArchivalPoller archives rows with
    // `created_at < NOW() - INTERVAL '90 days'`. On any archival-run day,
    // the boundary day (CURRENT_DATE - 90 days) is SPLIT: morning hours go
    // into the rollup row for that date, remaining hours stay in api_costs.
    // The rollup-side filter must be `rollup_date <= CURRENT_DATE - 90`
    // (inclusive), or that boundary day's archived portion becomes
    // invisible. Detail and rollup rows are row-disjoint, so no double-count.
    needsRollup && accountId
      ? sql<{
          business_id: string;
          name: string;
          subscription_tier: string;
          total_usd: number;
          call_count: number;
          today_usd: number;
        }[]>`
          WITH combined AS (
            SELECT business_id,
                   SUM(cost_usd)::float AS total_usd,
                   COUNT(*)::float AS call_count,
                   SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd
            FROM api_costs
            WHERE account_id = ${accountId}::uuid
              AND created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND business_id IS NOT NULL
            GROUP BY business_id
            UNION ALL
            SELECT business_id,
                   SUM(total_cost_usd)::float AS total_usd,
                   SUM(call_count)::float AS call_count,
                   0::float AS today_usd
            FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
              AND business_id IS NOT NULL
              AND business_id IN (SELECT id FROM businesses WHERE account_id = ${accountId}::uuid)
            GROUP BY business_id
          ),
          business_totals AS (
            SELECT business_id,
                   SUM(total_usd)::float AS total_usd,
                   SUM(call_count)::float AS call_count,
                   SUM(today_usd)::float AS today_usd
            FROM combined
            GROUP BY business_id
          )
          SELECT bt.business_id, b.name, a.subscription_tier,
                 bt.total_usd, bt.call_count, bt.today_usd
          FROM business_totals bt
          JOIN businesses b ON b.id = bt.business_id
          JOIN accounts a ON a.id = b.account_id
          ORDER BY bt.total_usd DESC, bt.business_id ASC
          LIMIT ${limit} OFFSET ${offset}
        `
      : needsRollup
      ? sql<{
          business_id: string;
          name: string;
          subscription_tier: string;
          total_usd: number;
          call_count: number;
          today_usd: number;
        }[]>`
          WITH combined AS (
            SELECT business_id,
                   SUM(cost_usd)::float AS total_usd,
                   COUNT(*)::float AS call_count,
                   SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd
            FROM api_costs
            WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND business_id IS NOT NULL
            GROUP BY business_id
            UNION ALL
            SELECT business_id,
                   SUM(total_cost_usd)::float AS total_usd,
                   SUM(call_count)::float AS call_count,
                   0::float AS today_usd
            FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
              AND business_id IS NOT NULL
            GROUP BY business_id
          ),
          business_totals AS (
            SELECT business_id,
                   SUM(total_usd)::float AS total_usd,
                   SUM(call_count)::float AS call_count,
                   SUM(today_usd)::float AS today_usd
            FROM combined
            GROUP BY business_id
          )
          SELECT bt.business_id, b.name, a.subscription_tier,
                 bt.total_usd, bt.call_count, bt.today_usd
          FROM business_totals bt
          JOIN businesses b ON b.id = bt.business_id
          JOIN accounts a ON a.id = b.account_id
          ORDER BY bt.total_usd DESC, bt.business_id ASC
          LIMIT ${limit} OFFSET ${offset}
        `
      : accountId
      ? sql<{
          business_id: string;
          name: string;
          subscription_tier: string;
          total_usd: number;
          call_count: number;
          today_usd: number;
        }[]>`
          SELECT ac.business_id, b.name, a.subscription_tier,
                 SUM(ac.cost_usd)::float AS total_usd,
                 COUNT(ac.id)::float AS call_count,
                 SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd
          FROM api_costs ac
          JOIN businesses b ON b.id = ac.business_id
          JOIN accounts a ON a.id = b.account_id
          WHERE ac.account_id = ${accountId}::uuid
            AND ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
          GROUP BY ac.business_id, b.name, a.subscription_tier
          ORDER BY total_usd DESC, ac.business_id ASC
          LIMIT ${limit} OFFSET ${offset}
        `
      : sql<{
          business_id: string;
          name: string;
          subscription_tier: string;
          total_usd: number;
          call_count: number;
          today_usd: number;
        }[]>`
          SELECT ac.business_id, b.name, a.subscription_tier,
                 SUM(ac.cost_usd)::float AS total_usd,
                 COUNT(ac.id)::float AS call_count,
                 SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd
          FROM api_costs ac
          JOIN businesses b ON b.id = ac.business_id
          JOIN accounts a ON a.id = b.account_id
          WHERE ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
          GROUP BY ac.business_id, b.name, a.subscription_tier
          ORDER BY total_usd DESC, ac.business_id ASC
          LIMIT ${limit} OFFSET ${offset}
        `,
    // Total business count for pagination metadata: counts DISTINCT
    // business_ids across detail ∪ rollup when rollup is active.
    // When accountId is provided, filter by account_id directly.
    needsRollup && accountId
      ? sql<{ total: number }[]>`
          WITH combined AS (
            SELECT business_id FROM api_costs
            WHERE account_id = ${accountId}::uuid
              AND created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND business_id IS NOT NULL
            GROUP BY business_id
            UNION
            SELECT business_id FROM api_costs_daily_rollups
            WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ${accountId}::uuid)
              AND rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
              AND business_id IS NOT NULL
            GROUP BY business_id
          )
          SELECT COUNT(*)::int AS total FROM combined
        `
      : needsRollup
      ? sql<{ total: number }[]>`
          WITH combined AS (
            SELECT business_id FROM api_costs
            WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND business_id IS NOT NULL
            GROUP BY business_id
            UNION
            SELECT business_id FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
              AND business_id IS NOT NULL
            GROUP BY business_id
          )
          SELECT COUNT(*)::int AS total FROM combined
        `
      : accountId
      ? sql<{ total: number }[]>`
          SELECT COUNT(DISTINCT business_id)::int AS total
          FROM api_costs
          WHERE account_id = ${accountId}::uuid
            AND created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
            AND business_id IS NOT NULL
        `
      : sql<{ total: number }[]>`
          SELECT COUNT(DISTINCT business_id)::int AS total
          FROM api_costs
          WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
            AND business_id IS NOT NULL
        `,
    // byDay: When accountId is provided, filter by account_id directly
    // (VAL-ADMIN-002, uses idx_api_costs_account for date-range scan).
    accountId
      ? sql<DayRow[]>`
          SELECT
            DATE(created_at)::text AS day,
            SUM(cost_usd)::float AS total_usd,
            COUNT(*)::float AS call_count
          FROM api_costs
          WHERE account_id = ${accountId}::uuid
            AND created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
          GROUP BY DATE(created_at)
          ORDER BY day DESC
        `
      : sql<DayRow[]>`
          SELECT
            DATE(created_at)::text AS day,
            SUM(cost_usd)::float AS total_usd,
            COUNT(*)::float AS call_count
          FROM api_costs
          WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
          GROUP BY DATE(created_at)
          ORDER BY day DESC
        `,
    // todayTotal: Same account_id filter pattern.
    accountId
      ? sql<TodayTotalRow[]>`
          SELECT COALESCE(SUM(cost_usd), 0)::float AS total
          FROM api_costs
          WHERE account_id = ${accountId}::uuid
            AND created_at >= CURRENT_DATE
        `
      : sql<TodayTotalRow[]>`
          SELECT COALESCE(SUM(cost_usd), 0)::float AS total
          FROM api_costs
          WHERE created_at >= CURRENT_DATE
        `,
  ]);

  // Rollup queries for byProvider and byDay only when range extends beyond 90 days.
  // byBusiness rollup is already handled server-side in the byBusinessRows query above.
  let rollupProvider: ProviderRow[] = [];
  let rollupDay: DayRow[] = [];

  if (needsRollup) {
    const [provRes, dayRes] = await Promise.all([
      accountId
        ? sql<ProviderRow[]>`
            SELECT provider, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count
            FROM api_costs_daily_rollups
            WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ${accountId}::uuid)
              AND rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY provider
          `
        : sql<ProviderRow[]>`
            SELECT provider, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count
            FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY provider
          `,
      accountId
        ? sql<DayRow[]>`
            SELECT rollup_date::text AS day, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count
            FROM api_costs_daily_rollups
            WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ${accountId}::uuid)
              AND rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY rollup_date
          `
        : sql<DayRow[]>`
            SELECT rollup_date::text AS day, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count
            FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY rollup_date
          `,
    ]);
    rollupProvider = provRes;
    rollupDay = dayRes;
  }

  // Merge byProvider: sum detail + rollup by provider key.
  // Provider count is bounded (~5), so app-side merge is fine.
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
  // without double-counting. Day count is bounded (~365), so app-side merge is fine.
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

  // byBusiness is already sorted and paginated by SQL above.
  // Compute pctOfDailyLimit and map to API shape.
  const totalBusinesses = businessCountRows[0]?.total ?? 0;
  const byBusiness = byBusinessRows.map((row) => {
    const limitCents = tierLimitCents(row.subscription_tier);
    const limitUsd = limitCents / 100;
    const pctOfDailyLimit = Math.round((row.today_usd / limitUsd) * 100);
    return {
      businessId: row.business_id,
      businessName: row.name,
      subscriptionTier: row.subscription_tier,
      totalUsd: row.total_usd,
      callCount: row.call_count,
      todayUsd: row.today_usd,
      dailyLimitUsd: limitUsd,
      pctOfDailyLimit,
    };
  });

  return {
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
}
