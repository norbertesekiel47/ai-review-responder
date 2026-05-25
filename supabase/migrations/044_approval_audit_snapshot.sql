-- ==============================================================================
-- Migration 044: Approval audit approved-text snapshot
--
-- Adds immutable content evidence to approval_audit_log so every approval event
-- can prove the exact owner-approved text even if responses.approved_text changes.
-- Additive and zero-downtime: nullable column, no index until a query needs it.
-- ==============================================================================

ALTER TABLE approval_audit_log
  ADD COLUMN IF NOT EXISTS response_text_at_approval TEXT;

COMMENT ON COLUMN approval_audit_log.response_text_at_approval IS
  'Immutable owner-approved response text captured in the same transaction as approval status mutation and publish outbox enqueue.';
