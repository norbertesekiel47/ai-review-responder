# Plan — #476 Set-based account-dashboard aggregates + windowed counts

Ticket #476 · map #472 · branch `perf/476-set-based-account-aggregates` · RISK=normal · SURFACE=backend
Intake: `.feature/intake.json` (committed) · Glossary terms: **per-location fan-out**, **set-based per-account aggregate**, **windowed account response rate**.

## Problem

`getAggregateDashboardData` runs the full per-location dashboard batch once per active
location (**per-location fan-out**: ~14 queries × N via `mapWithConcurrency`), then composes.
At the capacity target (250 locations) the All-Locations view issues thousands of queries per
render. The two account-wide response-rate counts are also unwindowed `COUNT(*)` scans.

## Design (why byte-identical is provable)

The aggregate view consumes only a **subset** of each location's batch:
`valueSummary.{totalReviewsHandled,totalTimeSavedMinutes,baselineResponseRate}`, `reviewVelocity`,
`ranking`, `ratingBreakdown`, `recentReviews.length`, plus `pendingApprovalCount`. Reproduce
exactly that subset with a fixed **set-based per-account aggregate** wave (`GROUP BY business_id`),
bucket rows by `business_id`, and feed each bucket through the **existing mappers**
(`buildValueSummary`/`getBaselineResponseRate`, `buildRanking`, `buildRatingBreakdown`, brief-picking).
Only the fetch layer changes → retained fields are identical by construction.

Two intentional deltas (signed off): `currentResponseRate` → windowed by the dashboard `window`;
`partialFailures` removed (atomic success/failure, no UI consumer).

Set-based wave (constant query count, independent of N):
1. **Review counters** — one `GROUP BY business_id` over `reviews` LEFT-joined so zero-review
   locations still get a row: `total_responded_all_time` (COUNT FILTER handled-response EXISTS),
   `recent_review_count` = `LEAST(COUNT(non-deleted), 10)`, `received_window`, `responded_window`
   (both `detected_at` in window; responded = handled-response EXISTS). Windowed account rate =
   `sum(responded_window)/sum(received_window)` — equals the old account-wide windowed COUNT
   because locations partition reviews by `business_id`. **Deletes** `getTotalReviewsForAccount`/
   `getTotalRespondedForAccount`.
2. **Velocity** — `GROUP BY business_id, week` with `generate_series` × `businesses` zero-fill,
   windowed (mirror `service.ts` velocity, add `business_id`).
3. **Rating breakdown** — `GROUP BY business_id, star_rating`, windowed → `buildRatingBreakdown` per bucket.
4. **Ranking** — `SELECT business_id, keyword, snapshot_date, rank_position … account-scoped, 12mo`
   → `buildRanking` per bucket.
5. **Latest brief** — latest monthly + latest weekly per `business_id` (DISTINCT ON / LATERAL) → same pick logic.
6. **Baseline columns** — `initial_review_count/initial_responded_count/baseline_captured_at` per
   `business_id` (not on `LocationRow`) for the primary location's `baselineResponseRate`.
7. **Pending counts (plural)** — set-based sibling of `getPendingApprovalCount` in `pending-count.ts`
   (same `pending_approval` + NOT-EXISTS-flagged-open predicate, `GROUP BY business_id`).

Every query scoped `WHERE b.account_id = ${accountId} AND b.archived_at IS NULL`, `rev.status <> DELETED`.

## Tracer tickets

### T1 — Windowed review counters + account rate (folds in the count-windowing)
Add the **review counters** query (#1 above) to a new `src/lib/dashboard/aggregate-queries.ts`,
returning per-`business_id` `{ totalRespondedAllTime, recentReviewCount, receivedWindow, respondedWindow }`.
Delete `getTotalReviewsForAccount`/`getTotalRespondedForAccount` once T3 rewires the caller.
- Tests: windowed received/responded use `detected_at`-in-window (reputationSummary.rate parity);
  account rate = sum of per-location windowed counts; empty-bucket → all-zero row.
- Blocking edges: none.

### T2 — Remaining set-based slice queries + bucketing seam
In `aggregate-queries.ts`, add queries #2–#6 and the bucketing that assembles, per location, a
`PerLocationAggregateSlice` fed through the existing mappers; add the plural pending-count to
`pending-count.ts` (#7). Public interface: `fetchPerLocationAggregateSlices(sql, accountId, locations, window)`.
- Tests: per-bucket slice byte-identical to a mapper reference on a fixture; empty-bucket parity
  (zero-fill velocity, empty rating breakdown, null ranking, null brief); query-count constant.
- Blocking edges: none (independent of T1; both land in the same new module).

### T3 — Rewire `aggregate-service.ts`, remove fan-out + `partialFailures`
Replace the `mapWithConcurrency` fan-out with `fetchPerLocationAggregateSlices` + the counters;
compute `currentResponseRate` from windowed sums; delete `mapWithConcurrency`, the per-location
`getActiveDashboardData`/`getPendingApprovalCount` calls, and the two account-total helpers;
remove `partialFailures` from `types.ts` and simplify the cache gate (always cacheable now).
Rewrite `__tests__/aggregate-service.test.ts` to drive the set-based path.
- Tests: **byte-identical parity** vs a fixture-composed reference for every retained field;
  query-count-constant-vs-N; tenant isolation (foreign `account_id` never contributes);
  #346 authoritative pending-count (>10) + #405 rating rollup retained; `partialFailures` gone.
- Blocking edges: **T1, T2**.

## Verify gate (step 5)
`pnpm lint && pnpm typecheck && pnpm test` + all `ci:*` audits (tenant-scope, rls-audit, db-imports
enforced). No `build` (backend surface). No migration.
