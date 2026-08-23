-- 112_breaker_window_indexes.sql
--
-- #908 (follow-up B3.8 from #898/PR #904): make the Breaker window read model
-- index-servable. `readBreakerWindow` (src/lib/solicitation/send-breaker.ts)
-- runs once per 5-minute HealthAlertPoller tick with a WHERE that is an OR of
-- three predicates:
--
--   sent_at >= GREATEST(signal_floor, reset_floor)
--   OR (sent_at >= reset_floor
--         AND (bounced_at >= signal_floor OR complained_at >= signal_floor))
--
-- Migration 110 shipped ONE partial index (sent_at) and a comment claiming the
-- bounced_at / complained_at numerators are "deliberately unindexed" because
-- "a bitmap scan is cheaper than two more indexes". THAT COMMENT IS WRONG for
-- the statement as shipped: one index cannot serve an OR of three predicates,
-- so the planner falls back to a sequential scan of the WHOLE table — which is
-- append-only and retained, so the scan cost grows without bound while the
-- window stays fixed. 110 is immutable; the correction is recorded here and in
-- docs/superpowers/plans/feat-898-solicitation-send-governors-deviations.md.
--
-- Measured before choosing (the ticket's instruction), PG 16 at 1,000,000 rows
-- with a 35,000-row 7-day window (the top ramp stage):
--
--   before: Parallel Seq Scan — 28,577 buffers, 120.5 ms
--   after:  Parallel Bitmap Heap Scan, BitmapOr over the three partial
--           indexes — 1,139 buffers, 14.2 ms (8.5x)
--
-- The planner decomposes the OR as BitmapOr(sent_at, BitmapOr(bounced_at,
-- complained_at)) with the residual filter applied on the heap, so the QUERY
-- NEEDS NO RESTRUCTURE — the two missing indexes were the whole gap. Both are
-- partial on IS NOT NULL: bounce/complaint rows are a sub-percent fraction of
-- the table, so each index stays tiny and costs almost nothing per send.
--
-- Plain CREATE INDEX (not CONCURRENTLY, which cannot run inside a migration
-- transaction): solicitation_outreach holds 0 rows in staging and production
-- today (#899/#900 have not started sending), so the build is instant and the
-- lock moot.

CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_bounced_at
  ON solicitation_outreach (bounced_at)
  WHERE bounced_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_complained_at
  ON solicitation_outreach (complained_at)
  WHERE complained_at IS NOT NULL;
