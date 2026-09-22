-- 124_admin_outbox_panel_indexes.sql
--
-- #1365 (audit 2026-07-06 item H1) — make the admin jobs panel's `job_outbox`
-- reads index-served. Index-only migration: no table, no column, no
-- constraint, no data, no RLS posture. Purely additive.
--
-- IMPORTANT: this file uses CREATE INDEX CONCURRENTLY, which cannot run inside
-- a transaction. Apply non-transactionally — uncheck the "single transaction"
-- box in the Supabase SQL editor, or run it with plain `psql -f` through the
-- SESSION pooler / direct host (port 5432). Apply to staging first, then prod,
-- in lockstep. If a statement fails partway it can leave an INVALID index
-- behind; check with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- then DROP INDEX the invalid one and re-run. `job_outbox` is the hottest
-- write table in the system (every async workflow inserts and updates it), so
-- the build must not take a write lock.
--
-- THE READS (all in `src/lib/admin/jobs-service.ts`, plus the failed count in
-- `src/lib/admin/overview-service.ts`):
--   a. the failed page    WHERE status = 'failed' [AND topic = $t]
--                         ORDER BY created_at DESC LIMIT/OFFSET
--   b. the failed total   COUNT(*) WHERE status = 'failed' [AND topic = $t]
--   c. the topic options  SELECT DISTINCT topic WHERE status = 'failed'
--   d. the status summary one bounded query, one equality arm per counter —
--                         pending / dispatching / dispatched / failed, and
--                         `status = 'completed' AND completed_at >= CURRENT_DATE`
--
-- Before this file nothing served `status = 'failed'` directly: the partial
-- indexes cover pending (001) and dispatched/dispatching (065), and the only
-- other candidate, 001's `idx_jo_topic (topic, status)`, leads with topic, so
-- an unfiltered failed read walks the WHOLE index and then sorts. And nothing
-- served "completed today" at all, which is why the summary (d) was a
-- sequential scan of a table that is mostly `completed` rows (retention keeps
-- 7 days of them; failed rows 90 days).
--
-- MEASURED, PG 16 local container, temp-table copy of `job_outbox` with every
-- production index: 211,674 completed rows (7 days), 2,000 failed (90 days),
-- 150 in flight. `VACUUM (ANALYZE)` before each side.
--   d. summary      Seq Scan, 3,849 buffers, 41.2 ms
--                   → BitmapOr of five partial-index scans, 99 buffers, 1.0 ms
--   a. failed page  Bitmap scan of idx_jo_topic + top-N sort, 213 buffers
--                   → Index Scan using the new index, no sort, 4 buffers
--   b. failed total Index Only Scan of all of idx_jo_topic, 178 buffers
--                   → Index Only Scan of the new index, 14 buffers
--   c. topics       Index Only Scan of all of idx_jo_topic, 178 buffers
--                   → Index Only Scan of the new index, 14 buffers
-- The topic-FILTERED page and total keep using `idx_jo_topic`
-- (`topic = $t AND status = 'failed'` is its exact key prefix) — correct and
-- cheap, nothing to change.
--
-- WHY `topic` IS AN `INCLUDE` ON THE FAILED INDEX. (b) and (c) read nothing
-- but `topic`; carried on the leaf, both are Index Only Scans instead of a
-- heap fetch per failed row. It is never an ordering input, so it stays out
-- of the key, where it would cost the free `created_at DESC` order (a).
--
-- WHY A SECOND INDEX ON COMPLETED ROWS. The summary's "completed today" arm is
-- the only thing that keeps (d) off a sequential scan; without it, bounding
-- the other four arms changes nothing because the planner cannot BitmapOr an
-- arm with no index. Its write cost is one btree insert per job at the
-- moment it completes — the `-> completed` UPDATE is already non-HOT
-- (`status` is a key of `idx_jo_topic`), and rows leave the index when the
-- ArchivalPoller deletes them.
--
-- LOCAL-ONLY at merge unless the migrations log says otherwise. Verification
-- is schema introspection (`pg_indexes` + `pg_index.indisvalid` for the two
-- names below), NEVER `list_migrations`, which does not track this repo's 0xx
-- migrations.

-- 1. Failed rows, newest first — serves (a), (b), (c) and the failed arm of (d).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jo_failed_created
  ON job_outbox (created_at DESC) INCLUDE (topic)
  WHERE status = 'failed';

-- 2. Completed rows by completion time — serves the "completed today" arm of (d).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jo_completed_at
  ON job_outbox (completed_at)
  WHERE status = 'completed';
