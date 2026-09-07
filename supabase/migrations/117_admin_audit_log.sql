-- 117_admin_audit_log.sql
--
-- #468 — admin MFA events are silently unaudited.
--
-- WHAT A ROW IS
-- One row is one action taken by an ADMIN on the admin control plane, keyed on
-- the admin's `users.id`. It is the actor-scoped sibling of `account_audit_log`
-- (034): that table's `account_id` is NOT NULL because every event it records
-- belongs to a tenant, and admins have `role='admin'` + NULL `account_id`, so
-- an admin's own MFA enrollment / step-up / factor removal had NO sink at all
-- and was dropped by `auditMfaEvent` in `src/app/api/auth/mfa/challenge/route.ts`.
-- Relaxing `account_audit_log.account_id` was rejected: every tenant-scope
-- query, the owner-select RLS policy, the governor joins and the offboarding
-- purge treat that table as per-account, and a NULL-account row would be
-- invisible to them or mis-scoped.
--
-- THE ONLY WRITER is `writeAdminAuditLog` in `src/lib/audit/log.ts` (the same
-- one-helper-one-INSERT model as `writeAccountAuditLog`). The first (and, in
-- this change, only) event family is MFA: `mfa_factor_enrolled`,
-- `mfa_challenge_succeeded`, `mfa_challenge_failed`, `mfa_factor_unenrolled`.
-- Other admin control-plane actions (impersonation, flagged dispositions,
-- billing grants) keep their existing sinks — out of scope here.
--
-- POSTURE
-- * Admin-only. RLS enabled with ZERO policies (deny-all — the
--   flagged_responses/051, judge_verdicts/076, refusal_events/116 posture).
--   Server access is only through the RLS-bypassing Postgres.js `postgres` role.
-- * RLS protects ROWS, not table privileges, so the client roles' table ACL is
--   revoked too (076/088/055 precedent, widened to SELECT and to `anon`
--   because an audit trail has no client reader at all). That is what lets the
--   live suite assert `has_table_privilege(...) = false` in EVERY environment,
--   not only where the bootstrap happens to grant nothing.
-- * `actor_user_id` carries NO `ON DELETE` action: admin users are never
--   purged (users are `retain_deidentified` in the offboarding inventory), and
--   a delete that would cascade a security trail away must fail loudly.
-- * Platform-scoped: no `account_id`, therefore NOT a `TENANT_TABLES` member
--   (it sits in `REVIEWED_NOT_TENANT_SCOPED`, scripts/ci/tenant-tables.ts).
--   In `TABLE_DISPOSITIONS` as `not_applicable` / `not_checked`: the actor is
--   always an admin, never an offboarded owner, so the purge has nothing to do —
--   the entry exists because `actor_user_id` is on the account-linked column
--   scan and a silent omission is what that scan exists to catch.
-- * Retention: keep forever — deliberate, same as `account_audit_log`.
-- * Application code supplies UUIDv7 ids (project convention).
--
-- Additive and re-runnable. Apply staging first, then prod (lockstep); verify
-- by introspection (pg_tables / pg_class.relrowsecurity / pg_policies count = 0
-- / has_table_privilege / pg_indexes / pg_constraint), never the migration ledger.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            UUID PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  entity_type   TEXT,
  entity_id     TEXT,
  ip            TEXT,
  user_agent    TEXT,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE admin_audit_log IS
  'Admin control-plane actor trail (#468): one row per admin action, keyed on the admin user; no account_id by design. Admin-only (deny-all RLS, client-role privileges revoked). Keep forever. The only writer is writeAdminAuditLog (src/lib/audit/log.ts); application code supplies UUIDv7 ids.';

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all. Server reaches the table through the
-- RLS-bypassing postgres role only.
REVOKE ALL ON admin_audit_log FROM anon, authenticated;

-- "What did this admin do, newest first."
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor_created
  ON admin_audit_log (actor_user_id, created_at DESC);

-- "Every factor removal across admins, newest first."
CREATE INDEX IF NOT EXISTS idx_admin_audit_event_created
  ON admin_audit_log (event_type, created_at DESC);
