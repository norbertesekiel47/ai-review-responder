// src/lib/admin/margin-service.ts
//
// Aggregate-on-read API/LLM cost + gross-margin-risk signals for admin (Spec 26).
// Per-account variable API COGS (api_costs, trailing 30d) vs per-account MRR
// (mirrors currentBillingSnapshot). No migration, no rollup table. Admin-only:
// queries are cross-account aggregates (no per-tenant filter) — allowlisted in
// the tenant-scope audit.

import type { Sql } from 'postgres';
import { computeOverageQuantity } from '@/lib/accounts/quota';
import { isSubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

// Module-local thresholds. Surfaced to callers via MarginData.thresholds (see
// getMarginReport), so no standalone exports are needed — keeps the public
// surface to the report API and avoids unused-export drift.
const MARGIN_WINDOW_DAYS = 30;
const ACCOUNT_WARNING_PCT = 25;
const ACCOUNT_ACTION_PCT = 40;
// Platform gross margin: LOWER is worse (inverse of the account cost thresholds).
const PLATFORM_ACTION_PCT = 60;
const PLATFORM_WARNING_PCT = 70;

export type MarginRiskLevel = 'none' | 'warning' | 'action';

export interface AccountMarginRow {
  accountId: string;
  displayName: string;
  subscriptionTier: SubscriptionTierValue;
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

/** Monthly recurring revenue in cents. Mirrors currentBillingSnapshot's formula. */
export function monthlyMrrCents(input: {
  tier: SubscriptionTierValue;
  basePriceCents: number;
  includedLocations: number;
  overagePriceCents: number;
  activeLocations: number;
}): number {
  if (!isSubscriptionTier(input.tier)) {
    throw new Error(`invalid_ws8_subscription_tier:${String(input.tier)}`);
  }
  const overageUnits = computeOverageQuantity(
    input.activeLocations,
    input.includedLocations,
  );
  return input.basePriceCents + overageUnits * input.overagePriceCents;
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
  base_price_cents: number;
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
  sql: Sql,
  opts: { limit?: number } = {},
): Promise<MarginData> {
  const limit = opts.limit ?? 20;

  // SEQUENCED, NOT `Promise.all` — at most ONE query in flight (#773).
  //
  // The previous comment here reasoned that a fan-out of 3 against
  // `DB_POOL_MAX` = 3 was safe because #505 proved one-connection-per-query
  // non-wedging. Staging measurement on 2026-08-13 DISPROVED that as a
  // sufficient condition: `/api/admin/flagged` wedged with a fan-out of only
  // TWO against the same 3-connection pool, because the pool is per Fluid
  // Compute ISOLATE and is shared across overlapping requests. Fan-out ≤ pool
  // says nothing once two requests land on one isolate. Evidence: branch
  // codex/773-vercel-capacity-decision,
  // docs/runbooks/evidence/2026-08-13-773-vercel-capacity-decision.md.
  //
  // The three reads are independent, so sequencing changes no result. It trades
  // latency (sum instead of max) on an admin-only page for the wedge removal.
  // Keeping the callers' sequential await of this function is still correct.
  const accountRows = await sql<AccountRow[]>`
      SELECT a.id, a.display_name, a.subscription_tier, a.subscription_status,
             a.locations_included, a.locations_overage_price_cents, a.base_price_cents,
             COUNT(b.id) FILTER (WHERE b.archived_at IS NULL)::int AS active_locations
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id
      WHERE a.subscription_status IN ('active', 'past_due', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .PAST_DUE / .TRIALING (trialing = distinct $0-revenue cohort)
      GROUP BY a.id
    `;
  const costRows = await sql<CostAggRow[]>`
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
    `;
  const platformRows = await sql<{ total_cost_usd: number | null }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::float AS total_cost_usd
      FROM api_costs
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `;

  const costByAccount = new Map<string, CostAggRow>();
  for (const row of costRows) costByAccount.set(row.account_id, row);

  let totalRevenueUsd = 0;
  const rows: AccountMarginRow[] = [];

  for (const acct of accountRows) {
    if (!isSubscriptionTier(acct.subscription_tier)) {
      throw new Error(`invalid_ws8_subscription_tier:${acct.subscription_tier}`);
    }
    // Trialing accounts are a DISTINCT $0-revenue cohort (PLAN.md §6.16): they
    // are charged nothing yet, so they must contribute $0 to platform revenue
    // and gross margin — but their api_costs DO count (their cost risk is the
    // whole point of showing them). Blending their plan price into revenue would
    // inflate totalRevenueUsd/grossMarginPct and hide trial cost exposure.
    const isTrialing = acct.subscription_status === SubscriptionStatus.TRIALING;
    const mrrCents = isTrialing
      ? 0
      : monthlyMrrCents({
          tier: acct.subscription_tier,
          basePriceCents: acct.base_price_cents,
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
