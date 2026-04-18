-- Migration 019: Indexes for Resend webhook + admin deliverability queries
--
-- Supporting indexes for hot query paths introduced in Prompt 20d:
-- 1. Resend webhook lookups delivery rows by external_message_id on every
--    email.delivered / email.complained / email.bounced event.
-- 2. Admin overview health panel filters by sent_at / failed_at over rolling
--    7-day and 24-hour windows.
--
-- All three are partial indexes (WHERE ... IS NOT NULL) to keep the index
-- narrow — most rows do not yet have these fields populated at INSERT time.

CREATE INDEX IF NOT EXISTS idx_nd_external_message_id
  ON notification_deliveries(external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nd_sent_at
  ON notification_deliveries(sent_at)
  WHERE sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nd_failed_at
  ON notification_deliveries(failed_at, failure_reason)
  WHERE failed_at IS NOT NULL;
