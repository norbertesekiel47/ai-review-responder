# Plan — #405 Real aggregated reviews-by-rating breakdown (windowed)

Branch: `feat/405-reviews-aggregate` (forked off #403 `feat/403-analytics-window-param`).
Base already provides the time-range `window` machinery (`resolveDashboardWindow`,
`WINDOW_PARAMS`, `make_interval(days => $n)` bound-value plumbing). This work builds on it.

## Problem

`RecentRatingBreakdown` derives its 1–5★ bars from the `recentReviews` SAMPLE
(last 10 / last 20) and labels itself "Based on your N most recent reviews." There is
no true aggregate. We need a REAL reviews-by-rating distribution across the selected
#403 window, for BOTH per-location and aggregate scopes, then point the card at it and
drop the "recent sample" caveat.

## Decisions (brainstorm, self-resolved)

1. **Payload location:** add to `/api/dashboard` (NOT `/api/dashboard/kpis`). The card is
   fed from the dashboard payload (`active`/`data`), so the data must live there.
2. **Field shape:** `ratingBreakdown: { counts: { stars; count }[]; total }` — `counts`
   is always 5 entries ordered 5★→1★, zero-filled. The card maps it directly; aggregate
   sums by `stars`. Required field (always populated on every active path) — honest
   contract, mirrors `reviewVelocity`, not the optional `reputationSummary`.
3. **Window:** windowed by `windowDays` from `dashboardWindowParams(window)` — reaches SQL
   ONLY as a bound integer via `make_interval(days => ${windowDays})`. Reuses the exact
   #403 plumbing. `30d` default reproduces a 30-day breakdown.
4. **Per-location SQL:** one cheap `GROUP BY star_rating` query appended to the existing
   `getActiveDashboardData` main `Promise.all`. `star_rating` is `INTEGER CHECK (1..5)` or
   NULL (migration 001) — direct GROUP BY, no rounding. Scoped by `business_id`,
   `status <> 'deleted'`, `star_rating IS NOT NULL`.
5. **Aggregate:** sum the per-location windowed breakdowns (each scoped by `business_id`,
   locations fetched via `getLocationsForAccount` → scoped by `account_id`). Same
   composition pattern as `reviewVelocity`. Tenant-safe on both axes.
6. **Single owner of the bucketing knowledge:** new module
   `src/lib/dashboard/rating-breakdown.ts` owns the 5-tier zero-fill + total
   (`buildRatingBreakdown` from SQL rows, `sumRatingBreakdowns` for aggregate). One place,
   focused tests, no duplication between service / aggregate / card.
7. **reviews-by-source:** issue marks it OPTIONAL. Skipped — no card consumes it; adding a
   payload field with no reader is dead code. Out of scope, noted here.
8. **Card name:** keep `RecentRatingBreakdown` (issue references it by name; only 2
   importers). Update heading → "Reviews by rating", subtitle → "Across N reviews in the
   selected period", and the doc comment. Drop the "most recent" caveat.
9. **Sibling `RecentSentimentMix`:** unchanged — it genuinely uses the recent sample; its
   caveat stays. Behavior-preserving.

## Files to change (ADD on top of #403)

- `src/lib/dashboard/types.ts` — add `RatingBreakdown` type; add required
  `ratingBreakdown` to `DashboardDataActive` + `AggregateDashboardData`.
- `src/lib/dashboard/rating-breakdown.ts` (NEW) — `buildRatingBreakdown`,
  `sumRatingBreakdowns`, private `RATING_TIERS`/`fromStarMap`.
- `src/lib/dashboard/service.ts` — append windowed GROUP BY query to main batch; pass rows
  through (keeps existing sql call indices 1–11 unchanged; new query is index 12).
- `src/lib/dashboard/service-mappers.ts` — accept `ratingBreakdownRows`, set
  `ratingBreakdown` via `buildRatingBreakdown`.
- `src/lib/dashboard/aggregate-service.ts` — set `ratingBreakdown` via
  `sumRatingBreakdowns` (both the empty-locations early return and the main path).
- `src/components/dashboard/kpi/RecentRatingBreakdown.tsx` — consume `breakdown` prop,
  drop caveat, new heading/subtitle/doc.
- `src/components/dashboard/analytics/AnalyticsPerLocationView.tsx` +
  `AnalyticsAggregateView.tsx` — pass `breakdown={...ratingBreakdown}`; gate the row on
  `ratingBreakdown.total > 0 || hasRatedReviews` (sentiment mix still uses recentReviews).

## Tests (TDD)

- `src/lib/dashboard/__tests__/rating-breakdown.test.ts` (NEW) — build zero-fills/orders
  5→1; out-of-range ignored; sum is element-wise; empty → all-zero/total 0.
- `src/lib/dashboard/__tests__/service.rating-breakdown.test.ts` (NEW) — per-location:
  correct 1–5 counts; scoped by `business_id`; windowed via bound `make_interval(days => ?)`
  (not interpolated text); honors 7d/90d.
- `src/lib/dashboard/__tests__/aggregate-service.test.ts` — extend `locationData` with a
  breakdown; new case: aggregate sums per-location breakdowns (tenant-scoped via account
  locations).
- `src/app/api/dashboard/__tests__/route.test.ts` — new case: active payload carries
  `ratingBreakdown` (counts 5→1, total), windowed.
- `src/components/dashboard/analytics/__tests__/AnalyticsContent.test.tsx` — update
  fixtures + assertions to the new heading/subtitle and `ratingBreakdown` source.
- Fix required-field literal fixtures: `aggregate-types.test.ts`,
  `AggregateDashboardContent.test.tsx`.

## Verify gate

`pnpm lint && pnpm typecheck && pnpm test` · `pnpm ci:tenant-scope && pnpm ci:rls-audit`
· `pnpm ci:static-policy` · `pnpm ci:fallow` ("No issues").
