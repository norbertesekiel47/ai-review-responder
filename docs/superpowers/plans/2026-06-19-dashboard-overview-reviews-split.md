# Dashboard → Overview, Reviews → Own Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard a single full-width "overview" (reputation hero, action strip, intelligence brief, reputation trend, velocity + ranking) and move the reviews action queue to its own `/dashboard/reviews` page; apply the same rule to the multi-location aggregate view.

**Architecture:** Pure frontend recomposition. `/api/dashboard` already returns reputation, velocity, ranking, brief, and reviews for both per-location and aggregate scope, so the Dashboard and the new Reviews page share the existing cached `useDashboardData(scope)` hook. The reviews feed components (`ReviewsCard`, `AggregateReviewsCard`) move hosts unchanged; the `PendingApprovalsStrip` becomes a link to the Reviews page; the Insights route is deleted and its three cards render on the dashboard.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), Vitest + Testing Library, class-based CSS via `src/app/(authenticated)/_styles/console.css` (Warm Editorial tokens). Reuses the established double-bezel `.card`/`.approvals` and `.btn`/`.btn-primary`/`.btn-ghost` classes — no new visual system.

**Spec:** `docs/superpowers/specs/2026-06-19-dashboard-overview-reviews-split-design.md`

---

## File Structure

**Create**
- `src/app/(authenticated)/dashboard/reviews/page.tsx` — route shell for the Reviews page.
- `src/components/dashboard/reviews/ReviewsContent.tsx` — client wrapper: picks `ReviewsCard` (per-location) or `AggregateReviewsCard` (aggregate), pushes pending count.
- `src/components/dashboard/reviews/__tests__/ReviewsContent.test.tsx` — render test.

**Modify**
- `src/components/dashboard/kpi/PendingApprovalsStrip.tsx` — link to `/dashboard/reviews` in both states; drop `onReview`.
- `src/components/dashboard/__tests__/PendingApprovalsStrip.test.tsx` — assert links, not buttons.
- `src/components/dashboard/DashboardContent.tsx` — Editorial Stack; remove `ReviewsCard` + scroll machinery; add brief/trend/velocity/ranking.
- `src/components/dashboard/__tests__/DashboardContent.test.tsx` — drop the obsolete hash-scroll-timer test.
- `src/components/dashboard/aggregate/AggregateDashboardContent.tsx` — remove review feed + scroll; add the action strip.
- `src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx` — replace timer test with composition assertions.
- `src/components/dashboard/aggregate/AggregateKpiCards.tsx` — drop `pendingCount` + `onScrollToReviews`.
- `src/components/dashboard/kpi/ValueKpiGrid.tsx` — remove the pending tile + its two props (aggregate-only consumer; the strip replaces it).
- `src/components/dashboard/shell/Sidebar.tsx` — Insights → Reviews (+ pending badge); active-state logic.
- `src/components/dashboard/__tests__/Sidebar.test.tsx` — assert Reviews item.
- `src/components/dashboard/shell/MobileTabBar.tsx` — Insights/Needs-Action → single Reviews tab; remove hash machinery.
- `src/components/dashboard/__tests__/MobileTabBar.test.tsx` — rewrite for the 4-tab set.

**Delete**
- `src/app/(authenticated)/dashboard/insights/page.tsx`
- `src/components/dashboard/insights/InsightsContent.tsx`
- `src/hooks/useNeedsActionHashScroll.ts` (no remaining consumers after this plan)

---

## Task 1: PendingApprovalsStrip → link to the Reviews page

**Files:**
- Modify: `src/components/dashboard/kpi/PendingApprovalsStrip.tsx`
- Test: `src/components/dashboard/__tests__/PendingApprovalsStrip.test.tsx`

- [ ] **Step 1: Replace the test** with link-based assertions

Replace the entire body of `src/components/dashboard/__tests__/PendingApprovalsStrip.test.tsx` with:

```tsx
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PendingApprovalsStrip } from '@/components/dashboard/kpi/PendingApprovalsStrip';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

describe('PendingApprovalsStrip', () => {
  it('shows the pending count and a Review now link to the Reviews page', () => {
    render(<PendingApprovalsStrip count={3} />);
    expect(screen.getByText(/need your approval/)).toBeInTheDocument();
    expect(screen.getByText('3 drafts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /review now/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
  });

  it('uses singular copy for a single pending draft', () => {
    render(<PendingApprovalsStrip count={1} />);
    expect(screen.getByText('1 draft')).toBeInTheDocument();
    expect(screen.getByText(/needs your approval/)).toBeInTheDocument();
  });

  it('shows the calm state with a View all reviews link when count is 0', () => {
    render(<PendingApprovalsStrip count={0} />);
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view all reviews/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/__tests__/PendingApprovalsStrip.test.tsx`
Expected: FAIL (component still renders a button / `onReview`, no link to `/dashboard/reviews`).

- [ ] **Step 3: Rewrite the component**

Replace the entire body of `src/components/dashboard/kpi/PendingApprovalsStrip.tsx` with:

```tsx
'use client';

import Link from 'next/link';
import { Icon } from '@/components/dashboard/shell/Icon';

interface Props {
  count: number;
}

const REVIEWS_HREF = '/dashboard/reviews';

function ReviewsCta({ label, variant }: { label: string; variant: 'primary' | 'ghost' }) {
  return (
    <Link href={REVIEWS_HREF} className={`btn btn-${variant}`}>
      {label}
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </Link>
  );
}

/**
 * Action strip under the dashboard hero. Always a doorway to the Reviews page —
 * "Review now" when drafts are waiting, "View all reviews" when caught up. The
 * arrow link is present in BOTH states (PLAN.md 2026-06-19 restructure).
 */
export function PendingApprovalsStrip({ count }: Props) {
  if (count <= 0) {
    return (
      <div className="approvals calm">
        <div className="approvals-ic">
          <Icon name="check" size={22} />
        </div>
        <div className="approvals-txt">
          <div className="approvals-title">You&apos;re all caught up</div>
          <div className="approvals-sub">
            No drafts waiting. We&apos;ll let you know the moment a new review needs you.
          </div>
        </div>
        <ReviewsCta label="View all reviews" variant="ghost" />
      </div>
    );
  }

  const plural = count === 1 ? '' : 's';
  return (
    <div className="approvals">
      <div className="approvals-ic">
        <Icon name="inbox" size={22} />
      </div>
      <div className="approvals-txt">
        <div className="approvals-title">
          <strong>{count} draft{plural}</strong> need{count === 1 ? 's' : ''} your approval
        </div>
        <div className="approvals-sub">
          Approve or edit {count === 1 ? 'it' : 'them'} on the Reviews page. Usually under a minute.
        </div>
      </div>
      <ReviewsCta label="Review now" variant="primary" />
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/__tests__/PendingApprovalsStrip.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/kpi/PendingApprovalsStrip.tsx src/components/dashboard/__tests__/PendingApprovalsStrip.test.tsx
git commit -m "feat(dashboard): action strip links to /dashboard/reviews in both states"
```

---

## Task 2: New Reviews page + ReviewsContent

**Files:**
- Create: `src/app/(authenticated)/dashboard/reviews/page.tsx`
- Create: `src/components/dashboard/reviews/ReviewsContent.tsx`
- Test: `src/components/dashboard/reviews/__tests__/ReviewsContent.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/reviews/__tests__/ReviewsContent.test.tsx`:

```tsx
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { useDashboardDataMock } = vi.hoisted(() => ({
  useDashboardDataMock: vi.fn(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: () => useDashboardDataMock(),
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: 'loc-1' }),
}));
vi.mock('@/contexts/PendingCountContext', () => ({
  useSetPendingCount: () => () => {},
}));
vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/dashboard/reviews/ReviewsCard', () => ({
  ReviewsCard: () => <div data-testid="reviews-card" />,
}));
vi.mock('@/components/dashboard/aggregate/AggregateReviewsCard', () => ({
  AggregateReviewsCard: () => <div data-testid="aggregate-reviews-card" />,
}));

import { ReviewsContent } from '@/components/dashboard/reviews/ReviewsContent';

const baseActive = {
  business: { name: 'Biz', createdAt: '2026-01-01' },
  valueSummary: { totalReviewsHandled: 0, totalTimeSavedMinutes: 0, currentResponseRate: 0, baselineResponseRate: null },
  recentReviews: [],
  reviewVelocity: [],
  ranking: null,
  latestBrief: null,
  settings: {},
  zernioConnection: { status: 'active', queuedReconnectCount: 0, hasUnresolvedIncident: false },
};

describe('ReviewsContent', () => {
  it('renders the per-location ReviewsCard for active per-location data', () => {
    useDashboardDataMock.mockReturnValue({ data: baseActive, error: null, loading: false, refresh: vi.fn() });
    render(<ReviewsContent />);
    expect(screen.getByTestId('reviews-card')).toBeInTheDocument();
    expect(screen.queryByTestId('aggregate-reviews-card')).not.toBeInTheDocument();
  });

  it('renders the AggregateReviewsCard for aggregate data', () => {
    useDashboardDataMock.mockReturnValue({
      data: { scope: 'aggregate', recentReviews: [], isReadOnly: false },
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<ReviewsContent />);
    expect(screen.getByTestId('aggregate-reviews-card')).toBeInTheDocument();
    expect(screen.queryByTestId('reviews-card')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/reviews/__tests__/ReviewsContent.test.tsx`
Expected: FAIL ("Failed to resolve import .../ReviewsContent").

- [ ] **Step 3: Create the component**

Create `src/components/dashboard/reviews/ReviewsContent.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import type {
  DashboardData,
  DashboardDataActive,
  DashboardDataPastDue,
  AggregateDashboardData,
} from '@/lib/dashboard/types';
import type { DashboardOrAggregate } from '@/hooks/useDashboardData';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';
import { AggregateReviewsCard } from '@/components/dashboard/aggregate/AggregateReviewsCard';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope } from '@/contexts/LocationContext';
import { useSetPendingCount } from '@/contexts/PendingCountContext';

function isAggregate(data: DashboardOrAggregate): data is AggregateDashboardData {
  return 'scope' in data && data.scope === 'aggregate';
}

/** Active (status undefined) and past_due both carry recentReviews. */
function perLocationActive(data: DashboardOrAggregate): DashboardDataActive | null {
  if (isAggregate(data)) return null;
  const status = (data as DashboardData).subscriptionStatus;
  if (status !== undefined && status !== SubscriptionStatus.PAST_DUE) return null;
  return data as DashboardDataActive;
}

/**
 * /dashboard/reviews — the reviews action queue, moved off the dashboard
 * (PLAN.md 2026-06-19). Per-location → ReviewsCard; aggregate → the combined
 * AggregateReviewsCard. Shares the cached /api/dashboard payload.
 */
export function ReviewsContent() {
  const { currentScope } = useLocationScope();
  const { data, error, loading, refresh } = useDashboardData(currentScope);
  const setPendingCount = useSetPendingCount();

  const pending =
    data && !loading
      ? (isAggregate(data)
          ? data.recentReviews
          : (perLocationActive(data)?.recentReviews ?? [])
        ).filter((r) => (r.responseStatus ?? r.status) === 'pending_approval').length
      : 0;

  useEffect(() => {
    setPendingCount(pending);
  }, [pending, setPendingCount]);

  if (loading || !data) {
    return (
      <>
        <TopBar title="Reviews" />
        <div className="content">
          <LiveRegion message="Loading your reviews…" />
          <div className="dashboard-skeleton">
            <div className="skeleton-card-lg" />
          </div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <TopBar title="Reviews" />
        <div className="content">
          <LiveRegion message={error} level="assertive" />
          <div className="card">
            <h2 className="card-h2">Unable to load reviews</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 4 }}>{error}</p>
          </div>
        </div>
      </>
    );
  }

  if (isAggregate(data)) {
    return (
      <>
        <TopBar
          title="Reviews"
          subtitle="Drafts awaiting your approval across all locations."
          showLive
          refresh={refresh}
        />
        <div className="content">
          <div className="section-enter section-enter-1">
            <AggregateReviewsCard
              recentReviews={data.recentReviews}
              onActionSuccess={() => { void refresh(); }}
              readOnly={data.isReadOnly ?? false}
            />
          </div>
        </div>
      </>
    );
  }

  const active = perLocationActive(data);
  if (!active) {
    return (
      <>
        <TopBar title="Reviews" />
        <div className="content">
          <div className="card">
            <h2 className="card-h2">Reviews aren&apos;t available right now</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              Your account needs an active subscription to review drafts.{' '}
              <Link href="/dashboard" style={{ color: 'var(--rw-sage-deep)', fontWeight: 600 }}>
                Back to dashboard
              </Link>
            </p>
          </div>
        </div>
      </>
    );
  }

  const isReadOnly =
    (data as DashboardData).subscriptionStatus === SubscriptionStatus.PAST_DUE
      ? Boolean((data as DashboardDataPastDue).isReadOnly)
      : false;

  return (
    <>
      <TopBar
        title="Reviews"
        subtitle="Drafts awaiting your approval — approve, edit, or regenerate."
        showLive
        refresh={refresh}
      />
      <div className="content">
        <div className="section-enter section-enter-1">
          <ReviewsCard
            recentReviews={active.recentReviews}
            onActionSuccess={() => { void refresh(); }}
            initialTab="needs"
            readOnly={isReadOnly}
          />
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Create the route shell**

Create `src/app/(authenticated)/dashboard/reviews/page.tsx`:

```tsx
import { ReviewsContent } from '@/components/dashboard/reviews/ReviewsContent';

export const dynamic = 'force-dynamic';

export default function ReviewsPage() {
  return <ReviewsContent />;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/reviews/__tests__/ReviewsContent.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/app/\(authenticated\)/dashboard/reviews/page.tsx src/components/dashboard/reviews/ReviewsContent.tsx src/components/dashboard/reviews/__tests__/ReviewsContent.test.tsx
git commit -m "feat(reviews): add /dashboard/reviews page hosting the reviews queue"
```

---

## Task 3: Per-location dashboard → Editorial Stack

**Files:**
- Modify: `src/components/dashboard/DashboardContent.tsx`
- Test: `src/components/dashboard/__tests__/DashboardContent.test.tsx`

- [ ] **Step 1: Update imports in `DashboardContent.tsx`**

Change the React import line:
```tsx
import { useEffect, useRef, useState } from 'react';
```
to:
```tsx
import { useEffect } from 'react';
```

Remove these import lines:
```tsx
import { KpiCards } from '@/components/dashboard/kpi/KpiCards';
```
(already removed in a prior change — skip if absent)
```tsx
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';
import { useNeedsActionHashScroll } from '@/hooks/useNeedsActionHashScroll';
```

Add these import lines (next to the other kpi imports):
```tsx
import { VelocityCard } from '@/components/dashboard/kpi/VelocityCard';
import { RankingCard } from '@/components/dashboard/kpi/RankingCard';
import { IntelligenceBriefCard } from '@/components/dashboard/kpi/IntelligenceBriefCard';
```

- [ ] **Step 2: Remove the scroll machinery in `DashboardOperationalContent`**

Delete these lines (the reviews ref, tab state, and hash hook):
```tsx
  const reviewsRef = useRef<HTMLDivElement | null>(null);
  const [initialTab, setInitialTab] = useState<'needs' | 'all'>('needs');

  useNeedsActionHashScroll(reviewsRef, () => setInitialTab('needs'));
```

Delete the `isReadOnly` line (now unused after the render change in Step 4):
```tsx
  const isReadOnly = pastDueData?.isReadOnly ?? false;
```

Delete the `scrollToReviews` function:
```tsx
  function scrollToReviews() {
    if (reviewsRef.current) {
      const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }
```

- [ ] **Step 3: Replace the zone render (strip + reviews + trend) with the Editorial Stack**

Replace this block:
```tsx
        {/* Zone 2 — pending approvals strip */}
        <div className="section-enter section-enter-3">
          <PendingApprovalsStrip
            count={reputation.pendingApprovalCount}
            onReview={isReadOnly ? undefined : scrollToReviews}
          />
        </div>
        {/* Zone 3 — needs-action reviews */}
        <div className="section-enter section-enter-4">
          <ReviewsCard
            recentReviews={recentReviews}
            onActionSuccess={() => { void refresh(); }}
            ref={reviewsRef}
            initialTab={initialTab}
            readOnly={isReadOnly}
          />
        </div>
        {/* Zone 4 — reputation trend */}
        <div className="section-enter section-enter-5">
          <ReputationTrendChart trend={reputation.trend} />
        </div>
```
with:
```tsx
        {/* Action strip → Reviews page */}
        <div className="section-enter section-enter-3">
          <PendingApprovalsStrip count={reputation.pendingApprovalCount} />
        </div>
        {/* Intelligence brief */}
        {activeData.latestBrief && (
          <div className="section-enter section-enter-4">
            <IntelligenceBriefCard brief={activeData.latestBrief} />
          </div>
        )}
        {/* Reputation trend */}
        <div className="section-enter section-enter-5">
          <ReputationTrendChart trend={reputation.trend} />
        </div>
        {/* Insights — review velocity + local ranking */}
        <div className="chart-row section-enter section-enter-6">
          <VelocityCard reviewVelocity={activeData.reviewVelocity} />
          <RankingCard ranking={activeData.ranking} />
        </div>
```

- [ ] **Step 4: Remove the obsolete hash-scroll-timer test**

In `src/components/dashboard/__tests__/DashboardContent.test.tsx`, delete the entire `it('clears the deferred needs-action hash scroll timer on unmount', ...)` test block (it asserted behavior of the removed `useNeedsActionHashScroll`).

- [ ] **Step 5: Typecheck + run dashboard tests**

Run: `pnpm typecheck`
Expected: clean (no unused `useRef`/`useState`/`recentReviews`-via-ReviewsCard references; `recentReviews` is still used by the `reputation` fallback filter, so it stays in the destructure).

Run: `pnpm vitest run src/components/dashboard/__tests__/DashboardContent.test.tsx`
Expected: PASS (remaining announcement/loading/redirect tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/DashboardContent.tsx src/components/dashboard/__tests__/DashboardContent.test.tsx
git commit -m "feat(dashboard): merge insights into the overview; remove reviews from the dashboard"
```

---

## Task 4: Aggregate (All Locations) — same rule

**Files:**
- Modify: `src/components/dashboard/kpi/ValueKpiGrid.tsx`
- Modify: `src/components/dashboard/aggregate/AggregateKpiCards.tsx`
- Modify: `src/components/dashboard/aggregate/AggregateDashboardContent.tsx`
- Test: `src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx`

- [ ] **Step 1: Remove the pending tile from `ValueKpiGrid.tsx`**

Replace the `ValueKpiGridProps` interface:
```tsx
interface ValueKpiGridProps {
  valueSummary: ValueSummary;
  pendingCount: number;
  reviewsHandledFoot: string;
  timeSavedFoot: string;
  onScrollToReviews: () => void;
}
```
with:
```tsx
interface ValueKpiGridProps {
  valueSummary: ValueSummary;
  reviewsHandledFoot: string;
  timeSavedFoot: string;
}
```

Replace the destructure:
```tsx
export function ValueKpiGrid({
  valueSummary,
  pendingCount,
  reviewsHandledFoot,
  timeSavedFoot,
  onScrollToReviews,
}: ValueKpiGridProps) {
```
with:
```tsx
export function ValueKpiGrid({
  valueSummary,
  reviewsHandledFoot,
  timeSavedFoot,
}: ValueKpiGridProps) {
```

Delete the `showPending` line:
```tsx
  const showPending = pendingCount > 0;
```

Change the grid container:
```tsx
    <div className={cn('kpi-grid', showPending && 'has-pending')}>
```
to:
```tsx
    <div className="kpi-grid">
```

Delete the entire pending tile block:
```tsx
      {showPending && (
        <div className="kpi pending">
          <div className="kpi-eyebrow">
            <Icon name="alert" size={14} /> Pending approvals
          </div>
          <div className="kpi-value">{pendingCount}</div>
          <button type="button" className="scroll-link" onClick={onScrollToReviews}>
            Review now <Icon name="scroll-down" size={12} />
          </button>
        </div>
      )}
```

- [ ] **Step 2: Update `AggregateKpiCards.tsx`**

Replace the entire file body with:
```tsx
'use client';

import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { ValueKpiGrid } from '@/components/dashboard/kpi/ValueKpiGrid';

interface Props {
  valueSummary: AggregateDashboardData['valueSummary'];
  activeLocationCount: number;
}

export function AggregateKpiCards({ valueSummary, activeLocationCount }: Props) {
  return (
    <ValueKpiGrid
      valueSummary={valueSummary}
      reviewsHandledFoot={`across ${activeLocationCount} location${activeLocationCount !== 1 ? 's' : ''}`}
      timeSavedFoot="total across all locations"
    />
  );
}
```

- [ ] **Step 3: Rework `AggregateDashboardContent.tsx`**

Remove these imports:
```tsx
import { useEffect, useRef } from 'react';
```
→ replace with:
```tsx
import { useEffect } from 'react';
```

Remove:
```tsx
import { AggregateReviewsCard } from '@/components/dashboard/aggregate/AggregateReviewsCard';
import { useNeedsActionHashScroll } from '@/hooks/useNeedsActionHashScroll';
```

Add:
```tsx
import { PendingApprovalsStrip } from '@/components/dashboard/kpi/PendingApprovalsStrip';
```

Delete the refs, hash hook, and scroll function:
```tsx
  const reviewsRef = useRef<HTMLDivElement | null>(null);
  // The "needs" tab intent is recorded but never read on the render path, so a
  // ref avoids the no-op re-render a state setter would queue when the hash
  // scroll fires.
  const initialTabRef = useRef<'needs' | 'all'>('needs');

  useNeedsActionHashScroll(reviewsRef, () => { initialTabRef.current = 'needs'; });
```
and:
```tsx
  function scrollToReviews() {
    if (reviewsRef.current) {
      const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }
```

Replace the `AggregateKpiCards` render:
```tsx
            <div className="section-enter section-enter-1">
              <AggregateKpiCards
                valueSummary={data.valueSummary}
                pendingCount={pendingCount}
                activeLocationCount={data.activeLocationCount}
                onScrollToReviews={scrollToReviews}
              />
            </div>
```
with the KPI cards followed by the action strip:
```tsx
            <div className="section-enter section-enter-1">
              <AggregateKpiCards
                valueSummary={data.valueSummary}
                activeLocationCount={data.activeLocationCount}
              />
            </div>
            <div className="section-enter section-enter-2">
              <PendingApprovalsStrip count={pendingCount} />
            </div>
```

Replace the `LocationKpiStrip` wrapper (renumber to section-enter-3):
```tsx
            <div className="section-enter section-enter-2">
              <LocationKpiStrip locationKpis={data.locationKpis} />
            </div>
```
with:
```tsx
            <div className="section-enter section-enter-3">
              <LocationKpiStrip locationKpis={data.locationKpis} />
            </div>
```

Delete the entire reviews block:
```tsx
            <div className="section-enter section-enter-3">
              <AggregateReviewsCard
                recentReviews={data.recentReviews}
                onActionSuccess={() => { void refresh(); }}
                ref={reviewsRef}
                readOnly={data.isReadOnly ?? false}
              />
            </div>
```

(The remaining `AggregateVelocityCard` / `AggregateRankingCard` / `AggregateIntelligenceBriefCard` blocks keep their existing `section-enter-4/5/6` numbers — leave them as-is.)

Note: `pendingCount`, `setPendingCount`, and the `useEffect` that pushes it stay (the strip and the nav badge still need the count). `refresh` is still used by the velocity card toggle / TopBar.

- [ ] **Step 4: Replace the aggregate composition test**

Replace the entire body of `src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx` with:

```tsx
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';

vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/contexts/PendingCountContext', () => ({
  useSetPendingCount: () => () => {},
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { AggregateDashboardContent } from '@/components/dashboard/aggregate/AggregateDashboardContent';

const data: AggregateDashboardData = {
  scope: 'aggregate',
  valueSummary: { totalReviewsHandled: 12, totalTimeSavedMinutes: 84, currentResponseRate: 90, baselineResponseRate: null },
  reviewVelocity: [],
  perLocationVelocity: [],
  ranking: null,
  perLocationRanking: [],
  recentReviews: [],
  perLocationBriefs: [],
  locationKpis: [],
  activeLocationCount: 2,
};

describe('AggregateDashboardContent', () => {
  it('renders the action strip linking to the Reviews page and no review feed', () => {
    render(<AggregateDashboardContent data={data} refresh={vi.fn()} />);
    // Caught up (0 pending) → "View all reviews" link to the Reviews page.
    expect(screen.getByRole('link', { name: /view all reviews/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
    // The combined review feed no longer lives on the dashboard.
    expect(screen.queryByText(/needs action/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run typecheck + the aggregate tests**

Run: `pnpm typecheck`
Expected: clean.

Run: `pnpm vitest run src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx src/components/dashboard/aggregate/__tests__/AggregateReviewsCard.test.tsx`
Expected: PASS (AggregateReviewsCard's own test is unaffected — the component is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/kpi/ValueKpiGrid.tsx src/components/dashboard/aggregate/AggregateKpiCards.tsx src/components/dashboard/aggregate/AggregateDashboardContent.tsx src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx
git commit -m "feat(dashboard): apply overview/reviews split to the multi-location aggregate view"
```

---

## Task 5: Navigation — Reviews replaces Insights/Needs-Action

**Files:**
- Modify: `src/components/dashboard/shell/Sidebar.tsx`
- Modify: `src/components/dashboard/shell/MobileTabBar.tsx`
- Test: `src/components/dashboard/__tests__/Sidebar.test.tsx`
- Test: `src/components/dashboard/__tests__/MobileTabBar.test.tsx`

- [ ] **Step 1: Update the Sidebar test**

In `src/components/dashboard/__tests__/Sidebar.test.tsx`, add an assertion to the first test (`renders brand, nav items, ...`) after the `dashboard` link assertion:
```tsx
    expect(screen.getByRole('link', { name: /reviews/i })).toBeInTheDocument();
```
And add a new test after `marks active nav item based on usePathname`:
```tsx
  it('renders the Reviews nav item (Insights removed)', () => {
    render(
      wrapWithProvider(
        <Sidebar
          businessName="Coffee Co"
          ownerName=""
          ownerEmail="a@b.co"
          pastRepliesEnabled
          editRepliesEnabled={false}
        />,
      ),
    );
    expect(screen.getByRole('link', { name: /reviews/i })).toHaveAttribute('href', '/dashboard/reviews');
    expect(screen.queryByRole('link', { name: /insights/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the Sidebar test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/__tests__/Sidebar.test.tsx`
Expected: FAIL (Insights link still present; no Reviews link).

- [ ] **Step 3: Update `Sidebar.tsx`**

Add the pending-count import near the other context imports:
```tsx
import { usePendingCount } from '@/contexts/PendingCountContext';
```

Inside the component, add (next to `const { isMultiLocation } = useLocationScope();`):
```tsx
  const pendingCount = usePendingCount();
```

Replace the active-state block:
```tsx
  const isInsights = pathname.startsWith('/dashboard/insights');
  const isDashboard =
    pathname === '/dashboard' ||
    (pathname.startsWith('/dashboard/') &&
      !pathname.startsWith('/dashboard/past-replies') &&
      !pathname.startsWith('/dashboard/insights'));
  const isPastReplies = pathname.startsWith('/dashboard/past-replies');
  const isSettings = pathname.startsWith('/settings');
```
with:
```tsx
  const isReviews = pathname.startsWith('/dashboard/reviews');
  const isDashboard =
    pathname === '/dashboard' ||
    (pathname.startsWith('/dashboard/') &&
      !pathname.startsWith('/dashboard/past-replies') &&
      !pathname.startsWith('/dashboard/reviews'));
  const isPastReplies = pathname.startsWith('/dashboard/past-replies');
  const isSettings = pathname.startsWith('/settings');
```

Replace the Insights nav link:
```tsx
        <Link href="/dashboard/insights" className={`nav-item ${isInsights ? 'active' : ''}`}>
          <Icon name="chart" /> Insights
        </Link>
```
with the Reviews link (badge after the label):
```tsx
        <Link href="/dashboard/reviews" className={`nav-item ${isReviews ? 'active' : ''}`}>
          <Icon name="inbox" /> Reviews
          {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
        </Link>
```

- [ ] **Step 4: Run the Sidebar test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/__tests__/Sidebar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Rewrite the MobileTabBar test**

Replace the entire body of `src/components/dashboard/__tests__/MobileTabBar.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileTabBar } from '@/components/dashboard/shell/MobileTabBar';

const { pathnameMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn<() => string>(() => '/dashboard'),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/contexts/PendingCountContext', () => ({
  usePendingCount: () => 0,
}));

const linkByName = (name: RegExp) => screen.getByRole('link', { name });

describe('MobileTabBar', () => {
  it('renders Home, Reviews, History, Settings (no Insights/Needs Action)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/home/i)).toHaveAttribute('href', '/dashboard');
    expect(linkByName(/reviews/i)).toHaveAttribute('href', '/dashboard/reviews');
    expect(linkByName(/history/i)).toBeInTheDocument();
    expect(linkByName(/settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /insights/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /needs action/i })).not.toBeInTheDocument();
  });

  it('marks Home active on /dashboard', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/home/i)).toHaveClass('active');
    expect(linkByName(/reviews/i)).not.toHaveClass('active');
  });

  it('marks Reviews active on /dashboard/reviews', () => {
    pathnameMock.mockReturnValue('/dashboard/reviews');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/reviews/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('marks History active on /dashboard/past-replies', () => {
    pathnameMock.mockReturnValue('/dashboard/past-replies');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/history/i)).toHaveClass('active');
  });

  it('labels the nav and marks the active tab aria-current=page', () => {
    pathnameMock.mockReturnValue('/dashboard/reviews');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(screen.getByRole('navigation', { name: /dashboard/i })).toBeInTheDocument();
    expect(linkByName(/reviews/i)).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/settings/i)).not.toHaveAttribute('aria-current');
  });
});
```

- [ ] **Step 6: Run the MobileTabBar test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/__tests__/MobileTabBar.test.tsx`
Expected: FAIL (Insights/Needs-Action tabs still present; no Reviews tab).

- [ ] **Step 7: Rewrite `MobileTabBar.tsx`**

Replace the entire file body with:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/dashboard/shell/Icon';
import { usePendingCount } from '@/contexts/PendingCountContext';

interface Props {
  pastRepliesEnabled: boolean;
  /** Server-authoritative — requires pastRepliesEnabled. Read at layout level. */
  editRepliesEnabled?: boolean;
}

export function MobileTabBar({ pastRepliesEnabled }: Props) {
  const pathname = usePathname() ?? '';
  const pendingCount = usePendingCount();

  const isHome = pathname === '/dashboard';
  const isReviews = pathname.startsWith('/dashboard/reviews');
  const isHistory = pathname === '/dashboard/past-replies';
  const isSettings = pathname.startsWith('/settings');

  return (
    <nav className="mobile-tabbar" aria-label="Dashboard">
      <Link
        href="/dashboard"
        className={`mtab ${isHome ? 'active' : ''}`}
        aria-current={isHome ? 'page' : undefined}
      >
        <Icon name="home" size={22} /> Home
      </Link>
      <Link
        href="/dashboard/reviews"
        className={`mtab ${isReviews ? 'active' : ''}`}
        aria-current={isReviews ? 'page' : undefined}
      >
        <Icon name="inbox" size={22} /> Reviews
        {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
      </Link>
      {pastRepliesEnabled && (
        <Link
          href="/dashboard/past-replies"
          className={`mtab ${isHistory ? 'active' : ''}`}
          aria-current={isHistory ? 'page' : undefined}
        >
          <Icon name="history" size={22} /> History
        </Link>
      )}
      <Link
        href="/settings"
        className={`mtab ${isSettings ? 'active' : ''}`}
        aria-current={isSettings ? 'page' : undefined}
      >
        <Icon name="cog" size={22} /> Settings
      </Link>
    </nav>
  );
}
```

- [ ] **Step 8: Run the MobileTabBar test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/__tests__/MobileTabBar.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add src/components/dashboard/shell/Sidebar.tsx src/components/dashboard/shell/MobileTabBar.tsx src/components/dashboard/__tests__/Sidebar.test.tsx src/components/dashboard/__tests__/MobileTabBar.test.tsx
git commit -m "feat(nav): replace Insights/Needs-Action with a Reviews item carrying the pending badge"
```

---

## Task 6: Delete the Insights route + dead hook

**Files:**
- Delete: `src/app/(authenticated)/dashboard/insights/page.tsx`
- Delete: `src/components/dashboard/insights/InsightsContent.tsx`
- Delete: `src/hooks/useNeedsActionHashScroll.ts`

- [ ] **Step 1: Confirm no remaining references**

Run:
```bash
rg -n "useNeedsActionHashScroll|dashboard/insights|insights/InsightsContent|InsightsContent" src
```
Expected: no matches (all consumers removed in Tasks 3–5). If any remain, fix them before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm src/app/\(authenticated\)/dashboard/insights/page.tsx \
       src/components/dashboard/insights/InsightsContent.tsx \
       src/hooks/useNeedsActionHashScroll.ts
```

- [ ] **Step 3: Clear the stale Next types cache + typecheck**

Run:
```bash
rm -rf .next/types && pnpm typecheck
```
Expected: clean (a stale `.next/types` entry for the deleted `insights/page` would otherwise error).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(dashboard): remove the merged Insights route and dead hash-scroll hook"
```

---

## Task 7: Full gates + manual verification

- [ ] **Step 1: Run the full gate suite**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build && \
pnpm ci:static-policy && pnpm ci:analytics-events && pnpm ci:tenant-scope && pnpm ci:rls-audit
```
Expected: all pass. `pnpm build` should register `ƒ /dashboard/reviews` and NOT `/dashboard/insights`.

- [ ] **Step 2: Manual smoke (local or staging)**

- `/dashboard`: hero → action strip → intelligence brief → reputation trend → velocity + ranking. No reviews feed. Strip "Review now"/"View all reviews" navigates to `/dashboard/reviews`.
- `/dashboard/reviews`: the Needs Action / All Recent feed with approve/edit/regenerate.
- Sidebar shows Reviews (with badge when pending > 0); no Insights. Mobile tabs: Home/Reviews/History/Settings.
- Multi-location "All Locations": aggregate KPIs + action strip + location strip + insights; no review feed on the dashboard; `/dashboard/reviews` shows the combined feed.

- [ ] **Step 3: Push branch + deploy to staging**

```bash
git push -u origin redesign/dashboard-overview-reviews-split
git push origin redesign/dashboard-overview-reviews-split:staging
```

---

## Self-Review

**Spec coverage:**
- Nav (Sidebar + MobileTabBar, Insights removed, Reviews added, badge) → Task 5. ✓
- Dashboard Editorial Stack (hero, strip, brief, trend, velocity+ranking) → Task 3. ✓
- New `/dashboard/reviews` (per-location + aggregate) → Task 2. ✓
- Action strip links to Reviews in both states → Task 1. ✓
- Aggregate same rule (review feed → Reviews page; strip on dashboard) → Task 4. ✓
- No backend changes → confirmed (shared `useDashboardData`). ✓
- Cleanup (delete Insights route/component + hash hook) → Task 6. ✓
- Pending count/badge moves to Reviews → Tasks 2, 5. ✓
- Testing → each task includes test updates; Task 7 runs full gates. ✓

**Type consistency:** `ReviewsContent` reuses `ReviewsCard`/`AggregateReviewsCard` with their existing prop shapes (`recentReviews`, `onActionSuccess`, `initialTab`, `readOnly`). `AggregateKpiCards` and `ValueKpiGrid` prop drops match their call sites. `PendingApprovalsStrip` prop reduced to `{ count }` and both call sites (Task 3 dashboard, Task 4 aggregate) pass only `count`.

**Placeholder scan:** none — every code step shows full content or exact old→new replacement.

**Edge cases:** `ReviewsContent` handles loading/error/aggregate/non-active/read-only; `IntelligenceBriefCard` is wrapped in `activeData.latestBrief &&`; `RankingCard` self-guards empty ranking.

## Out of scope / future

- Reviews-only API endpoint (perf optimization).
- Cross-location reputation hero on the aggregate dashboard (needs backend aggregation).
- Re-theming the velocity/ranking chart series colors (sanctioned data-viz exception, allowlisted in the palette guard) — leave as-is.
