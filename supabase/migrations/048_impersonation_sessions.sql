-- Migration 048: admin impersonation session state
--
-- 047 is occupied by the past_due_at backfill. Impersonation is intentionally
-- admin-owned and time-boxed; app code should pass UUIDv7 ids.

CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  impersonated_user_id UUID NOT NULL REFERENCES users(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  ticket_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE impersonation_sessions IS
  'Admin-owned, time-boxed view-as sessions. Application code should pass UUIDv7 ids.';

ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_impersonation_actor_started
  ON impersonation_sessions (actor_user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_impersonation_impersonated_started
  ON impersonation_sessions (impersonated_user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_impersonation_account_started
  ON impersonation_sessions (account_id, started_at DESC);

-- Enforces "one active impersonation session per actor": a partial UNIQUE index
-- so a second concurrent open session for the same actor is rejected at the DB.
CREATE UNIQUE INDEX IF NOT EXISTS idx_impersonation_active_actor
  ON impersonation_sessions (actor_user_id)
  WHERE ended_at IS NULL;
