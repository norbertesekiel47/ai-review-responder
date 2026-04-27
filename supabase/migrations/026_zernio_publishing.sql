-- Migration 026: Zernio publishing integration — connections + finalize incidents
--
-- Adds the schema needed to publish approved responses to Google Business Profile
-- via the Zernio API instead of the existing manual-post fallback. Specifically:
--
--   1. Widens responses.status from VARCHAR(20) → TEXT so the new non-terminal
--      value 'awaiting_owner_connect' (22 chars) fits without truncation.
--   2. Replaces the partial unique index from migration 023 with one that
--      includes the new non-terminal value.
--   3. Adds zernio_connections — per-business mapping to a Zernio profile +
--      Google Business location. Created lazily during /dashboard/connect,
--      never via createBusinessTx. RLS enabled (deny-by-default) to match
--      the repo posture for first-class tables.
--   4. Adds zernio_finalize_incidents — durable record of selectLocation calls
--      whose outcome is unknown (timeout / abort / 5xx). Blocks new connect
--      flows for the affected business until ops resolves the incident.
--   5. Adds two notification_deliveries dedup indexes (mirrors migration 024)
--      so claim-before-send works for owner_reconnect_required (per response)
--      and owner_connection_lost (per business per day).
--   6. Pre-cleanup + DB-level uniqueness for in-flight publish_response outbox
--      rows — closes the race between concurrent DrainOwnerConnectWorker runs
--      and the auth-error-path single-row INSERT. Mirrors the
--      idx_jo_sync_reviews_inflight pattern from migration 018.
--
-- Note: CREATE INDEX CONCURRENTLY would be preferable in production, but the
-- migration runner executes inside a single transaction via the Supabase SQL
-- editor, which disallows CONCURRENTLY. A plain CREATE INDEX holds a brief
-- ACCESS EXCLUSIVE lock — acceptable for these table sizes.

-- =====================================================================
-- 1. Widen responses.status and rebuild the non-terminal uniqueness index
-- =====================================================================
--
-- responses.status is VARCHAR(20) per migration 001 line 210. The new value
-- 'awaiting_owner_connect' is 22 chars and would fail the column constraint.
-- Widen to TEXT to match status columns elsewhere (job_outbox.status,
-- review_exceptions.status, etc. are all TEXT in migration 001). VARCHAR(20)
-- was an accidental narrow choice.

ALTER TABLE responses ALTER COLUMN status TYPE TEXT;

-- Drop the index from migration 023 and recreate it including the new
-- non-terminal status. 'awaiting_owner_connect' is non-terminal — owner
-- reconnect transitions it to 'posted' (success) or admin action terminates
-- it as 'failed'.

DROP INDEX IF EXISTS responses_one_non_terminal_per_review;

CREATE UNIQUE INDEX IF NOT EXISTS responses_one_non_terminal_per_review
  ON responses (review_id)
  WHERE status IN (
    'pending_approval',
    'approved',
    'edited',
    'awaiting_manual_post',
    'awaiting_owner_connect'
  );

COMMENT ON INDEX responses_one_non_terminal_per_review IS
  'Enforces "at most one non-terminal response per review" invariant. '
  'awaiting_owner_connect is non-terminal — owner reconnect transitions '
  'it to posted (success) or admin-action terminates it as failed.';

-- =====================================================================
-- 2. zernio_connections — per-business Zernio profile + GBP location mapping
-- =====================================================================
--
-- Critical: this codebase does NOT have the pg_uuidv7 extension installed
-- (per the explicit note at 001_initial_schema.sql:29-31). All existing
-- tables use DEFAULT gen_random_uuid() and the application generates
-- UUIDv7 via the uuidv7 npm package. This table follows the same pattern.

CREATE TABLE IF NOT EXISTS zernio_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Zernio identifiers (all populated post-location-selection)
  zernio_profile_id     TEXT NOT NULL,        -- our workspace inside Zernio (1-per-business)
  zernio_account_id     TEXT NOT NULL,        -- the connected Google account
  zernio_location_id    TEXT NOT NULL,        -- the chosen GBP location

  -- Connection state machine: pending → active → disconnected
  status                TEXT NOT NULL CHECK (status IN ('pending','active','disconnected')),

  -- Ops / audit fields
  connected_at          TIMESTAMPTZ,          -- set when status first becomes 'active'
  disconnected_at       TIMESTAMPTZ,          -- set when status flips to 'disconnected'
  disconnect_reason     TEXT,                 -- 'webhook_event' | 'auth_error_on_post' | 'manual_owner' | 'manual_admin'
  last_error            TEXT,                 -- last Zernio API error body (truncated 500 chars)
  last_error_at         TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active or pending connection per business. Disconnected rows kept
-- for audit (soft-delete model) so use a partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS zernio_connections_one_active_per_business
  ON zernio_connections (business_id)
  WHERE status IN ('pending','active');

-- Webhook lookup: account.disconnected events arrive with zernio_account_id;
-- need to find the business fast.
CREATE INDEX IF NOT EXISTS zernio_connections_account_id_idx
  ON zernio_connections (zernio_account_id)
  WHERE status = 'active';

-- Ops query: "show me all currently-broken connections"
CREATE INDEX IF NOT EXISTS zernio_connections_disconnected_idx
  ON zernio_connections (business_id)
  WHERE status = 'disconnected';

COMMENT ON TABLE zernio_connections IS
  'Per-business mapping to Zernio profile + Google Business location. '
  'Created lazily during /dashboard/connect flow, never via createBusinessTx.';

-- RLS: enabled to match repo posture. All other first-class tables enable RLS
-- in 001_initial_schema.sql:479-488. Production access is server-side via the
-- service role (which bypasses RLS), but enabling RLS is the deny-by-default
-- safety net if any client-key path ever touches this table by accident.
-- No policies = deny-all for non-service-role connections, matching the
-- existing posture for tables like notification_deliveries.
ALTER TABLE zernio_connections ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- 3. zernio_finalize_incidents — durable record of finalize_unknown outcomes
-- =====================================================================
--
-- The Redis pending-marker `status='finalize_unknown'` is volatile — a
-- 15-min TTL would expire silently, letting the owner start a SECOND
-- Zernio flow while a half-committed account from the first flow may
-- still exist on Zernio's side. Persist the incident here so:
--   (1) connect/start blocks new flows when an unresolved incident exists
--   (2) ops has a queryable surface for reconciliation backlog
--   (3) the record survives Redis restarts/evictions

CREATE TABLE IF NOT EXISTS zernio_finalize_incidents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  zernio_profile_id     TEXT NOT NULL,
  flow_id               TEXT NOT NULL,            -- matches connect_pending.flowId
  finalize_unknown_at   TIMESTAMPTZ NOT NULL,
  resolved_at           TIMESTAMPTZ,
  resolution            TEXT CHECK (resolution IN ('account_found','no_account','manual_admin_other')),
  resolution_notes      TEXT,
  zernio_account_id     TEXT,                     -- populated on resolution='account_found'
  zernio_location_id    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One unresolved incident per business at a time. Blocks new connect/start
-- attempts until ops resolves the incident (sets resolved_at).
CREATE UNIQUE INDEX IF NOT EXISTS zernio_finalize_incidents_one_unresolved_per_business
  ON zernio_finalize_incidents (business_id)
  WHERE resolved_at IS NULL;

-- Ops query: "show me all unresolved finalize incidents for triage"
CREATE INDEX IF NOT EXISTS zernio_finalize_incidents_unresolved_idx
  ON zernio_finalize_incidents (created_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE zernio_finalize_incidents ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE zernio_finalize_incidents IS
  'Durable record of Zernio selectLocation calls with unknown outcome '
  '(timeout/abort/5xx). connect/start blocks while business has any '
  'unresolved row. Resolved by admin reconciliation procedure (runbook).';

-- =====================================================================
-- 4. notification_deliveries dedup indexes for the new owner-email templates
-- =====================================================================
--
-- Mirrors migration 024's pattern for admin_manual_post — enables the
-- claim-before-send INSERT ... ON CONFLICT DO NOTHING pattern in the new
-- OwnerEmailWorker without blocking multi-channel approval-request rows.
--
-- For 'owner_reconnect_required': scoped to (response_id, template) so each
-- response generates at most one reconnect email.

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_owner_reconnect_dedup
  ON notification_deliveries (response_id, template)
  WHERE response_id IS NOT NULL AND template = 'owner_reconnect_required';

COMMENT ON INDEX notification_deliveries_owner_reconnect_dedup IS
  'Dedup key for owner_reconnect_required notifications. Mirrors '
  'notification_deliveries_response_template_uniq from migration 024.';

-- For 'owner_connection_lost': business-scoped (no response context). Caps
-- emails at one per business per day regardless of webhook fire frequency.
--
-- Critical: notification_deliveries.sent_at is nullable (migration 001 line 337).
-- The claim-before-send pattern inserts the row with sent_at IS NULL and
-- updates it after Resend acks. Postgres unique indexes treat each NULL as
-- distinct, so a (sent_at::date) predicate would NOT dedupe concurrent
-- claims. Use created_at::date instead — which is NOT NULL DEFAULT NOW().

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_connection_lost_dedup
  ON notification_deliveries (business_id, template, (created_at::date))
  WHERE template = 'owner_connection_lost';

COMMENT ON INDEX notification_deliveries_connection_lost_dedup IS
  'One owner_connection_lost email per business per day. Uses created_at '
  '(NOT NULL DEFAULT NOW()) instead of nullable sent_at so the dedup '
  'works under the claim-before-send pattern.';

-- =====================================================================
-- 5. job_outbox: in-flight publish_response uniqueness
-- =====================================================================
--
-- DrainOwnerConnectWorker uses a NOT EXISTS guard before bulk-inserting
-- publish_response rows, but two concurrent runs could each pass the
-- application-level guard and both insert. This DB-level partial unique
-- index is the hard guarantee. Mirrors idx_jo_sync_reviews_inflight from
-- migration 018.
--
-- Pre-cleanup: if production already contains duplicate in-flight
-- publish_response rows for the same aggregate_id, the unique-index
-- creation below would fail. Collapse any existing duplicates by keeping
-- the oldest and marking the rest 'failed' — same approach used by
-- migrations 004 and 018.

UPDATE job_outbox
SET status = 'failed',
    last_error = 'Collapsed duplicate by migration 026',
    completed_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY topic, aggregate_id
      ORDER BY created_at
    ) AS rn
    FROM job_outbox
    WHERE topic = 'publish_response'
      AND status IN ('pending', 'dispatching', 'dispatched')
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_publish_response_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'publish_response'
    AND status IN ('pending', 'dispatching', 'dispatched');

COMMENT ON INDEX idx_jo_publish_response_inflight IS
  'At-most-one in-flight publish_response per response. Mirrors the '
  'idx_jo_sync_reviews_inflight pattern. The DrainOwnerConnectWorker NOT '
  'EXISTS guard is the application-level fast-path; this index is the '
  'hard guarantee.';
