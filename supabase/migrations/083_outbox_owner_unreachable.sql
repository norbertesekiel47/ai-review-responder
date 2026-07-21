-- 083_outbox_owner_unreachable.sql
-- F1 (docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md): distinct
-- owner-unreachable notification outcome. A send_notification job that completes
-- because the owner has zero verified channel enrollments records
-- completion_reason='owner_unreachable' on its completed job_outbox row, so
-- HealthAlertPoller.checkOwnerUnreachable and the NotificationFailoverPoller
-- owner-unreachable arm can observe + escalate it. Additive nullable column; all
-- other topics and existing rows keep NULL and unchanged behavior.
--
-- NO INDEX: the owner-unreachable lookups drive FROM responses
-- (idx_responses_pending_approval_created, migration 082) and correlate to
-- send_notification rows by aggregate_id (idx_jo_send_notification_by_aggregate,
-- migration 082) — both already exist. ADD COLUMN of a nullable, no-default
-- column is metadata-only, but bound the brief ACCESS EXCLUSIVE lock so it can't
-- queue behind a long write on the hot job_outbox table. Apply staging first,
-- then prod in lockstep.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS completion_reason TEXT;
COMMIT;
