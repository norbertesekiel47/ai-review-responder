-- supabase/migrations/079_agent_run_spine_archival_indexes.sql
--
-- IMPORTANT: this file uses CREATE INDEX CONCURRENTLY, which cannot run
-- inside a transaction. Apply non-transactionally — uncheck the
-- "single transaction" box in the Supabase SQL editor. Apply to staging
-- first, then prod, in lockstep. If a statement fails partway it can leave
-- an INVALID index behind; check with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- then DROP INDEX the invalid one and re-run.

-- Agent-run spine retention (migration 071). The ArchivalPoller agent_outcomes
-- DELETE (worker/background/pollers/ArchivalPoller.ts, arm 7) filters
--   WHERE occurred_at < NOW() - make_interval(days => 180)
-- The base spine schema has no index leading with occurred_at, so the daily
-- retention scan would seq-scan agent_outcomes. This index serves the claim.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_outcomes_archival
  ON agent_outcomes (occurred_at);

-- Task 2 adds the agent_runs retention index here (same 180-day window,
-- worker/background/pollers/ArchivalPoller.ts arm 8).
