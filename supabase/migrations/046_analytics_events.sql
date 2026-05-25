-- Migration 046: first-party analytics dispatch queue
--
-- Vercel/client code records first-party facts here. Railway workers dispatch
-- to PostHog asynchronously so no browser or Next.js route calls PostHog.

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  distinct_id TEXT NOT NULL,
  anonymous_id TEXT,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE analytics_events IS
  'First-party analytics queue. Next.js/client code writes rows; Railway dispatches to PostHog.';

COMMENT ON COLUMN analytics_events.id IS
  'Application code should pass UUIDv7. gen_random_uuid() is a database fallback only.';

CREATE INDEX IF NOT EXISTS idx_analytics_events_pending
  ON analytics_events (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_analytics_events_account
  ON analytics_events (account_id, occurred_at DESC)
  WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_events_status
  ON analytics_events (status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_locked
  ON analytics_events (locked_at)
  WHERE status = 'dispatching';
