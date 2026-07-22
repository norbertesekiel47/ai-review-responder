-- Migration 081: poller_cursors — durable keyset resume cursor + write-sequence CAS
--
-- #479 (map #472): persists StripeLocationsReconcilePoller's in-memory keyset
-- resume cursor (added in #487) across worker restarts so a restart resumes the
-- rotation instead of re-walking the head. One row per poller.
--
-- write_seq is the ordering guard (ADR 0006): the poller holds an in-memory
-- writeSeq seeded at boot from this column and stamps a fresh, monotonic seq on
-- every save; saveCursor's UPSERT applies only WHERE EXCLUDED.write_seq >
-- poller_cursors.write_seq, so a stale/detached/reordered save (withTimeout does
-- not cancel — a timed-out save keeps running and can land late) is a DB no-op.
--
-- Deny-all RLS: RLS enabled, NO policies. Holds NO tenant data (no account_id —
-- just a poller name + an opaque last-claimed account id). Server reaches it only
-- via the RLS-bypassing postgres role, same posture as impersonation_sessions
-- (048) / agent_runs (071).
--
-- Additive; transactional (no CONCURRENTLY — brand-new table, instant build).
-- Apply staging first, then production, both Supabase projects in lockstep.

CREATE TABLE IF NOT EXISTS poller_cursors (
  poller_name TEXT PRIMARY KEY,
  cursor UUID,
  write_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE poller_cursors IS
  'Durable keyset resume cursor per background poller. Holds no tenant data (no account_id). cursor = id of the last account CLAIMED in the previous rotation; write_seq is the monotonic ordering guard (ADR 0006) that rejects stale/late/reordered saves at the DB.';
COMMENT ON COLUMN poller_cursors.cursor IS
  'Id of the last account claimed in the previous rotation, or NULL at a rotation boundary. NOT necessarily fully reconciled — a claimed-but-timed-out account is re-attempted next rotation (never-skip invariant).';
COMMENT ON COLUMN poller_cursors.write_seq IS
  'Monotonic per-poller write sequence. Seeded into the poller in-memory at boot; each save stamps a fresh seq and the UPSERT applies only WHERE EXCLUDED.write_seq > poller_cursors.write_seq.';

ALTER TABLE poller_cursors ENABLE ROW LEVEL SECURITY;
-- Deny-all: RLS enabled, NO policies. Server reaches this via the RLS-bypassing
-- postgres role only (same as impersonation_sessions, migration 048).
