-- Migration 024: dedup key for notification_deliveries
--
-- Closes the send-before-record race in worker/jobs/ResponsePublisherWorker.ts
-- (and is reusable for any other worker that needs "at most one delivery per
-- (response, template)"). Before this migration a worker would:
--   1. send email
--   2. record delivery
-- A crash in the ~100ms window between steps 1 and 2 left no delivery row,
-- so the next BullMQ retry would send a duplicate email.
--
-- With this constraint in place the publisher can INSERT the delivery row
-- FIRST as an atomic claim (ON CONFLICT DO NOTHING); losers skip instead of
-- re-sending.
--
-- Scope: constraint applies only to the admin_manual_post template. Approval
-- requests intentionally can write multiple per-response delivery rows across
-- channels (email/SMS/Telegram/WhatsApp), so a generic (response_id, template)
-- unique index would incorrectly block those sends.

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_response_template_uniq
  ON notification_deliveries (response_id, template)
  WHERE response_id IS NOT NULL AND template = 'admin_manual_post';

COMMENT ON INDEX notification_deliveries_response_template_uniq IS
  'Dedup key for admin manual-post notifications. Enables INSERT ON '
  'CONFLICT DO NOTHING claim pattern without blocking multi-channel '
  'approval_request deliveries.';
