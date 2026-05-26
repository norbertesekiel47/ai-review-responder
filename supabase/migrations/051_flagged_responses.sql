-- Migration 051: flagged_responses (Wave 3, PR 3a)
--
-- Holds high-confidence unsafe generated drafts that must NOT enter the normal
-- owner approval-notification path until an admin dispositions them (PR 3b adds
-- the admin queue + disposition actions). Preserves the no-auto-posting
-- invariant: a flagged draft stays a `pending_approval` response with no
-- notification and an `open` row here.
--
-- Admin-only via deny-all RLS (enable RLS, no policy) — server reads through the
-- Postgres.js `postgres` role which bypasses RLS, like impersonation_sessions
-- (048) and analytics_events (049). Owners never see this table directly.

CREATE TABLE IF NOT EXISTS flagged_responses (
  id                  UUID PRIMARY KEY,
  response_id         UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  review_id           UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  api_cost_id         UUID REFERENCES api_costs(id),
  source              TEXT NOT NULL CHECK (source IN ('local_regex', 'openai_moderation', 'eval', 'admin')),
  reason              TEXT,
  severity            TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'approved_for_owner_review', 'dismissed_false_positive', 'requires_regeneration')),
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE flagged_responses IS
  'High-confidence unsafe drafts held out of the owner approval path until admin disposition (Wave 3 PR 3a/3b). Admin-only (deny-all RLS).';

ALTER TABLE flagged_responses ENABLE ROW LEVEL SECURITY;

-- Admin queue reads open items newest-first.
CREATE INDEX IF NOT EXISTS idx_flagged_responses_status_created
  ON flagged_responses (status, created_at DESC);

-- One open flag per response (idempotent re-runs of a response generation must
-- not stack duplicate open flags).
CREATE UNIQUE INDEX IF NOT EXISTS idx_flagged_responses_open_response
  ON flagged_responses (response_id)
  WHERE status = 'open';
