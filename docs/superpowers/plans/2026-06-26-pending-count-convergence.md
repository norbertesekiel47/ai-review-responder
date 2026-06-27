# Pending-count Convergence (#346) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every pending-approval-count consumer derive from the authoritative SQL count already in the `/api/dashboard` payload, eliminating the capped-`recentReviews` client filter that undercounts past ~10 pending drafts.

**Architecture:** Add one pure helper `authoritativePendingCount(data)` to `src/lib/dashboard/scope.ts` (which already owns `isAggregate`, `perLocationActive`, and `DashboardPayload`). Aggregate sums the authoritative per-location `locationKpis[].pendingApprovalCount`; per-location reads `reputationSummary.pendingApprovalCount` (the SQL count the route always includes), with a documented defensive fallback to the filtered slice for the impossible no-`reputationSummary` state. Point both client derivations (`DashboardContent.computePendingCount` and `useSyncPendingCount`) at it.

**Tech Stack:** TypeScript (strict), React, Vitest. Pure client-side change — no API, type, or SQL change; not DB-touching.

**Worktree root (all paths relative to it):** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-346-pending-count`

---

## File Structure

- **Modify** `src/lib/dashboard/scope.ts` — add the `authoritativePendingCount` helper (sole owner of the derivation).
- **Create** `src/lib/dashboard/__tests__/scope.test.ts` — unit tests for the helper, including the >10-pending regressions.
- **Modify** `src/components/dashboard/DashboardContent.tsx` — replace local `computePendingCount` with the helper.
- **Modify** `src/hooks/useSyncPendingCount.ts` — replace the inline `.filter()` derivation with the helper.

---

## Task 1: `authoritativePendingCount` helper (TDD)

**Files:**
- Create: `src/lib/dashboard/__tests__/scope.test.ts`
- Modify: `src/lib/dashboard/scope.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/dashboard/__tests__/scope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { authoritativePendingCount } from '../scope';
import type {
  DashboardData,
  DashboardDataActive,
  AggregateDashboardData,
} from '../types';

/** N pending_approval recentReviews rows (per-location shape). */
function recentPending(n: number): DashboardDataActive['recentReviews'] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    reviewerName: 'Reviewer',
    starRating: 5,
    reviewText: null,
    reviewDate: '2026-06-01',
    status: 'pending_approval',
    responseText: 'draft',
    responseStatus: 'pending_approval',
    approvalMethod: null,
  }));
}

/** Active per-location payload. `reputationPending: undefined` omits reputationSummary. */
function activePayload(opts: {
  reputationPending?: number;
  recentPendingCount: number;
}): DashboardDataActive {
  const payload: Partial<DashboardDataActive> = {
    recentReviews: recentPending(opts.recentPendingCount),
  };
  if (opts.reputationPending !== undefined) {
    payload.reputationSummary = {
      averageStar: { current: null, delta: null, priorSampleSize: 0 },
      responseRate: { current: 0, delta: null, priorSampleSize: 0 },
      timeSavedMinutes: { current: 0, delta: null, priorSampleSize: 0 },
      pendingApprovalCount: opts.reputationPending,
      trend: [],
      isRamping: false,
    };
  }
  return payload as DashboardDataActive;
}

/** Aggregate payload with one locationKpi per count. recentReviews stays empty. */
function aggregatePayload(kpiCounts: number[]): AggregateDashboardData {
  const payload: Partial<AggregateDashboardData> = {
    scope: 'aggregate',
    recentReviews: [],
    locationKpis: kpiCounts.map((count, i) => ({
      locationId: `loc${i}`,
      displayName: `Loc ${i}`,
      isPrimary: i === 0,
      totalReviewsHandled: 0,
      pendingApprovalCount: count,
      recentReviewCount: 0,
      billingPending: false,
    })),
  };
  return payload as AggregateDashboardData;
}

describe('authoritativePendingCount', () => {
  it('per-location: returns reputationSummary count, not the capped slice (>10 regression)', () => {
    // 15 authoritative pending, but recentReviews capped at 10 — must return 15.
    const data = activePayload({ reputationPending: 15, recentPendingCount: 10 });
    expect(authoritativePendingCount(data)).toBe(15);
  });

  it('aggregate: sums locationKpis pending counts, not the capped slice (>10 regression)', () => {
    // 8 + 9 = 17 authoritative pending across locations; recentReviews empty.
    const data = aggregatePayload([8, 9]);
    expect(authoritativePendingCount(data)).toBe(17);
  });

  it('past_due per-location: reads the authoritative reputationSummary count', () => {
    const base = activePayload({ reputationPending: 12, recentPendingCount: 3 });
    const pastDue = { ...base, subscriptionStatus: 'past_due' } as unknown as DashboardData;
    expect(authoritativePendingCount(pastDue)).toBe(12);
  });

  it('per-location without reputationSummary: defensive fallback to the filtered slice', () => {
    const data = activePayload({ recentPendingCount: 3 });
    expect(authoritativePendingCount(data)).toBe(3);
  });

  it('non-active per-location status returns 0', () => {
    const pendingPayment: DashboardData = {
      subscriptionStatus: 'pending_payment',
      businessId: 'b1',
      businessName: 'Biz',
      paymentUrl: null,
    };
    expect(authoritativePendingCount(pendingPayment)).toBe(0);
  });

  it('null payload returns 0', () => {
    expect(authoritativePendingCount(null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/lib/dashboard/__tests__/scope.test.ts`
Expected: FAIL — `authoritativePendingCount` is not exported from `../scope`.

- [ ] **Step 3: Implement the helper**

In `src/lib/dashboard/scope.ts`, append after `perLocationActive` (the file already imports `DashboardData`, `DashboardDataActive`, `AggregateDashboardData`, `SubscriptionStatus` — no new imports needed):

```ts
/**
 * Authoritative count of owner drafts awaiting approval, derived from the
 * SQL-backed fields already present in the payload — NOT the capped
 * `recentReviews` slice, which undercounts past ~10 pending (issue #346).
 *
 *   aggregate              → Σ locationKpis[].pendingApprovalCount
 *   per-loc active/pastdue  → reputationSummary.pendingApprovalCount
 *   else / null            → 0
 *
 * The per-location branch falls back to filtering `recentReviews` only when
 * `reputationSummary` is absent — an impossible state for the active
 * per-location route (it always passes includeReputationMetrics), kept purely
 * as a defensive guard so the count can never regress below today's behavior.
 */
export function authoritativePendingCount(data: DashboardPayload | null): number {
  if (!data) return 0;
  if (isAggregate(data)) {
    return data.locationKpis.reduce((sum, kpi) => sum + kpi.pendingApprovalCount, 0);
  }
  const active = perLocationActive(data);
  if (!active) return 0;
  return (
    active.reputationSummary?.pendingApprovalCount ??
    active.recentReviews.filter(
      (review) => (review.responseStatus ?? review.status) === 'pending_approval',
    ).length
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/lib/dashboard/__tests__/scope.test.ts`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard/scope.ts src/lib/dashboard/__tests__/scope.test.ts
git commit -m "feat(dashboard): authoritativePendingCount helper over the SQL-backed payload (#346)"
```

---

## Task 2: Point `DashboardContent` at the helper

**Files:**
- Modify: `src/components/dashboard/DashboardContent.tsx`

No direct component test exists; the derivation logic is now covered by Task 1's
unit test, and typecheck + the full suite are the safety net for the wiring.

- [ ] **Step 1: Import the helper**

In `src/components/dashboard/DashboardContent.tsx`, add to the existing import block (near the other `@/lib/dashboard` / `@/contexts` imports, e.g. after the `useLocationScope` import on line 28):

```ts
import { authoritativePendingCount } from '@/lib/dashboard/scope';
```

- [ ] **Step 2: Replace the call site**

Change the line that computes the badge value (currently `const pendingFromData = computePendingCount(data);`, ~line 138) to:

```ts
  const pendingFromData = authoritativePendingCount(data);
```

- [ ] **Step 3: Delete the now-unused local function**

Remove the `computePendingCount` function and its doc comment at the bottom of the file (currently ~lines 356–370):

```ts
/** Compute pending approval count from either aggregate or per-location data. */
function computePendingCount(data: DashboardOrAggregate | null): number {
  if (!data) return 0;
  if (isAggregateData(data)) {
    return data.recentReviews.filter(
      (r) => (r.responseStatus ?? r.status) === 'pending_approval',
    ).length;
  }
  if (data.subscriptionStatus === undefined || data.subscriptionStatus === SubscriptionStatus.PAST_DUE) {
    return data.recentReviews.filter(
      (r) => (r.responseStatus ?? r.status) === 'pending_approval',
    ).length;
  }
  return 0;
}
```

Leave the local `isAggregateData` type guard (still used at the aggregate-view
branch, ~line 186) and `SubscriptionStatus` (used elsewhere) in place.

- [ ] **Step 4: Verify typecheck + related tests**

Run: `pnpm typecheck`
Expected: PASS — no unused-symbol or type errors (confirms `computePendingCount` had no other callers and `SubscriptionStatus`/`isAggregateData` are still used).

Run: `pnpm exec vitest run src/components/dashboard`
Expected: PASS — existing dashboard component tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/DashboardContent.tsx
git commit -m "fix(dashboard): badge reads authoritative pending count, matching the strip (#346)"
```

---

## Task 3: Point `useSyncPendingCount` at the helper

**Files:**
- Modify: `src/hooks/useSyncPendingCount.ts`

- [ ] **Step 1: Swap imports**

In `src/hooks/useSyncPendingCount.ts`, replace the scope import line:

```ts
import { isAggregate, perLocationActive } from '@/lib/dashboard/scope';
```

with:

```ts
import { authoritativePendingCount } from '@/lib/dashboard/scope';
```

(Keep the `DashboardPayload` type import and the `useSetPendingCount` import.)

- [ ] **Step 2: Replace the derivation**

Replace the `const pending = …` block (currently the `data && !loading ? (isAggregate(data) ? … ).filter(…).length : 0` expression) with:

```ts
  const pending = !loading ? authoritativePendingCount(data) : 0;
```

The surrounding `useEffect(() => setPendingCount(pending), [pending, setPendingCount])` and `return pending;` stay unchanged.

- [ ] **Step 3: Verify typecheck + related tests**

Run: `pnpm typecheck`
Expected: PASS — no unused-import errors (`isAggregate`/`perLocationActive` removed).

Run: `pnpm exec vitest run src/hooks src/components/dashboard/reviews`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSyncPendingCount.ts
git commit -m "fix(dashboard): reviews-page badge derivation reads the authoritative count (#346)"
```

---

## Task 4: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: PASS (includes tenant-scope / analytics-events / static-policy audits; this change touches none of them).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS — including the new `scope.test.ts` cases.

- [ ] **Step 4: Confirm clean tree**

Run: `git status`
Expected: clean working tree; 4 commits on `fix/346-pending-count` (spec + 3 implementation commits).

---

## Self-Review notes

- **Spec coverage:** helper (scope.ts) ✓; DashboardContent rewire ✓; useSyncPendingCount rewire ✓; >10 regression tests for both per-location and aggregate ✓; non-DB-touching so no tenant-scope/RLS audit ✓.
- **Type consistency:** helper name `authoritativePendingCount` is identical across Tasks 1–3; signature `(data: DashboardPayload | null): number` matches both call sites (`DashboardContent` passes `DashboardOrAggregate`, `useSyncPendingCount` passes `DashboardPayload` — both alias `DashboardData | AggregateDashboardData`).
- **No placeholders:** every step has concrete code/commands and expected output.
