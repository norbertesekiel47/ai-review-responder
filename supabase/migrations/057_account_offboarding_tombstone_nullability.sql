-- ==============================================================================
-- Migration 057: Owner offboarding tombstone nullability
--
-- PR6 Task 6.2. Migration 056 intentionally captured raw provider snapshot arrays
-- for teardown. The purge terminal scrub must remove those raw identifiers from
-- the retained lifecycle receipt, so the Zernio snapshot arrays need to become
-- nullable. The purge worker will set them to NULL only after provider teardown
-- has succeeded or an admin provider disposition is recorded.
--
-- The same purge retains scrubbed approval audit rows while hard-deleting
-- response content. `approval_audit_log.response_id` was historically NOT NULL
-- with ON DELETE CASCADE, so it must become nullable before the worker can detach
-- audit rows from responses without losing the audit history.
--
-- Scrubbed impersonation sessions are retained for admin forensics, but the
-- purged account/user references must be removed from those rows.
-- ==============================================================================

ALTER TABLE account_offboardings
  ALTER COLUMN zernio_account_ids DROP NOT NULL,
  ALTER COLUMN zernio_profile_ids DROP NOT NULL;

ALTER TABLE approval_audit_log
  ALTER COLUMN response_id DROP NOT NULL;

ALTER TABLE impersonation_sessions
  ALTER COLUMN account_id DROP NOT NULL,
  ALTER COLUMN impersonated_user_id DROP NOT NULL;
