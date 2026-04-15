-- Document the dispatching outbox state used by OutboxPoller two-phase dispatch.
-- The runtime uses this state between claiming a row and adding it to BullMQ.
-- Original schema comment at 001_initial_schema.sql only listed:
--   pending, dispatched, completed, failed
-- Actual lifecycle:
--   pending → dispatching → dispatched → completed
--                        ↘ failed (if max_attempts exceeded)
--   dispatching is a transient claim state (set with dispatched_at = NOW()).
--   Stale dispatching rows (dispatched_at IS NULL or > 2 min) are recovered
--   by the OutboxPoller watchdog.
COMMENT ON COLUMN job_outbox.status IS
  'pending → dispatching → dispatched → completed | failed. dispatching is a transient two-phase claim.';
