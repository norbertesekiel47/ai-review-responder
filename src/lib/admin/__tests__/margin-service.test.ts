import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSqlResults, sqlCallCounter, capturedSqlTexts } = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  capturedSqlTexts: [] as string[],
}));

vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(() => {}, {
    apply: (_t, _a, args: unknown[]) => {
      const first = args[0];
      if (first != null && typeof first === 'object' && 'raw' in (first as object)) {
        capturedSqlTexts.push((first as TemplateStringsArray).raw.join('?'));
      }
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }),
}));

import {
  getMarginReport,
  monthlyMrrCents,
  classifyAccountRisk,
  classifyPlatformRisk,
} from '../margin-service';

beforeEach(() => {
  mockSqlResults.length = 0;
  capturedSqlTexts.length = 0;
  sqlCallCounter.value = 0;
});
afterEach(() => vi.clearAllMocks());

describe('monthlyMrrCents (mirrors currentBillingSnapshot)', () => {
  it('standard tier base only when at included count', () => {
    expect(monthlyMrrCents({ tier: 'standard', includedLocations: 1, overagePriceCents: 2500, activeLocations: 1 })).toBe(7900);
  });
  it('standard tier adds overage per extra active location', () => {
    expect(monthlyMrrCents({ tier: 'standard', includedLocations: 1, overagePriceCents: 2500, activeLocations: 3 })).toBe(7900 + 2 * 2500);
  });
  it('basic tier never adds overage', () => {
    expect(monthlyMrrCents({ tier: 'basic', includedLocations: 1, overagePriceCents: 0, activeLocations: 5 })).toBe(2900);
  });
  it('premium tier includes 5 before overage', () => {
    expect(monthlyMrrCents({ tier: 'premium', includedLocations: 5, overagePriceCents: 2000, activeLocations: 6 })).toBe(19900 + 2000);
  });
  it('unknown tier → 0 (excluded from margin)', () => {
    expect(monthlyMrrCents({ tier: 'mystery', includedLocations: 1, overagePriceCents: 0, activeLocations: 1 })).toBe(0);
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
    mockSqlResults[0] = [
      { id: 'acct-1', display_name: 'Acme', subscription_tier: 'standard', subscription_status: 'active', locations_included: 1, locations_overage_price_cents: 2500, active_locations: 1 },
      { id: 'acct-2', display_name: 'Beta', subscription_tier: 'premium', subscription_status: 'active', locations_included: 5, locations_overage_price_cents: 2000, active_locations: 5 },
    ];
    mockSqlResults[1] = [
      { account_id: 'acct-1', api_cost_usd: 39.5, generation_count: 100, openai_count: 90, anthropic_count: 10, generation_cost_usd: 38, flagged_count: 2 },
      { account_id: 'acct-2', api_cost_usd: 1.0, generation_count: 20, openai_count: 20, anthropic_count: 0, generation_cost_usd: 1, flagged_count: 0 },
    ];
    mockSqlResults[2] = [{ total_cost_usd: 40.5 }];
  }

  it('computes per-account margin rows sorted by cost desc with risk levels', async () => {
    seed();
    const data = await getMarginReport({ limit: 10 });
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
    await getMarginReport({ limit: 10 });
    // The per-account cost-aggregate query (index 1) must count flags only over
    // openai/anthropic rows so flaggedRatePct shares responseCount's population.
    expect(capturedSqlTexts[1]).toContain(
      "FILTER (WHERE provider IN ('openai', 'anthropic') AND flagged)",
    );
  });

  it('computes platform gross margin and risk', async () => {
    seed();
    const data = await getMarginReport({ limit: 10 });
    expect(data.platform.totalRevenueUsd).toBe(278);
    expect(data.platform.variableApiCogsUsd).toBe(40.5);
    expect(data.platform.grossMarginPct).toBeCloseTo(85.4, 1);
    expect(data.platform.riskLevel).toBe('none');
  });

  it('handles an account with cost but zero MRR (costPct null, risk none)', async () => {
    mockSqlResults[0] = [
      { id: 'acct-x', display_name: 'X', subscription_tier: 'mystery', subscription_status: 'active', locations_included: 1, locations_overage_price_cents: 0, active_locations: 1 },
    ];
    mockSqlResults[1] = [{ account_id: 'acct-x', api_cost_usd: 5, generation_count: 10, openai_count: 10, anthropic_count: 0, generation_cost_usd: 5, flagged_count: 0 }];
    mockSqlResults[2] = [{ total_cost_usd: 5 }];
    const data = await getMarginReport({ limit: 10 });
    expect(data.topAccountsByCost[0]!.mrrUsd).toBe(0);
    expect(data.topAccountsByCost[0]!.costPctOfMrr).toBeNull();
    expect(data.topAccountsByCost[0]!.riskLevel).toBe('none');
    expect(data.platform.grossMarginPct).toBeNull();
  });
});
