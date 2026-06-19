# Dashboard → Overview, Reviews → Its Own Page

**Date:** 2026-06-19
**Status:** Design (awaiting approval)
**Author:** Norbert + Claude

## Context & rationale

RepWorth is notification-driven: the owner approves drafts from WhatsApp/email
links and rarely visits the dashboard. When they *do* visit, the dashboard
should be a calm **overview of what RepWorth has been doing for them** — ROI,
reputation, the intelligence brief, and insights — not a work queue.

Today the authenticated area splits this awkwardly:

- **Dashboard** (`/dashboard`) shows a 4-zone landing: reputation hero, a
  pending-approvals strip, the **reviews action queue**, and a reputation trend.
- **Insights** (`/dashboard/insights`) shows the secondary analytics: review
  velocity, local ranking, intelligence brief.

The reviews action queue sitting on the dashboard makes it feel like a to-do
list, and the value/insights story is split across two pages. This redesign
merges Insights into the dashboard and moves the reviews queue to its own page.

> **Supersedes** the `PLAN.md` PR2 decision to relocate secondary analytics to
> `/dashboard/insights`. That page is merged back into the dashboard; the reviews
> queue (which PR2 kept on the dashboard) moves off it instead. The earlier
> principle — "dashboard is a reputation/ROI overview, not an action queue" —
> is preserved and taken further.

## Goals

- The **dashboard is the single overview**: reputation/ROI + brief + trend +
  velocity + ranking, all in one place.
- The **reviews action queue lives on its own page** (`/dashboard/reviews`),
  reachable from the nav and from the dashboard's action strip.
- One consistent rule across single-location **and** multi-location aggregate
  views: reviews are never on the dashboard; the dashboard always carries an
  "action or not" strip with an arrow to Reviews.

## Non-goals

- No backend / API changes. `/api/dashboard` already returns reputation,
  velocity, ranking, brief, and reviews. This is a frontend recomposition.
- No change to Past Replies (stays a separate page — the posted-reply archive).
- No change to the Warm Editorial visual system (bezels, gold stars, grain).
- No change to notification/approval link flows.

## Information architecture

### Navigation

**Sidebar** (`Sidebar.tsx`): Dashboard · **Reviews** · Past Replies · Settings.
- *Insights* item removed.
- *Reviews* item added, with a pending-count badge (parity with mobile).
- Active-state logic updated so `/dashboard/reviews` highlights **Reviews**, not
  Dashboard (today `isDashboard` matches any `/dashboard/*` except past-replies
  and insights — add a `reviews` exclusion + an `isReviews` branch).

**Mobile tab bar** (`MobileTabBar.tsx`): Home · **Reviews** · History · Settings.
- Replaces today's 5 tabs (Home / Insights / Needs Action / History / Settings).
- The `#needs-action` hash + `useSyncExternalStore` hash machinery is removed;
  the Reviews tab is a plain route link carrying the pending badge.

### Routes

- **New:** `(authenticated)/dashboard/reviews/page.tsx` → `/dashboard/reviews`
  (sibling of `/dashboard/past-replies`, keeping the URL family coherent and the
  authenticated layout/data context).
- **Deleted:** `(authenticated)/dashboard/insights/page.tsx` and
  `src/components/dashboard/insights/InsightsContent.tsx`.

## Dashboard composition

### Single-location (Editorial Stack — all full-width, priority order)

`DashboardContent.tsx`, active per-location branch:

1. Conditional banners (past-due, connect-Google) — unchanged.
2. **ReputationHeroBand** (reputation / ROI).
3. **PendingApprovalsStrip** — action strip with arrow → `/dashboard/reviews`.
4. **IntelligenceBriefCard** (full-width).
5. **ReputationTrendChart** (full-width).
6. **VelocityCard + RankingCard** (two-column `.chart-row`).

`VelocityCard`, `RankingCard`, `IntelligenceBriefCard` already exist (today
rendered by `InsightsContent`); they are simply rendered by the dashboard now.

`ReviewsCard` is **removed** from the dashboard. The same-page scroll machinery
goes with it: `reviewsRef`, `scrollToReviews`, `initialTab`, and
`useNeedsActionHashScroll`.

### Multi-location aggregate ("All Locations")

`AggregateDashboardContent.tsx`, following the same rule:

1. Conditional banners (past-due) — unchanged.
2. **AggregateKpiCards** (summed values) — the aggregate "headline."
3. **PendingApprovalsStrip** — action strip (cross-location pending count),
   arrow → `/dashboard/reviews`. Reuses the same component.
4. **LocationKpiStrip** (per-location cards).
5. **AggregateVelocityCard**.
6. **AggregateRankingCard**.
7. **AggregateIntelligenceBriefCard**.

`AggregateReviewsCard` is **removed** from the aggregate dashboard (moves to the
Reviews page). `AggregateKpiCards` loses its `onScrollToReviews` CTA (no reviews
on the page); the action strip is the single "needs approval" signal. The
`useNeedsActionHashScroll` usage here is removed too.

> The aggregate dashboard keeps its own components (it has no single reputation
> hero — reputation can't be summed meaningfully across locations without new
> backend work, which is out of scope). "Consistent" means the **rule** is the
> same: reviews off the dashboard, an action strip with an arrow on it.

## The action strip (`PendingApprovalsStrip.tsx`)

- Becomes a **link** to `/dashboard/reviews` in **both** states, replacing the
  `onReview` scroll callback:
  - **Active** ("{n} drafts need your approval"): primary "Review now →" links
    to `/dashboard/reviews`.
  - **Calm** ("You're all caught up"): gains a right-arrow affordance linking to
    `/dashboard/reviews` (always a doorway to the full queue).
- Read-only (past-due) accounts still get the link — the Reviews page is
  readable; write actions remain disabled there.
- Prop change: drop `onReview?: () => void`; the link target is fixed. (Both
  call sites — single-location and aggregate — stop passing a scroll callback.)

## The Reviews page

`(authenticated)/dashboard/reviews/page.tsx` renders a new thin client wrapper
`ReviewsContent.tsx` (mirrors the `InsightsContent` pattern):

- Uses `useDashboardData(currentScope)` (same cached hook — see Data flow).
- **Per-location scope:** renders the existing `ReviewsCard` (Needs Action /
  All Recent tabs + approve/edit/regenerate feed). Defaults to the Needs Action
  tab.
- **Aggregate scope:** renders the existing `AggregateReviewsCard` (combined
  feed with per-location chips).
- Handles loading / error / non-active subscription states with the same
  graceful patterns the dashboard uses (e.g. cancelled/pending screens are not
  applicable here — those redirect at the dashboard; the Reviews page shows a
  read-only feed for past-due and an empty state when there are no reviews).
- `TopBar` title "Reviews".

## Pending count & badges

`PendingCountProvider` already wraps the authenticated layout and is seeded
server-side via `getPendingApprovalCount`. After this change:

- The badge renders on the **Reviews** nav item (sidebar + mobile) instead of
  the mobile "Needs Action" tab.
- Dashboard and Reviews pages continue to push the live count to the context on
  data refresh (single source: the `pendingApprovalCount` from the dashboard
  payload / aggregate recentReviews). No new computation.

## Data flow — no backend changes

`/api/dashboard` returns the full payload (reputation, velocity, ranking, brief,
reviews) for both per-location and aggregate scope. Both the Dashboard and
Reviews pages call `useDashboardData(scope)`, which is cached by scope, so:

- Visiting Dashboard then Reviews reuses the cached payload (no second fetch).
- Landing directly on Reviews fetches once.

The Reviews page reads only the reviews portion of that payload; the extra
reputation fields it ignores are already computed and cheap to carry. (A
lighter, reviews-only endpoint is a possible future optimization, not needed
now.)

## Components: new / modified / deleted

**New**
- `(authenticated)/dashboard/reviews/page.tsx`
- `src/components/dashboard/reviews/ReviewsContent.tsx`

**Modified**
- `DashboardContent.tsx` — Editorial Stack: add brief/trend/velocity/ranking,
  remove ReviewsCard + scroll machinery, strip links to Reviews.
- `AggregateDashboardContent.tsx` — remove AggregateReviewsCard + scroll, add
  action strip, drop KPI scroll CTA.
- `PendingApprovalsStrip.tsx` — link to `/dashboard/reviews` in both states.
- `Sidebar.tsx` — Insights → Reviews (+ badge), active-state logic.
- `MobileTabBar.tsx` — Insights/Needs-Action → Reviews (+ badge), remove hash
  machinery.
- `AggregateKpiCards.tsx` — drop `onScrollToReviews`.

**Deleted**
- `(authenticated)/dashboard/insights/page.tsx`
- `src/components/dashboard/insights/InsightsContent.tsx`
- `src/hooks/useNeedsActionHashScroll.ts` (after confirming no other consumers)

## Edge cases

- **Ramping / young account:** dashboard hero already renders compact; brief may
  be absent (omit its block); trend shows its empty state. Reviews page shows
  the "all caught up" empty state.
- **Read-only (past-due):** strip + Reviews page render; write actions disabled.
- **No reviews:** Reviews page shows the existing "all caught up" empty state.
- **Aggregate empty:** aggregate dashboard keeps its existing empty state; the
  Reviews page shows the aggregate empty feed.
- **Deep links / notifications:** none point to `/dashboard#needs-action`
  (approval flows use `/r/google/<id>` + tokenized links), so removing the hash
  is safe. Confirm during implementation.

## Testing

- **Nav:** Sidebar renders Reviews (not Insights), badge present, correct active
  state for `/dashboard/reviews`. MobileTabBar renders the 4-tab set with the
  Reviews badge.
- **DashboardContent:** composition test asserts brief/trend/velocity/ranking
  present and ReviewsCard absent; strip links to `/dashboard/reviews`.
- **AggregateDashboardContent:** AggregateReviewsCard absent; action strip
  present and linking to Reviews.
- **Reviews page:** renders ReviewsCard (per-location) / AggregateReviewsCard
  (aggregate); loading/error/empty states.
- **PendingApprovalsStrip:** renders a link to `/dashboard/reviews` in both
  active and calm states.
- Remove the obsolete `useNeedsActionHashScroll` test; relocate any ReviewsCard
  interaction tests that assumed the dashboard host.
- Full gates: typecheck, lint, test, build, static-policy, analytics-events,
  tenant-scope, rls-audit.

## Out of scope / future

- A reviews-only API endpoint (perf optimization).
- Giving the aggregate dashboard a true cross-location reputation hero (needs
  backend aggregation of reputation metrics).
- Auth-pages redesign (tracked separately).
