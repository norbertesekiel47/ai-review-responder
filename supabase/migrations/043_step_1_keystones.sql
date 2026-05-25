-- ==============================================================================
-- Migration 043: Step 1 SaaS-readiness keystones
--
-- Adds the missing past_due countdown source and extends account_audit_log with
-- generic metadata columns used by the Step 1 audit helper.
--
-- Additive and idempotent. No runtime authorization behavior changes.
-- ==============================================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS past_due_at TIMESTAMPTZ;

COMMENT ON COLUMN accounts.past_due_at IS
  'Set when an account enters the current past_due interval. Preserved across repeated failed invoices while still past_due; cleared on recovery or cancellation.';

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS entity_type TEXT;

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS entity_id TEXT;

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS ip TEXT;

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS request_id TEXT;

COMMENT ON COLUMN account_audit_log.entity_type IS
  'Optional audited entity type, such as account, business, response, membership, or provider_event.';

COMMENT ON COLUMN account_audit_log.entity_id IS
  'Optional audited entity identifier. Stored as text so internal UUIDs and provider IDs can both be represented.';

COMMENT ON COLUMN account_audit_log.ip IS
  'Optional request IP captured by application code. Text avoids audit-write failures on unusual proxy values.';

COMMENT ON COLUMN account_audit_log.user_agent IS
  'Optional request user-agent captured by application code.';

COMMENT ON COLUMN account_audit_log.request_id IS
  'Optional request or correlation identifier captured by application code.';
