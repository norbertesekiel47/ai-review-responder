import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
import {
  getMarginReport,
  monthlyMrrCents,
  classifyAccountRisk,
  classifyPlatformRisk,
} from '../margin-service';

// margin-service no longer imports the @/lib/db/server singleton — sql is an
// explicit parameter (A+ campaign 2b, T4) — so tests hand the shared mock
// client directly to getMarginReport instead of vi.mock'ing a module import.
const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = createMockSql();
const sql = mockSql as unknown as Sql;

beforeEach(() => {
  resetMockSql();
});

describe('monthlyMrrCents (mirrors currentBillingSnapshot)', () => {
  it('standard tier base only when at included count', () => {
    expect(monthlyMrrCents({ tier: 'standard', basePriceCents: 7900, includedLocations: 1, overagePriceCents: 2500, activeLocations: 1 })).toBe(7900);
  });
  it('standard tier adds overage per extra active location', () => {
    expect(monthlyMrrCents({ tier: 'standard', basePriceCents: 7900, includedLocations: 1, overagePriceCents: 2500, activeLocations: 3 })).toBe(7900 + 2 * 2500);
  });
  it('basic tier never adds overage', () => {
    expect(monthlyMrrCents({ tier: 'basic', basePriceCents: 2900, includedLocations: 1, overagePriceCents: 0, activeLocations: 5 })).toBe(2900);
  });
  it('premium tier includes 5 before overage', () => {
    expect(monthlyMrrCents({ tier: 'premium', basePriceCents: 19900, includedLocations: 5, overagePriceCents: 2000, activeLocations: 6 })).toBe(19900 + 2000);
  });
  it('unknown tier → 0 (excluded from margin)', () => {
    expect(monthlyMrrCents({ tier: 'mystery', basePriceCents: 7900, includedLocations: 1, overagePriceCents: 0, activeLocations: 1 })).toBe(0);
  });
  it('reads stored basePriceCents, not live tier config (founders price-lock)', () => {
    // founders stored base 1500 differs from TIER_CONFIG.founders.baseCents (1900)
    expect(monthlyMrrCents({ tier: 'founders', basePriceCents: 1500, includedLocations: 1, overagePriceCents: 2500, activeLocations: 3 })).toBe(1500 + 2 * 2500);
  });
});

describe('risk classifiers', () => {
  it('account risk: >=40 action, >=25 warning, else none, null→none', () => {
    expect(classifyAccountRisk(45)).toBe('action');
    expect(classifyAccountRisk(30)).toBe('warning');
    expect(classifyAccountRisk(10)).toBe('none');
    expect(classifyAccountRisk(null)).toBe('none');
  });
  it('platform risk: <60 action, <70 warning, else none, null→none', () => {
    expect(classifyPlatformRisk(55)).toBe('action');
    expect(classifyPlatformRisk(65)).toBe('warning');
    expect(classifyPlatformRisk(80)).toBe('none');
    expect(classifyPlatformRisk(null)).toBe('none');
  });
  it('account risk boundaries are inclusive at 25 and 40', () => {
    expect(classifyAccountRisk(25)).toBe('warning');
    expect(classifyAccountRisk(40)).toBe('action');
    expect(classifyAccountRisk(24.9)).toBe('none');
    expect(classifyAccountRisk(39.9)).toBe('warning');
  });
  it('platform risk boundaries: 70 is none, 69.9 warning, 60 warning, 59.9 action', () => {
    expect(classifyPlatformRisk(70)).toBe('none');
    expect(classifyPlatformRisk(69.9)).toBe('warning');
    expect(classifyPlatformRisk(60)).toBe('warning');
    expect(classifyPlatformRisk(59.9)).toBe('action');
  });
});

describe('getMarginReport', () => {
  function seed() {
    sqlReturnQueue.push([
      { id: 'acct-1', display_name: 'Acme', subscription_tier: 'standard', subscription_status: 'active', locations_included: 1, locations_overage_price_cents: 2500, base_price_cents: 7900, active_locations: 1 },
      { id: 'acct-2', display_name: 'Beta', subscription_tier: 'premium', subscription_status: 'active', locations_included: 5, locations_overage_price_cents: 2000, base_price_cents: 19900, active_locations: 5 },
    ]);
    sqlReturnQueue.push([
      { account_id: 'acct-1', api_cost_usd: 39.5, generation_count: 100, openai_count: 90, anthropic_count: 10, generation_cost_usd: 38, flagged_count: 2 },
      { account_id: 'acct-2', api_cost_usd: 1.0, generation_count: 20, openai_count: 20, anthropic_count: 0, generation_cost_usd: 1, flagged_count: 0 },
    ]);
    sqlReturnQueue.push([{ total_cost_usd: 40.5 }]);
  }

  it('computes per-account margin rows sorted by cost desc with risk levels', async () => {
    seed();
    const data = await getMarginReport(sql, { limit: 10 });
    expect(data.windowDays).toBe(30);
    const acme = data.topAccountsByCost[0]!;
    expect(acme.accountId).toBe('acct-1');
    expect(acme.mrrUsd).toBe(79);
    expect(acme.variableApiCostUsd).toBe(39.5);
    expect(acme.costPctOfMrr).toBe(50);
    expect(acme.riskLevel).toBe('action');
    expect(acme.fallbackRatePct).toBe(10);
    expect(acme.flaggedRatePct).toBe(2);
    expect(acme.avgCostPerResponseUsd).toBeCloseTo(0.38, 5);
  });

  it('scopes flagged_count to the generation providers (same population as generation_count)', async () => {
    seed();
    await getMarginReport(sql, { limit: 10 });
    // The per-account cost-aggregate query (index 1) must count flags only over
    // openai/anthropic rows so flaggedRatePct shares responseCount's population.
    expect(sqlCalls[1]!.text).toContain(
      "FILTER (WHERE provider IN ('openai', 'anthropic') AND flagged)",
    );
  });

  it('computes platform gross margin and risk', async () => {
    seed();
    const data = await getMarginReport(sql, { limit: 10 });
    expect(data.platform.totalRevenueUsd).toBe(278);
    expect(data.platform.variableApiCogsUsd).toBe(40.5);
    expect(data.platform.grossMarginPct).toBeCloseTo(85.4, 1);
    expect(data.platform.riskLevel).toBe('none');
  });

  it('treats trialing accounts as a $0-revenue cohort: their cost shows but contributes $0 to revenue/margin', async () => {
    // A trialing account on a standard plan ($79) with real LLM cost. It must NOT
    // add $79 to totalRevenueUsd (it is charged $0 during the trial), and its
    // costPctOfMrr must be null (no revenue to compare against) — but its cost
    // still appears in the row and in platform COGS.
    sqlReturnQueue.push([
      { id: 'acct-paid', display_name: 'Paid', subscription_tier: 'standard', subscription_status: 'active', locations_included: 1, locations_overage_price_cents: 2500, base_price_cents: 7900, active_locations: 1 },
      { id: 'acct-trial', display_name: 'Trial', subscription_tier: 'standard', subscription_status: 'trialing', locations_included: 1, locations_overage_price_cents: 2500, base_price_cents: 7900, active_locations: 1 },
    ]);
    sqlReturnQueue.push([
      { account_id: 'acct-paid', api_cost_usd: 10, generation_count: 50, openai_count: 50, anthropic_count: 0, generation_cost_usd: 10, flagged_count: 0 },
      { account_id: 'acct-trial', api_cost_usd: 8, generation_count: 40, openai_count: 40, anthropic_count: 0, generation_cost_usd: 8, flagged_count: 0 },
    ]);
    sqlReturnQueue.push([{ total_cost_usd: 18 }]);

    const data = await getMarginReport(sql, { limit: 10 });

    // Only the paid account's $79 counts toward revenue.
    expect(data.platform.totalRevenueUsd).toBe(79);

    const trialRow = data.topAccountsByCost.find((r) => r.accountId === 'acct-trial')!;
    expect(trialRow.subscriptionStatus).toBe('trialing');
    expect(trialRow.mrrUsd).toBe(0);
    expect(trialRow.costPctOfMrr).toBeNull();
    expect(trialRow.riskLevel).toBe('none');
    // Trial cost is still visible (the point of showing the cohort).
    expect(trialRow.variableApiCostUsd).toBe(8);
    // Platform COGS includes the trial's cost.
    expect(data.platform.variableApiCogsUsd).toBe(18);
  });

  it('handles an account with cost but zero MRR (costPct null, risk none)', async () => {
    sqlReturnQueue.push([
      { id: 'acct-x', display_name: 'X', subscription_tier: 'mystery', subscription_status: 'active', locations_included: 1, locations_overage_price_cents: 0, base_price_cents: 7900, active_locations: 1 },
    ]);
    sqlReturnQueue.push([{ account_id: 'acct-x', api_cost_usd: 5, generation_count: 10, openai_count: 10, anthropic_count: 0, generation_cost_usd: 5, flagged_count: 0 }]);
    sqlReturnQueue.push([{ total_cost_usd: 5 }]);
    const data = await getMarginReport(sql, { limit: 10 });
    expect(data.topAccountsByCost[0]!.mrrUsd).toBe(0);
    expect(data.topAccountsByCost[0]!.costPctOfMrr).toBeNull();
    expect(data.topAccountsByCost[0]!.riskLevel).toBe('none');
    expect(data.platform.grossMarginPct).toBeNull();
  });
});
