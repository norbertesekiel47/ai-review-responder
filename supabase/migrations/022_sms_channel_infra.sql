-- supabase/migrations/022_sms_channel_infra.sql
--
-- Phase 1 SMS infrastructure. Bundles Phase 0's deferred column drop with
-- Phase 1's soft-delete support, sender-level opt-out tracking, audit log,
-- and the inbound-webhook handle index.
--
-- Ordering: ADD all columns BEFORE creating indexes that reference them.

-- 1. Drop deprecated column (promised in migration 021). No data loss —
-- commit 1b5d40e removed the last read/write.
ALTER TABLE businesses DROP COLUMN IF EXISTS notification_preference;

-- 2. Soft-delete columns on channel_enrollments. /delete sets archived_at
-- rather than hard-deleting, preserving TCPA consent/opt-out evidence.
ALTER TABLE channel_enrollments
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- 3a. sms_sender_opt_outs: authoritative CURRENT sender-level opt-out
-- state. Keyed by (messaging_service_sid, handle) so future multi-MS
-- setups (staging/prod split, sender migration) scope opt-outs correctly.
-- Persists across enrollment lifecycles — Twilio's actual block state
-- is never out of sync with our DB.
CREATE TABLE IF NOT EXISTS sms_sender_opt_outs (
  messaging_service_sid  TEXT NOT NULL,
  handle                 TEXT NOT NULL,
  opted_out_at           TIMESTAMPTZ NOT NULL,
  opted_in_at            TIMESTAMPTZ,
  last_event_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (messaging_service_sid, handle)
);

-- 3b. sms_sender_opt_out_events: append-only audit log of every STOP,
-- START, and send-time 21610 event. Durable TCPA evidence independent
-- of inbound_events 30-day archival.
CREATE TABLE IF NOT EXISTS sms_sender_opt_out_events (
  id                      UUID PRIMARY KEY,   -- uuidv7 (app-generated)
  messaging_service_sid   TEXT NOT NULL,
  handle                  TEXT NOT NULL,
  event_type              TEXT NOT NULL CHECK (event_type IN ('stop', 'start', '21610_at_send')),
  source                  TEXT NOT NULL CHECK (source IN ('twilio_inbound_keyword', 'twilio_optouttype', 'twilio_21610')),
  inbound_event_id        UUID REFERENCES inbound_events(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_sender_opt_out_events_handle
  ON sms_sender_opt_out_events(messaging_service_sid, handle, created_at DESC);

-- 3c. RLS on both new tables. No policies defined → service_role only.
ALTER TABLE sms_sender_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_sender_opt_out_events ENABLE ROW LEVEL SECURITY;

-- 4. Replace UNIQUE(business_id, channel) with a partial unique INDEX
-- scoped to active (non-archived) rows.
--
-- COORDINATED CODE CHANGE REQUIRED: every ON CONFLICT (business_id, channel)
-- DO UPDATE site must include the WHERE archived_at IS NULL predicate
-- (see Task 3).
ALTER TABLE channel_enrollments
  DROP CONSTRAINT IF EXISTS channel_enrollments_business_id_channel_key;
CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_business_channel_active_key
  ON channel_enrollments (business_id, channel)
  WHERE archived_at IS NULL;

-- 5. Inbound webhook handle lookup index, scoped to ACTIVE rows only.
-- STOP/START handlers never act on archived rows.
CREATE INDEX IF NOT EXISTS idx_channel_enrollments_sms_handle
  ON channel_enrollments(handle)
  WHERE channel IN ('sms', 'whatsapp') AND handle IS NOT NULL AND archived_at IS NULL;
