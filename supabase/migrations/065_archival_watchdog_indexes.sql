-- supabase/migrations/065_archival_watchdog_indexes.sql
--
-- IMPORTANT: this file uses CREATE INDEX CONCURRENTLY, which cannot run
-- inside a transaction. Apply non-transactionally — uncheck the
-- "single transaction" box in the Supabase SQL editor. If a statement
-- fails partway it can leave an INVALID index behind; check with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- then DROP INDEX the invalid one and re-run.

-- Deep-scan §3.1: the ArchivalPoller inbound_events DELETE
-- (worker/background/pollers/ArchivalPoller.ts) filters
--   WHERE status = 'processed' AND processed_at < NOW() - INTERVAL '30 days'
-- but the only status index (idx_ie_status, 001_initial_schema.sql) is
-- partial WHERE status != 'processed' — it EXCLUDES exactly the rows the
-- daily cleanup scans for, so cleanup seq-scans the fastest-growing table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ie_archival
  ON inbound_events (processed_at)
  WHERE status = 'processed';

-- Deep-scan §3.3: the OutboxPoller watchdog (worker/background/pollers/
-- OutboxPoller.ts, every poll cycle) filters
--   status = 'dispatched'  AND dispatched_at < NOW() - INTERVAL '1 hour'   (twice)
--   status = 'dispatching' AND (dispatched_at IS NULL OR dispatched_at < NOW() - INTERVAL '2 minutes')
-- idx_jo_pending is partial WHERE status = 'pending' and idx_jo_topic leads
-- with topic — neither serves a bare in-flight status scan. Each watchdog
-- predicate implies this index predicate (status equality narrows the IN
-- list; btree stores NULL dispatched_at rows, covering the IS NULL arm).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jo_recovery
  ON job_outbox (dispatched_at)
  WHERE status IN ('dispatched', 'dispatching');
