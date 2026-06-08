-- ==============================================================================
-- Migration 059: Owner offboarding purge-reminder marker
--
-- H1b. Adds purge_reminder_sent_at so the T-3d "your data will be deleted soon"
-- reminder (AccountOffboardingPurgeReminderPoller) fires at most once per
-- delete_data offboarding. Additive and nullable; no backfill needed. Existing
-- in-flight purge_scheduled rows simply become reminder-eligible on the next
-- poll if they are within the reminder window.
--
-- Deploy: apply to staging Supabase first, verify, then production — both
-- projects in lockstep, staging first.
-- ==============================================================================

ALTER TABLE account_offboardings
  ADD COLUMN IF NOT EXISTS purge_reminder_sent_at TIMESTAMPTZ;
