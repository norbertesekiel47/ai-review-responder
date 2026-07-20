-- supabase/migrations/082_failover_lookup_indexes.sql
--
-- IMPORTANT: this file uses CREATE INDEX CONCURRENTLY, which cannot run
-- inside a transaction. Apply non-transactionally — uncheck the
-- "single transaction" box in the Supabase SQL editor. The two statements
-- are NOT atomic: the first can succeed and the second fail, leaving the
-- migration half-applied. Apply staging first, then production, both
-- Supabase projects in lockstep.
--
-- RECOVERY (interrupted CONCURRENTLY build — 062 lesson): a failed build
-- leaves an INVALID index behind, and `IF NOT EXISTS` silently skips it on
-- re-run ("applied" but never used by the planner). After applying, check:
--   SELECT indexrelid::regclass AS index, indisvalid
--     FROM pg_index
--     WHERE indexrelid::regclass::text IN
--       ('idx_jo_send_notification_by_aggregate',
--        'idx_responses_pending_approval_created');
--   -- expect: indisvalid = true for both.
-- If indisvalid = false for either, DROP INDEX CONCURRENTLY <name>; then
-- re-run this migration.

-- ─── Failover correlation lookup ───────────────────────────────────────────
-- Used by worker/background/pollers/NotificationFailoverPoller.ts
-- (recoverFailoverCorrelationId):
--   SELECT payload->>'correlation_id' FROM job_outbox
--   WHERE topic = 'send_notification' AND aggregate_id = <response_id>
--   ORDER BY created_at DESC LIMIT 1
-- Exact mirror of 018's idx_jo_generate_response_by_review for the
-- generate_response twin of this lookup. Partial index keeps it scoped to
-- send_notification rows; DESC ordering matches the query so the LIMIT 1 is
-- a single index lookup, not a scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jo_send_notification_by_aggregate
  ON job_outbox (aggregate_id, created_at DESC)
  WHERE topic = 'send_notification';

-- ─── Global pending_approval sweeps ────────────────────────────────────────
-- Used by the two NotificationFailoverPoller.ts sweeps (all-failed and
-- stale), which both filter
--   WHERE resp.status = 'pending_approval'
--     AND resp.created_at < NOW() - INTERVAL '4 hours'
--   ORDER BY resp.created_at ASC LIMIT <batch>
-- across ALL tenants (no account/business scope). Without this index every
-- poll cycle scans all responses rows. The partial predicate keeps the index
-- to the (small, transient) pending_approval set; created_at serves both the
-- range filter and the ORDER BY. The sweeps' joins/EXISTS subqueries don't
-- invalidate index use — responses is the driving relation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_responses_pending_approval_created
  ON responses (created_at)
  WHERE status = 'pending_approval';
