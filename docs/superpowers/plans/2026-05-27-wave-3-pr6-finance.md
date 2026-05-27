# Wave 3 · PR 6 — Finance: API/LLM cost-margin signals + finance docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give admin account-level + platform API/LLM cost and gross-margin-risk signals computed live from `api_costs`, surface them on the existing admin costs page, add the finance discipline docs (COGS template, monthly close, three-scenario model), and mark Wave 3 code-complete in the README.

**Architecture:** Aggregate-on-read (no migration): a new `src/lib/admin/margin-service.ts` computes per-account variable API COGS (from `api_costs`, trailing 30 days) vs per-account MRR (from `accounts` billing columns + `TIER_CONFIG`, mirroring `currentBillingSnapshot`), classifies margin risk against documented thresholds, and rolls up a platform gross margin. The existing `GET /api/admin/costs` route is extended to also return this margin payload; the existing `/admin/costs` page renders a margin-risk section. Finance docs are markdown. README is marked code-complete with external gates listed.

**Tech Stack:** TypeScript (ESM, strict), Postgres.js, Next.js (admin route + client page), Vitest. Launch slice of Spec 26. Independent of PRs #99–#101 (reads `api_costs`/`accounts`, both on `main`).

---

## Base Branch & Conventions

- **Branch:** `wave-3-pr6-finance` off **`origin/main`**. No dependency on the other open Wave 3 PRs.
- **No migration** (aggregate-on-read per the scope decision). Migration head stays **051** — do NOT bump it or add a migration.
- **Imports:** `@/` alias (production code).
- **Cost unit:** `api_costs.cost_usd` is `DECIMAL(10,6)` USD (dollars). `SUM(cost_usd)::float`. No cents.
- **MRR source:** mirror `currentBillingSnapshot` (`src/lib/accounts/quota.ts`): `totalCents = baseCents + computeOverageQuantity(activeLocations, includedLocations) * overagePriceCents`; for `!multiLocAllowed || overageCents === 0` tiers, `totalCents = baseCents`. `baseCents` from `TIER_CONFIG[tier]` (live; documented base-not-grandfathered gap — fine for admin signal). `includedLocations`/`overagePriceCents` from the `accounts` columns. Reuse `computeOverageQuantity`, `TIER_CONFIG`, `isSubscriptionTier` from `@/lib/accounts/quota` / `@/lib/accounts/tier-config`.
- **Thresholds (documented in Spec 26):** account cost/MRR ≥ 25% → warning, ≥ 40% → action; platform gross margin < 70% → warning, < 60% → action.
- **Fallback semantics:** each generation writes one `api_costs` row with the provider used; `provider='anthropic'` (endpoint `messages`) = fallback. Fallback rate = anthropic / (openai + anthropic) generation rows.
- **Admin auth:** `requireRole(request, 'admin')` from `@/lib/db/auth` (no AAL2 in this codebase) — mirror the exact try/catch in the existing `/api/admin/costs/route.ts`.
- **tenant-scope:** the margin queries are admin cross-account aggregates over `api_costs`/`accounts` with NO per-tenant filter (by design — admin-wide). The audit will flag them "missing scope"; add allowlist entries in `scripts/ci/tenant-scope-allowlist.ts` with an admin-only rationale (mirrors the Wave 3 admin flagged-queue allowlisting). Run `pnpm ci:tenant-scope` locally.
- **Stale `.next/`** caveat: a new/changed route can leave `.next/types/**` stale → `rm -rf .next` and re-run typecheck.
- **`.claude/CLAUDE.md` is orchestrator-only** (subagent self-mod guard) — Task 5's CLAUDE.md note is done by the orchestrator.
- **UI:** Task 3 touches the admin costs page — the implementer MUST use the `repworth-brand-design` skill for the new section.
- **Commit trailer:** every commit ends with
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

## File Structure

Created:
- `src/lib/admin/margin-service.ts` — `getMarginReport()` + `monthlyMrrCents()` + risk classifiers + types.
- `src/lib/admin/__tests__/margin-service.test.ts`
- `docs/finance/cogs-template.md`
- `docs/finance/monthly-close.md`
- `docs/finance/model.md`

Modified:
- `src/app/api/admin/costs/route.ts` — also return the margin payload.
- `src/app/api/admin/costs/__tests__/route.test.ts` — assert margin payload + admin auth.
- `src/app/admin/costs/page.tsx` — render a margin-risk section.
- `scripts/ci/tenant-scope-allowlist.ts` — admin margin query entries (Task 5).
- `docs/sass_ready/README.md` — Wave 3 code-complete (Task 5).
- `docs/progresstracking.md` + `.claude/CLAUDE.md` (Task 5, CLAUDE.md orchestrator-only).

---

### Task 1: Margin service

**Files:**
- Create: `src/lib/admin/margin-service.ts`
- Test: `src/lib/admin/__tests__/margin-service.test.ts`

- [ ] **Step 1: Write the failing test `src/lib/admin/__tests__/margin-service.test.ts`**

Use the queue-Proxy `sql` mock (match `src/lib/dashboard/__tests__` / admin route test harness). The service issues 3 queries via `Promise.all` in this order: `[0]` billable accounts (+active_locations), `[1]` per-account cost aggregates, `[2]` platform total cost. Plus pure-helper tests for `monthlyMrrCents` and the risk classifiers.

```ts
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
});

describe('getMarginReport', () => {
  function seed() {
    // [0] billable accounts
    mockSqlResults[0] = [
      { id: 'acct-1', display_name: 'Acme', subscription_tier: 'standard', subscription_status: 'active', locations_included: 1, locations_overage_price_cents: 2500, active_locations: 1 },
      { id: 'acct-2', display_name: 'Beta', subscription_tier: 'premium', subscription_status: 'active', locations_included: 5, locations_overage_price_cents: 2000, active_locations: 5 },
    ];
    // [1] per-account cost aggregates
    mockSqlResults[1] = [
      { account_id: 'acct-1', api_cost_usd: 39.5, generation_count: 100, openai_count: 90, anthropic_count: 10, generation_cost_usd: 38, flagged_count: 2 },
      { account_id: 'acct-2', api_cost_usd: 1.0, generation_count: 20, openai_count: 20, anthropic_count: 0, generation_cost_usd: 1, flagged_count: 0 },
    ];
    // [2] platform total cost
    mockSqlResults[2] = [{ total_cost_usd: 40.5 }];
  }

  it('computes per-account margin rows sorted by cost desc with risk levels', async () => {
    seed();
    const data = await getMarginReport({ limit: 10 });
    expect(data.windowDays).toBe(30);
    const acme = data.topAccountsByCost[0]!;
    expect(acme.accountId).toBe('acct-1'); // highest cost first
    expect(acme.mrrUsd).toBe(79); // standard base 7900c
    expect(acme.llmApiCostUsd).toBe(39.5);
    expect(acme.costPctOfMrr).toBe(50); // 39.5/79*100
    expect(acme.riskLevel).toBe('action'); // >=40
    expect(acme.fallbackRatePct).toBe(10); // 10/100
    expect(acme.flaggedRatePct).toBe(2); // 2/100
    expect(acme.avgCostPerResponseUsd).toBeCloseTo(0.38, 5); // 38/100
  });

  it('computes platform gross margin and risk', async () => {
    seed();
    const data = await getMarginReport({ limit: 10 });
    // revenue = 79 (standard) + 199 (premium) = 278; cogs = 40.5
    expect(data.platform.totalRevenueUsd).toBe(278);
    expect(data.platform.variableApiCogsUsd).toBe(40.5);
    expect(data.platform.grossMarginPct).toBeCloseTo(85.4, 1); // (278-40.5)/278*100
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
    expect(data.platform.grossMarginPct).toBeNull(); // revenue 0
  });
});
```

- [ ] **Step 2: Run to verify it FAILS** — `pnpm vitest run src/lib/admin/__tests__/margin-service.test.ts` (cannot resolve `../margin-service`).

- [ ] **Step 3: Write `src/lib/admin/margin-service.ts`**

```ts
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
export const PLATFORM_WARNING_PCT = 70;
export const PLATFORM_ACTION_PCT = 60;

export type MarginRiskLevel = 'none' | 'warning' | 'action';

export interface AccountMarginRow {
  accountId: string;
  displayName: string;
  subscriptionTier: string;
  subscriptionStatus: string;
  mrrUsd: number;
  llmApiCostUsd: number;
  /** llmApiCostUsd / mrrUsd * 100; null when mrrUsd = 0. */
  costPctOfMrr: number | null;
  riskLevel: MarginRiskLevel;
  responseCount: number;
  avgCostPerResponseUsd: number | null;
  openaiCount: number;
  anthropicCount: number;
  /** anthropic / (openai + anthropic) * 100; null when no generation rows. */
  fallbackRatePct: number | null;
  flaggedCount: number;
  /** flaggedCount / responseCount * 100; null when no generation rows. */
  flaggedRatePct: number | null;
}

export interface PlatformMargin {
  totalRevenueUsd: number;
  variableApiCogsUsd: number;
  /** (revenue - cogs) / revenue * 100; null when revenue = 0. */
  grossMarginPct: number | null;
  riskLevel: MarginRiskLevel;
  /** Reminder that this excludes non-code vendor bills. */
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
    // [0] Billable accounts + active location count.
    // Admin cross-account read (no per-tenant filter) — allowlisted.
    sql<AccountRow[]>`
      SELECT a.id, a.display_name, a.subscription_tier, a.subscription_status,
             a.locations_included, a.locations_overage_price_cents,
             COUNT(b.id) FILTER (WHERE b.archived_at IS NULL)::int AS active_locations
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id
      WHERE a.subscription_status IN ('active', 'past_due')
      GROUP BY a.id
    `,
    // [1] Per-account windowed cost aggregates. Admin cross-account — allowlisted.
    sql<CostAggRow[]>`
      SELECT account_id,
             SUM(cost_usd)::float AS api_cost_usd,
             COUNT(*) FILTER (WHERE provider IN ('openai', 'anthropic'))::int AS generation_count,
             COUNT(*) FILTER (WHERE provider = 'openai')::int AS openai_count,
             COUNT(*) FILTER (WHERE provider = 'anthropic')::int AS anthropic_count,
             COALESCE(SUM(cost_usd) FILTER (WHERE provider IN ('openai', 'anthropic')), 0)::float AS generation_cost_usd,
             COUNT(*) FILTER (WHERE flagged)::int AS flagged_count
      FROM api_costs
      WHERE account_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY account_id
    `,
    // [2] Platform total variable API COGS (window). Admin-wide — allowlisted.
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
    const llmApiCostUsd = round(cost?.api_cost_usd ?? 0, 6);
    const responseCount = cost?.generation_count ?? 0;
    const openaiCount = cost?.openai_count ?? 0;
    const anthropicCount = cost?.anthropic_count ?? 0;
    const flaggedCount = cost?.flagged_count ?? 0;
    const generationCostUsd = cost?.generation_cost_usd ?? 0;

    const costPctOfMrr = mrrUsd > 0 ? round((llmApiCostUsd / mrrUsd) * 100, 1) : null;
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
      llmApiCostUsd,
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

  rows.sort((a, b) => b.llmApiCostUsd - a.llmApiCostUsd);

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
```

- [ ] **Step 4: Run to verify it PASSES** — `pnpm vitest run src/lib/admin/__tests__/margin-service.test.ts`. Confirm the sort, MRR mirror, and null-edge cases.

- [ ] **Step 5: Typecheck** — `pnpm typecheck` clean. Confirm `computeOverageQuantity`, `TIER_CONFIG`, `isSubscriptionTier` import paths are correct (read `src/lib/accounts/quota.ts` + `tier-config.ts` exports if the import errors).

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin/margin-service.ts src/lib/admin/__tests__/margin-service.test.ts
git commit -m "feat(finance): admin API/LLM cost-margin service (aggregate-on-read)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Return margin from the admin costs route

**Files:**
- Modify: `src/app/api/admin/costs/route.ts`
- Modify: `src/app/api/admin/costs/__tests__/route.test.ts`

- [ ] **Step 1: Extend the route.** The route currently returns `getCostReport(parsed)`. Change the success path to also include the margin payload (computed by `getMarginReport`), so the response is the cost report plus a `margin` key:

```ts
import { parseCostQuery, getCostReport } from '@/lib/admin/cost-report-service';
import { getMarginReport } from '@/lib/admin/margin-service';
// ...
  try {
    const [cost, margin] = await Promise.all([
      getCostReport(parsed),
      getMarginReport({ limit: 20 }),
    ]);
    return NextResponse.json({ ...cost, margin });
  } catch (error) {
    console.error('[api/admin/costs] Failed to fetch cost data:', error);
    return NextResponse.json({ error: 'Failed to fetch cost data' }, { status: 500 });
  }
```
Keep the `requireRole(request, 'admin')` auth block and the 400 parse-error path exactly as-is.

- [ ] **Step 2: Update the route test** (`src/app/api/admin/costs/__tests__/route.test.ts`): mock `@/lib/admin/margin-service`'s `getMarginReport` alongside the existing `getCostReport` mock; assert (a) admin auth still enforced (non-admin → 401/403, service not called), (b) the 200 response body now contains both the cost fields AND a `margin` object, (c) a `getMarginReport` throw is caught → 500. Follow the file's existing mock harness.

- [ ] **Step 3: Run the route test** — `pnpm vitest run src/app/api/admin/costs/__tests__/route.test.ts` — PASS.

- [ ] **Step 4: Typecheck** — `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/costs/route.ts src/app/api/admin/costs/__tests__/route.test.ts
git commit -m "feat(finance): include margin signals in GET /api/admin/costs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Margin-risk section on the admin costs page

**Files:**
- Modify: `src/app/admin/costs/page.tsx`

> **Use the `repworth-brand-design` skill** for this section — match the existing admin costs page's island/card layout, color tokens, and typography. This is an internal admin page; keep it functional and consistent with the surrounding cost UI.

- [ ] **Step 1: Read `src/app/admin/costs/page.tsx`** fully to learn its structure: the `useQuery` fetch of `/api/admin/costs`, the response type it declares, and how it renders the existing cost cards/tables. The route now returns a `margin` key (Task 2) of type `MarginData` (import the type from `@/lib/admin/margin-service`).

- [ ] **Step 2: Add a "Margin & gross-margin risk" section** rendering `data.margin` (guard for when it's present), following brand-design:
  - **Platform card:** gross margin % (or "—" when null), total revenue (MRR) USD, variable API COGS USD, and a risk badge (none/warning/action) driven by `margin.platform.riskLevel`. Show `margin.platform.note` as small print.
  - **Top accounts table:** one row per `margin.topAccountsByCost` entry — account name, tier, MRR, LLM/API cost (window), cost % of MRR, a risk badge (none/warning/action from `riskLevel`), avg cost/response, fallback rate %, flagged rate %.
  - Use a clear visual for warning (amber) vs action (red) per the brand tokens. Label the window ("last 30 days") and that platform margin is API/LLM COGS only.
  - Render nothing/skeleton gracefully if `data.margin` is undefined (older cached responses).

- [ ] **Step 3: Verify the page typechecks + builds.** Run `pnpm typecheck` (clean) and `pnpm build` (the admin costs page compiles). If `.next/types` is stale, `rm -rf .next` and re-run. There is no unit test for this client page (consistent with the existing page having none); correctness is verified by typecheck + build + the route test from Task 2.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/costs/page.tsx
git commit -m "feat(finance): margin-risk section on the admin costs page

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Finance docs

**Files:**
- Create: `docs/finance/cogs-template.md`
- Create: `docs/finance/monthly-close.md`
- Create: `docs/finance/model.md`

- [ ] **Step 1: Write `docs/finance/cogs-template.md`**

````markdown
# COGS Template (monthly)

Variable cost of goods sold per month. Two sources: **code-computed** API/LLM
costs (from `api_costs`, visible in `/admin/costs`) and **vendor bills** entered
manually from invoices. Copy this table each month.

| Vendor | Category | Amount (USD) | Period | Source invoice / link | Variable COGS or fixed opex | Notes |
|---|---|---|---|---|---|---|
| OpenAI | LLM (code-computed) | | | /admin/costs (provider split) | variable | gpt-4o-mini generation |
| Anthropic | LLM (code-computed) | | | /admin/costs | variable | Haiku fallback — watch fallback rate |
| SerpAPI | Reviews API (code-computed) | | | /admin/costs | variable | |
| Resend | Email (code-computed) | | | /admin/costs | variable | |
| Twilio | SMS (code-computed) | | | provider dashboard | variable | |
| Supabase | DB/auth (vendor bill) | | | invoice | fixed opex | |
| Railway | Worker host (vendor bill) | | | invoice | fixed opex | |
| Vercel | Web host (vendor bill) | | | invoice | fixed opex | |
| Upstash | Redis (vendor bill) | | | invoice | fixed opex | |
| Sentry | Errors (vendor bill) | | | invoice | fixed opex | |
| PostHog | Analytics (vendor bill) | | | invoice | fixed opex | |
| Help Scout | Support (vendor bill) | | | invoice | fixed opex | |

**Variable COGS** = per-customer-usage costs (LLM, SerpAPI, Resend, Twilio).
Used in gross-margin math. **Fixed opex** = platform vendor bills that don't
scale per customer; tracked here but excluded from the per-account/platform
gross-margin signal in `/admin/costs` (which is code-computed API COGS only).
````

- [ ] **Step 2: Write `docs/finance/monthly-close.md`**

````markdown
# Monthly Close Checklist

Run on the first business day for the prior month. Solo-founder discipline.

1. **Stripe revenue** — export the month's Stripe invoices/payments; record gross
   revenue and active subscriptions (MRR).
2. **API cost review** — open `/admin/costs` (last 30 days): record per-provider
   spend, fallback rate, avg cost per response, and any account over the 25% /
   40% cost-of-MRR thresholds. Investigate `action`-level accounts.
3. **Vendor COGS entry** — fill `cogs-template.md` from the month's invoices
   (Supabase, Railway, Vercel, Upstash, Sentry, PostHog, Help Scout, Twilio).
4. **Gross-margin calculation** —
   `gross_margin = (revenue − variable_cogs) / revenue`. Compare to the
   platform thresholds (warn < 70%, act < 60%). Note that `/admin/costs` shows
   the API-COGS-only margin; the true margin also subtracts variable vendor COGS.
5. **Cash balance & runway** — record bank + Stripe balance; compute runway
   (cash / monthly net burn).
6. **Action items** — list any margin/cost actions (e.g. tune fallback rate,
   revisit a high-cost account's plan, renegotiate a vendor).

Record the close in a dated file (e.g. `docs/finance/close-YYYY-MM.md`) — or
reuse `pilot-invoice-review-YYYY-MM.md` for the pilot period.
````

- [ ] **Step 3: Write `docs/finance/model.md`**

````markdown
# Three-Scenario Financial Model

Monthly growth / churn / gross-margin assumptions for planning. Revisit each
monthly close against actuals.

| Scenario | Monthly growth | Monthly churn | Gross margin |
|---|---|---|---|
| Conservative | 5% | 4% | 60% |
| Base | 10% | 2% | 75% |
| Ambitious | 15% | 1% | 80% |

**How to use:**
- Project MRR forward: `MRR_next = MRR * (1 + growth − churn)`.
- Apply the scenario gross margin to estimate contribution after variable COGS.
- Sanity-check the gross-margin assumption against the actual platform margin in
  `/admin/costs` + the vendor COGS from `cogs-template.md`. If actual API-COGS
  margin is already below the scenario assumption before vendor COGS, the
  scenario is optimistic.
- Conservative is the planning floor (runway decisions); ambitious is the
  upside case, not the plan of record.
````

- [ ] **Step 4: Commit**

```bash
git add docs/finance/cogs-template.md docs/finance/monthly-close.md docs/finance/model.md
git commit -m "docs(finance): COGS template, monthly-close checklist, three-scenario model

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: tenant-scope + verification + README + living docs + PR

**Files:**
- Modify: `scripts/ci/tenant-scope-allowlist.ts`
- Modify: `docs/sass_ready/README.md`
- Modify: `docs/progresstracking.md`
- Modify: `.claude/CLAUDE.md` (**orchestrator-only**)

- [ ] **Step 1: tenant-scope audit + allowlist.** Run `pnpm ci:tenant-scope`. The three `getMarginReport` queries (accounts, api_costs ×2) are admin-wide cross-account aggregates with NO per-tenant filter — expect "missing scope" findings for `accounts`, `businesses`, `api_costs`. For EACH, add a `tenantScopeAllowlist` entry in `scripts/ci/tenant-scope-allowlist.ts` (`file: "src/lib/admin/margin-service.ts"`, the table, the exact normalized snippet, reason: "Admin-only platform/account margin aggregate; intentionally cross-account (no tenant filter). Gated by requireRole('admin') at the /api/admin/costs route. Mirrors the Wave 3 admin flagged-queue allowlisting."). Iterate (run audit → fix snippet text → re-run) until `tenant-scope-audit: passed`. Confirm each query is genuinely admin-gated before allowlisting.

- [ ] **Step 2: Full verification.**
  - `pnpm test` — whole suite green (margin service + route tests; no regressions).
  - `pnpm typecheck` — clean (stale `.next/types/**` → `rm -rf .next`).
  - `pnpm build` — success (admin costs page compiles).
  - `pnpm lint` — clean (no new errors).
  - `pnpm ci:tenant-scope` — passed.

- [ ] **Step 3: Mark Wave 3 code-complete in `docs/sass_ready/README.md`** (the Wave 3 line, currently `🟡 PARTIALLY SHIPPED`). Update to reflect Wave 3 is **code-complete across PRs #99–#101 + the finance PR** (drop the "Not yet built: … PR 6" clause), and list the unresolved **external/production gates**: log drain + Sentry P0–P2 routing + synthetic checks; OpenAI Moderation enable + threshold tuning; scheduled 50-row live eval; PostHog production dashboards + `POSTHOG_API_KEY` delivery; ProfitWell / Stripe Revenue Recognition / QuickBooks-Xero + first monthly close; first COGS file from real invoices. Keep the wording "code-complete, production vendor gates pending" rather than an unqualified "shipped" (the PR stack is still open).

- [ ] **Step 4: Update `docs/progresstracking.md`** — add a PR 6 note: aggregate-on-read `margin-service.ts` (account cost/MRR risk + platform gross margin from `api_costs`, no migration); `/api/admin/costs` returns margin; admin costs page shows the margin-risk section; finance docs (`cogs-template`, `monthly-close`, `model`); README marked Wave 3 code-complete + external gates. Note that with PR 6, Wave 3's six-PR slice is code-complete pending merge.

- [ ] **Step 5: Update `.claude/CLAUDE.md` (orchestrator-only)** — one line: admin API/LLM cost-margin signals come from `src/lib/admin/margin-service.ts` (`getMarginReport`, aggregate-on-read from `api_costs`; per-account cost/MRR risk at 25%/40%, platform gross margin at 70%/60%), surfaced in `/admin/costs`; finance discipline docs in `docs/finance/`.

- [ ] **Step 6: Commit docs**

```bash
git add scripts/ci/tenant-scope-allowlist.ts docs/sass_ready/README.md docs/progresstracking.md .claude/CLAUDE.md
git commit -m "docs: Wave 3 PR 6 — finance margin signals + README Wave 3 code-complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Push + open PR (base `main`)**

```bash
git push -u origin wave-3-pr6-finance
gh pr create --base main --head wave-3-pr6-finance \
  --title "Wave 3 · PR 6 — Finance: API/LLM cost-margin signals + finance docs" \
  --body "$(cat <<'EOF'
## Summary
- `src/lib/admin/margin-service.ts` — aggregate-on-read (no migration): per-account variable API COGS (from `api_costs`, trailing 30d) vs per-account MRR (mirrors `currentBillingSnapshot`), classified against Spec 26 thresholds (account cost/MRR ≥25% warn / ≥40% act), plus a platform gross margin (<70% warn / <60% act). Provider split, fallback rate, avg cost/response, flagged rate per account.
- `GET /api/admin/costs` now returns a `margin` payload alongside the cost report (admin-auth unchanged).
- `/admin/costs` page gains a margin-risk section (platform card + top-accounts-by-cost table).
- Finance docs: `docs/finance/{cogs-template,monthly-close,model}.md`.
- README marked **Wave 3 code-complete** (PRs #99–#101 + #6), production vendor gates listed.

## Notes
- **No migration** (head stays 051). Independent of #99–#101. Margin queries are admin-wide cross-account aggregates — allowlisted in the tenant-scope audit (each verified admin-gated). Platform margin is **API/LLM COGS only**; vendor bills are tracked in `monthly-close.md` (clearly labeled).
- Base-price-not-grandfathered gap in MRR is inherited from `currentBillingSnapshot` (documented; acceptable for an admin signal).

## Test plan
- `pnpm vitest run src/lib/admin/__tests__/margin-service.test.ts src/app/api/admin/costs` — green (MRR mirror, risk thresholds, sort, null edges, admin auth, margin in body, 500 on throw)
- `pnpm test` / `pnpm typecheck` / `pnpm build` / `pnpm lint` / `pnpm ci:tenant-scope` — green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage (Spec 26):**
- Cost/margin rollup from `api_costs` (aggregate-on-read, no table) → Task 1.
- Gross-margin inputs: revenue from stored billing + `TIER_CONFIG` (MRR), variable COGS from `api_costs` → `monthlyMrrCents` + cost aggregates.
- Admin warning thresholds (25/40 account, 70/60 platform) → constants + classifiers + surfaced in UI.
- Admin cost/margin view: top accounts by cost, avg cost/response, provider split, fallback rate, flagged rate, accounts over thresholds, platform margin → Tasks 1–3.
- Finance docs (cogs-template, monthly-close, model) with the specified fields/assumptions → Task 4.
- Code-computed API COGS vs external vendor bills clearly distinguished → `PlatformMargin.note` + `cogs-template.md` + `monthly-close.md`.
- README Wave 3 marked + external gates listed → Task 5.

**Placeholder scan:** Tasks 1, 2, 4 fully concrete. Task 3 (client UI) specifies the exact data shape + section contents + brand-design skill, and instructs reading the existing page (a large client component whose exact JSX must match house style) — a bounded read, not a vague placeholder; no unit test for the page matches the existing convention. Task 5 Step 1 allowlist snippets are conditional on the audit's normalized output (can't predict pre-run).

**Type consistency:** `MarginData`/`AccountMarginRow`/`PlatformMargin`/`MarginRiskLevel`/`monthlyMrrCents`/`classifyAccountRisk`/`classifyPlatformRisk` defined in Task 1 and consumed identically by the route (Task 2) and page (Task 3). MRR formula mirrors `currentBillingSnapshot` and reuses `computeOverageQuantity`/`TIER_CONFIG`/`isSubscriptionTier`.
