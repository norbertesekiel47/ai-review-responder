// src/lib/kpi/fragments.ts
//
// Single owner of the Review-time anchor spelling (#688 ADR 0019, consolidated
// by #757). Extracted from the consumer-less Stack A KPI service — which #757
// then deleted — so the RENDERED dashboard stack (dashboard/service.ts +
// dashboard/aggregate-queries.ts) composes the same bucketing decision instead
// of re-spelling it. fragments.test.ts fails if any non-test source file
// outside this one spells the anchor.
//
// Each factory returns a lazy Postgres.js fragment (a nested sql`` template —
// never awaited on its own; it composes into a caller's template text + bound
// params). Neither spells a FROM/JOIN nor a tenant-scope predicate, so neither
// can hide — or need — a tenant-scope predicate of its own: every caller keeps
// `business_id = `/`account_id = ` written out literally in its own template,
// because scripts/ci/tenant-scope-audit.ts reads only raw, un-evaluated
// template text. Do NOT move a tenant predicate or a FROM/JOIN in here.
//
// NOT A VARIATION SEAM. Nothing varies across this module — it exists for
// LOCALITY of one load-bearing spelling (the openFlagExistsSql precedent,
// #730). Do not add an "anchor strategy", a registry, or an injected clock
// behind it; a second bucketing rule would be a new ADR, not a new branch here.

import type { Sql } from 'postgres';

/** Table alias prefix at a composition site. Callers alias `reviews` as `r`. */
type ReviewsPrefix = '' | 'r.';

/**
 * Review-time anchor (#688, ADR 0019) — the timestamp the reputation KPIs
 * (velocity, rating breakdown, avg star, sentiment trend) bucket on, so a
 * consented Review import lands in its true weeks instead of spiking the
 * import week.
 *
 * LEAST ignores NULLs in Postgres: a NULL review_date falls back to
 * detected_at, and a clock-skewed FUTURE review_date clamps to detected_at
 * (unclamped, a future week silently vanishes from a trend's generate_series
 * LEFT JOIN). The anchor can never exceed detected_at.
 *
 * Workflow KPIs — response rate, the aggregate review counters, the
 * MonthlyImpactWorker digest — deliberately stay on detected_at: imported
 * unanswered reviews are MEANT to drag the rate (#675 nudge reasoning,
 * ADR 0019 D2). Action timestamps (approved_at) never use this.
 */
export function reviewTimeAnchor(sql: Sql, prefix: ReviewsPrefix) {
  return prefix === 'r.'
    ? sql`LEAST(r.review_date, r.detected_at)`
    : sql`LEAST(review_date, detected_at)`;
}

/**
 * Single-sided rolling review-time lookback in DAYS. Two-sided (current vs
 * prior) buckets and week-based lookbacks compose {@link reviewTimeAnchor}
 * directly instead — one fragment per predicate shape, not per call site.
 * The window reaches SQL only as a bound integer via make_interval (#403).
 */
export function reviewTimeWindowFilter(sql: Sql, prefix: ReviewsPrefix, windowDays: number) {
  return sql`${reviewTimeAnchor(sql, prefix)} >= NOW() - make_interval(days => ${windowDays})`;
}
