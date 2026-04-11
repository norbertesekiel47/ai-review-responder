-- Fix: migration 002 dropped + recreated approval_audit_log without restoring RLS.
-- The original enablement was in 001_initial_schema.sql but was lost on DROP TABLE.

ALTER TABLE approval_audit_log ENABLE ROW LEVEL SECURITY;
