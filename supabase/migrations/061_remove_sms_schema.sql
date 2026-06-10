-- ==============================================================================
-- Migration 061: Remove SMS channel schema
--
-- SMS is removed as a notification channel (spec:
-- docs/superpowers/specs/2026-06-09-sms-removal-design.md). It was never live
-- in production — CHANNELS_SMS_ENABLED defaulted off and 10DLC registration
-- (the flip precondition) never happened — so the opt-out tables hold no real
-- TCPA evidence. Pre-flight gate (run against prod BEFORE applying): zero rows
-- across sms enrollments / opt-out tables / sms approval_links / sms
-- notification_deliveries / sms inbound_events / pending sms outbox payloads.
--
-- 1. Defensively archive any stray sms enrollment rows (expected 0 in prod).
-- 2. Replace the sms+whatsapp handle index with a whatsapp-only one — the
--    surviving consumer is the WhatsApp STOP handler's handle-wide UPDATE
--    (worker/ingress/twilio/twilio-whatsapp-inbound.ts).
-- 3. Rebuild one_mobile_per_scope without 'sms' (telegram/whatsapp only).
-- 4. Drop both opt-out tables — events first (child-before-parent order for
--    clarity). RLS policies (sms_sender_opt_*_owner_select, migration 035)
--    drop implicitly.
--
-- channel_enrollments.channel / notification_deliveries.channel stay TEXT
-- with app-layer enforcement; historical 'sms' delivery rows are untouched.
--
-- Deploy: apply to staging Supabase first, verify, then production — both
-- projects in lockstep, staging first. Transactional (no CONCURRENTLY).
-- ==============================================================================

BEGIN;

-- 1. Defensive archive of stray sms enrollments (expected 0 rows in prod)
UPDATE channel_enrollments
SET archived_at = NOW(),
    updated_at = NOW()
WHERE channel = 'sms'
  AND archived_at IS NULL;

-- 2. Handle index: sms+whatsapp → whatsapp-only
DROP INDEX IF EXISTS idx_channel_enrollments_sms_handle;
CREATE INDEX IF NOT EXISTS idx_channel_enrollments_whatsapp_handle
  ON channel_enrollments(handle)
  WHERE channel = 'whatsapp' AND handle IS NOT NULL AND archived_at IS NULL;

-- 3. one_mobile_per_scope: drop 'sms' from the predicate
DROP INDEX IF EXISTS channel_enrollments_one_mobile_per_scope;
CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_one_mobile_per_scope
  ON channel_enrollments (
    account_id,
    COALESCE(location_id, '00000000-0000-0000-0000-000000000000')
  )
  WHERE channel IN ('telegram','whatsapp')
    AND status IN ('pending_verification','verified')
    AND archived_at IS NULL;

-- 4. Drop the SMS opt-out tables (child first; RLS policies drop with them)
DROP TABLE IF EXISTS sms_sender_opt_out_events;
DROP TABLE IF EXISTS sms_sender_opt_outs;

COMMIT;
