// src/lib/admin/margin-service.ts
//
// Aggregate-on-read API/LLM cost + gross-margin-risk signals for admin (Spec 26).
// Per-account variable API COGS (api_costs, trailing 30d) vs per-account MRR
// (mirrors currentBillingSnapshot). No migration, no rollup table. Admin-only:
// queries are cross-account aggregates (no per-tenant filter) — allowlisted in
// the tenant-scope audit.

import { sql } from '@/lib/db/server';
import { computeOverageQuantity } from '@/lib/accounts/quota';
import { TIER_CONFIG, isSubscriptionTier } from '@/lib/accounts/tier-config';

export const MARGIN_WINDOW_DAYS = 30;
export const ACCOUNT_WARNING_PCT = 25;
export const ACCOUNT_ACTION_PCT = 40;
// Platform gross margin: LOWER is worse (inverse of the account cost thresholds).
export const PLATFORM_ACTION_PCT = 60;
export const PLATFORM_WARNING_PCT = 70;

export type MarginRiskLevel = 'none' | 'warning' | 'action';

export interface AccountMarginRow {
  accountId: string;
  displayName: string;
  subscriptionTier: string;
  subscriptionStatus: string;
  mrrUsd: number;
  /** Total variable API COGS (all providers, trailing window), USD. */
  variableApiCostUsd: number;
  costPctOfMrr: number | null;
  riskLevel: MarginRiskLevel;
  responseCount: number;
  avgCostPerResponseUsd: number | null;
  openaiCount: number;
  anthropicCount: number;
  fallbackRatePct: number | null;
  flaggedCount: number;
  flaggedRatePct: number | null;
}

export interface PlatformMargin {
  totalRevenueUsd: number;
  variableApiCogsUsd: number;
  grossMarginPct: number | null;
  riskLevel: MarginRiskLevel;
  note: string;
}

export interface MarginData {
  windowDays: number;
  platform: PlatformMargin;
  topAccountsByCost: AccountMarginRow[];
  thresholds: {
    accountWarningPct: number;
    accountActionPct: number;
    platformWarningPct: number;
    platformActionPct: number;
  };
}

// TODO: baseCents reads live TIER_CONFIG (not grandfathered), same gap as
// currentBillingSnapshot in quota.ts — if base prices change, update both.
/** Monthly recurring revenue in cents. Mirrors currentBillingSnapshot's formula. */
export function monthlyMrrCents(input: {
  tier: string;
  includedLocations: number;
  overagePriceCents: number;
  activeLocations: number;
}): number {
  if (!isSubscriptionTier(input.tier)) return 0;
  const config = TIER_CONFIG[input.tier];
  if (!config.multiLocAllowed || config.overageCents === 0) {
    return config.baseCents;
  }
  const overageUnits = computeOverageQuantity(
    input.activeLocations,
    input.includedLocations,
  );
  return config.baseCents + overageUnits * input.overagePriceCents;
}

export function classifyAccountRisk(costPctOfMrr: number | null): MarginRiskLevel {
  if (costPctOfMrr == null) return 'none';
  if (costPctOfMrr >= ACCOUNT_ACTION_PCT) return 'action';
  if (costPctOfMrr >= ACCOUNT_WARNING_PCT) return 'warning';
  return 'none';
}

export function classifyPlatformRisk(grossMarginPct: number | null): MarginRiskLevel {
  if (grossMarginPct == null) return 'none';
  if (grossMarginPct < PLATFORM_ACTION_PCT) return 'action';
  if (grossMarginPct < PLATFORM_WARNING_PCT) return 'warning';
  return 'none';
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

interface AccountRow {
  id: string;
  display_name: string;
  subscription_tier: string;
  subscription_status: string;
  locations_included: number;
  locations_overage_price_cents: number;
  active_locations: number;
}
interface CostAggRow {
  account_id: string;
  api_cost_usd: number;
  generation_count: number;
  openai_count: number;
  anthropic_count: number;
  generation_cost_usd: number;
  flagged_count: number;
}

export async function getMarginReport(
  opts: { limit?: number } = {},
): Promise<MarginData> {
  const limit = opts.limit ?? 20;

  const [accountRows, costRows, platformRows] = await Promise.all([
    sql<AccountRow[]>`
      SELECT a.id, a.display_name, a.subscription_tier, a.subscription_status,
             a.locations_included, a.locations_overage_price_cents,
             COUNT(b.id) FILTER (WHERE b.archived_at IS NULL)::int AS active_locations
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id
      WHERE a.subscription_status IN ('active', 'past_due')
      GROUP BY a.id
    `,
    sql<CostAggRow[]>`
      SELECT account_id,
             SUM(cost_usd)::float AS api_cost_usd,
             COUNT(*) FILTER (WHERE provider IN ('openai', 'anthropic'))::int AS generation_count,
             COUNT(*) FILTER (WHERE provider = 'openai')::int AS openai_count,
             COUNT(*) FILTER (WHERE provider = 'anthropic')::int AS anthropic_count,
             COALESCE(SUM(cost_usd) FILTER (WHERE provider IN ('openai', 'anthropic')), 0)::float AS generation_cost_usd,
             COUNT(*) FILTER (WHERE provider IN ('openai', 'anthropic') AND flagged)::int AS flagged_count
      FROM api_costs
      WHERE account_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY account_id
    `,
    sql<{ total_cost_usd: number | null }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::float AS total_cost_usd
      FROM api_costs
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `,
  ]);

  const costByAccount = new Map<string, CostAggRow>();
  for (const row of costRows) costByAccount.set(row.account_id, row);

  let totalRevenueUsd = 0;
  const rows: AccountMarginRow[] = [];

  for (const acct of accountRows) {
    const mrrCents = monthlyMrrCents({
      tier: acct.subscription_tier,
      includedLocations: acct.locations_included,
      overagePriceCents: acct.locations_overage_price_cents,
      activeLocations: acct.active_locations,
    });
    const mrrUsd = mrrCents / 100;
    totalRevenueUsd += mrrUsd;

    const cost = costByAccount.get(acct.id);
    const variableApiCostUsd = round(cost?.api_cost_usd ?? 0, 6);
    const responseCount = cost?.generation_count ?? 0;
    const openaiCount = cost?.openai_count ?? 0;
    const anthropicCount = cost?.anthropic_count ?? 0;
    const flaggedCount = cost?.flagged_count ?? 0;
    const generationCostUsd = cost?.generation_cost_usd ?? 0;

    const costPctOfMrr = mrrUsd > 0 ? round((variableApiCostUsd / mrrUsd) * 100, 1) : null;
    const fallbackRatePct =
      responseCount > 0 ? round((anthropicCount / responseCount) * 100, 1) : null;
    const flaggedRatePct =
      responseCount > 0 ? round((flaggedCount / responseCount) * 100, 1) : null;
    const avgCostPerResponseUsd =
      responseCount > 0 ? round(generationCostUsd / responseCount, 6) : null;

    rows.push({
      accountId: acct.id,
      displayName: acct.display_name,
      subscriptionTier: acct.subscription_tier,
      subscriptionStatus: acct.subscription_status,
      mrrUsd: round(mrrUsd, 2),
      variableApiCostUsd,
      costPctOfMrr,
      riskLevel: classifyAccountRisk(costPctOfMrr),
      responseCount,
      avgCostPerResponseUsd,
      openaiCount,
      anthropicCount,
      fallbackRatePct,
      flaggedCount,
      flaggedRatePct,
    });
  }

  // Fetches all active/past_due accounts then sorts in-process. Fine at launch
  // scale; push sort+limit into SQL if account count grows past ~1k.
  rows.sort((a, b) => b.variableApiCostUsd - a.variableApiCostUsd);

  const variableApiCogsUsd = round(platformRows[0]?.total_cost_usd ?? 0, 6);
  totalRevenueUsd = round(totalRevenueUsd, 2);
  const grossMarginPct =
    totalRevenueUsd > 0
      ? round(((totalRevenueUsd - variableApiCogsUsd) / totalRevenueUsd) * 100, 1)
      : null;

  return {
    windowDays: MARGIN_WINDOW_DAYS,
    platform: {
      totalRevenueUsd,
      variableApiCogsUsd,
      grossMarginPct,
      riskLevel: classifyPlatformRisk(grossMarginPct),
      note: 'API/LLM COGS only (api_costs). Excludes vendor bills (Supabase, Railway, Vercel, etc.) — see docs/finance/monthly-close.md.',
    },
    topAccountsByCost: rows.slice(0, limit),
    thresholds: {
      accountWarningPct: ACCOUNT_WARNING_PCT,
      accountActionPct: ACCOUNT_ACTION_PCT,
      platformWarningPct: PLATFORM_WARNING_PCT,
      platformActionPct: PLATFORM_ACTION_PCT,
    },
  };
}
