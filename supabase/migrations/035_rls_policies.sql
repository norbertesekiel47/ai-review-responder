-- ==============================================================================
-- Migration 035: Row-Level Security policies for all protected tables
--
-- Creates RLS policies on all ~22 protected tables using the
-- auth.uid() → users.account_id → table.account_id predicate pattern.
--
-- Tables with direct account_id get direct lookup:
--   accounts, businesses, channel_enrollments, api_costs,
--   notification_deliveries, approval_audit_log, account_audit_log
--
-- Tables scoped by business_id get JOIN predicate through businesses.account_id:
--   reviews, responses, approval_links, weekly_summaries,
--   review_exceptions, ranking_snapshots, monthly_impact_emails,
--   onboarding_drip_log, satisfaction_responses, api_costs_daily_rollups,
--   zernio_connections, zernio_finalize_incidents, zernio_backfill_runs
--
-- SMS tables get account-scoped visibility via channel_enrollments.handle:
--   sms_sender_opt_outs, sms_sender_opt_out_events
--
-- The existing users_self_select policy (migration 006) is preserved unchanged.
--
-- Validation contract: VAL-AUTH-001 through VAL-AUTH-022, VAL-AUTH-035
--
-- Idempotent: uses CREATE OR REPLACE for helper function; DROP POLICY IF EXISTS
-- before each CREATE POLICY so re-running is safe.
-- ==============================================================================

-- ==============================================================================
-- 0. Helper function: resolves the authenticated user's account_id
-- ==============================================================================
-- Centralizes the auth.uid() → users.account_id lookup so every policy
-- predicate uses the same expression. STABLE = evaluated once per statement
-- (not per row), which is correct because the authenticated user cannot change
-- mid-statement. Returns NULL for unauthenticated users or users without an
-- account_id, causing all USING predicates to evaluate to FALSE (deny-by-default).

CREATE OR REPLACE FUNCTION owner_account_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT account_id FROM users WHERE auth_id = auth.uid()::text
$$;

COMMENT ON FUNCTION owner_account_id() IS
  'Returns the account_id of the currently authenticated user. '
  'Used as the common predicate in all RLS policies. Returns NULL for '
  'unauthenticated sessions or users without an assigned account, causing '
  'USING clauses to evaluate FALSE (deny-by-default).';

-- ==============================================================================
-- 1. Group 1: Tables with direct account_id column
-- ==============================================================================
-- Predicate: account_id = owner_account_id()
-- These tables have a NOT NULL account_id column (added in migration 034).

-- ── 1a. accounts (VAL-AUTH-001) ─────────────────────────────────────────────
-- Owner can SELECT their own account row. The id column IS the account_id,
-- so the predicate compares accounts.id against owner_account_id().
-- No INSERT/UPDATE: accounts are created/modified via service-role only.

DROP POLICY IF EXISTS accounts_owner_select ON accounts;
CREATE POLICY accounts_owner_select ON accounts
  FOR SELECT TO authenticated
  USING (id = owner_account_id());

-- ── 1b. businesses (VAL-AUTH-002) ────────────────────────────────────────────
-- Owner can SELECT and UPDATE their account's locations (including archived).
-- No INSERT: businesses are created via add-location transaction (service-role).
-- No DELETE: archiving uses archived_at (soft-delete), not hard delete.

DROP POLICY IF EXISTS businesses_owner_select ON businesses;
CREATE POLICY businesses_owner_select ON businesses
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

DROP POLICY IF EXISTS businesses_owner_update ON businesses;
CREATE POLICY businesses_owner_update ON businesses
  FOR UPDATE TO authenticated
  USING (account_id = owner_account_id())
  WITH CHECK (account_id = owner_account_id());

-- ── 1c. channel_enrollments (VAL-AUTH-003) ──────────────────────────────────
-- Owner can SELECT, INSERT, and UPDATE their account's enrollments.
-- INSERT needed for channel setup flows. UPDATE needed for verification/status.
-- No DELETE: soft-delete via archived_at (service-role for unsubscribe).

DROP POLICY IF EXISTS channel_enrollments_owner_select ON channel_enrollments;
CREATE POLICY channel_enrollments_owner_select ON channel_enrollments
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

DROP POLICY IF EXISTS channel_enrollments_owner_insert ON channel_enrollments;
CREATE POLICY channel_enrollments_owner_insert ON channel_enrollments
  FOR INSERT TO authenticated
  WITH CHECK (account_id = owner_account_id());

DROP POLICY IF EXISTS channel_enrollments_owner_update ON channel_enrollments;
CREATE POLICY channel_enrollments_owner_update ON channel_enrollments
  FOR UPDATE TO authenticated
  USING (account_id = owner_account_id())
  WITH CHECK (account_id = owner_account_id());

-- ── 1d. api_costs (VAL-AUTH-004) ────────────────────────────────────────────
-- Owner can SELECT their account's cost records. Read-only (admin/system writes).

DROP POLICY IF EXISTS api_costs_owner_select ON api_costs;
CREATE POLICY api_costs_owner_select ON api_costs
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

-- ── 1e. notification_deliveries (VAL-AUTH-005) ─────────────────────────────
-- Owner can SELECT their account's delivery records. Read-only (workers write).

DROP POLICY IF EXISTS notification_deliveries_owner_select ON notification_deliveries;
CREATE POLICY notification_deliveries_owner_select ON notification_deliveries
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

-- ── 1f. approval_audit_log (VAL-AUTH-006) ──────────────────────────────────
-- Owner can SELECT their account's audit records. Read-only (workers write).

DROP POLICY IF EXISTS approval_audit_log_owner_select ON approval_audit_log;
CREATE POLICY approval_audit_log_owner_select ON approval_audit_log
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

-- ── 1g. account_audit_log (VAL-AUTH-035) ───────────────────────────────────
-- Owner can SELECT their account's audit log entries. Read-only (tx writes).

DROP POLICY IF EXISTS account_audit_log_owner_select ON account_audit_log;
CREATE POLICY account_audit_log_owner_select ON account_audit_log
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

-- ==============================================================================
-- 2. Group 2: Tables scoped by business_id (JOIN through businesses.account_id)
-- ==============================================================================
-- Predicate: business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id())
-- These tables have a business_id FK but no direct account_id column.

-- ── 2a. reviews (VAL-AUTH-007) ──────────────────────────────────────────────
-- Owner can SELECT reviews for their account's locations. Read-only (workers write).

DROP POLICY IF EXISTS reviews_owner_select ON reviews;
CREATE POLICY reviews_owner_select ON reviews
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2b. responses (VAL-AUTH-008) ───────────────────────────────────────────
-- Owner can SELECT responses for their account's locations. Read-only (workers write).

DROP POLICY IF EXISTS responses_owner_select ON responses;
CREATE POLICY responses_owner_select ON responses
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2c. approval_links (VAL-AUTH-009) ──────────────────────────────────────
-- Owner can SELECT approval links for their account's locations.
-- Public approval pages use service-role access (bypasses RLS).

DROP POLICY IF EXISTS approval_links_owner_select ON approval_links;
CREATE POLICY approval_links_owner_select ON approval_links
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2d. weekly_summaries (VAL-AUTH-010) ─────────────────────────────────────
-- Owner can SELECT weekly summaries for their account's locations. Read-only.

DROP POLICY IF EXISTS weekly_summaries_owner_select ON weekly_summaries;
CREATE POLICY weekly_summaries_owner_select ON weekly_summaries
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2e. review_exceptions (VAL-AUTH-011) ────────────────────────────────────
-- Owner can SELECT review exceptions for their account's locations. Read-only.

DROP POLICY IF EXISTS review_exceptions_owner_select ON review_exceptions;
CREATE POLICY review_exceptions_owner_select ON review_exceptions
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2f. ranking_snapshots (VAL-AUTH-012) ────────────────────────────────────
-- Owner can SELECT ranking snapshots for their account's locations. Read-only.

DROP POLICY IF EXISTS ranking_snapshots_owner_select ON ranking_snapshots;
CREATE POLICY ranking_snapshots_owner_select ON ranking_snapshots
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2g. monthly_impact_emails (VAL-AUTH-013) ───────────────────────────────
-- Owner can SELECT impact email records for their account's locations. Read-only.

DROP POLICY IF EXISTS monthly_impact_emails_owner_select ON monthly_impact_emails;
CREATE POLICY monthly_impact_emails_owner_select ON monthly_impact_emails
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2h. onboarding_drip_log (VAL-AUTH-014) ─────────────────────────────────
-- Owner can SELECT drip log records for their account's locations. Read-only.

DROP POLICY IF EXISTS onboarding_drip_log_owner_select ON onboarding_drip_log;
CREATE POLICY onboarding_drip_log_owner_select ON onboarding_drip_log
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2i. satisfaction_responses (VAL-AUTH-015) ──────────────────────────────
-- Owner can SELECT satisfaction data for their account's locations. Read-only.

DROP POLICY IF EXISTS satisfaction_responses_owner_select ON satisfaction_responses;
CREATE POLICY satisfaction_responses_owner_select ON satisfaction_responses
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2j. api_costs_daily_rollups (VAL-AUTH-016) ─────────────────────────────
-- Owner can SELECT cost rollups for their account's locations. Read-only.

DROP POLICY IF EXISTS api_costs_daily_rollups_owner_select ON api_costs_daily_rollups;
CREATE POLICY api_costs_daily_rollups_owner_select ON api_costs_daily_rollups
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2k. zernio_connections (VAL-AUTH-019) ──────────────────────────────────
-- Owner can SELECT Zernio connections for their account's locations. Read-only.

DROP POLICY IF EXISTS zernio_connections_owner_select ON zernio_connections;
CREATE POLICY zernio_connections_owner_select ON zernio_connections
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2l. zernio_finalize_incidents (VAL-AUTH-020) ──────────────────────────
-- Owner can SELECT finalize incidents for their account's locations. Read-only.

DROP POLICY IF EXISTS zernio_finalize_incidents_owner_select ON zernio_finalize_incidents;
CREATE POLICY zernio_finalize_incidents_owner_select ON zernio_finalize_incidents
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ── 2m. zernio_backfill_runs (VAL-AUTH-021) ───────────────────────────────
-- Owner can SELECT backfill runs for their account's locations. Read-only.

DROP POLICY IF EXISTS zernio_backfill_runs_owner_select ON zernio_backfill_runs;
CREATE POLICY zernio_backfill_runs_owner_select ON zernio_backfill_runs
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

-- ==============================================================================
-- 3. Group 3: SMS tables (linked via channel_enrollments.handle)
-- ==============================================================================
-- These tables have no account_id or business_id column. They are scoped by
-- (messaging_service_sid, handle). The handle is a phone number that also
-- appears in channel_enrollments for SMS/WhatsApp channels. The RLS predicate
-- links through channel_enrollments: owner can see opt-out records for handles
-- that belong to their account's SMS/WhatsApp channel enrollments.
--
-- Note: SMS STOP fan-out remains sender-wide (TCPA compliance). These policies
-- only affect read visibility for owner queries via anon-key, not the actual
-- STOP/START processing (which uses service-role access).

-- ── 3a. sms_sender_opt_outs (VAL-AUTH-017) ─────────────────────────────────
-- Owner can SELECT opt-out records for their account's enrolled phone numbers.

DROP POLICY IF EXISTS sms_sender_opt_outs_owner_select ON sms_sender_opt_outs;
CREATE POLICY sms_sender_opt_outs_owner_select ON sms_sender_opt_outs
  FOR SELECT TO authenticated
  USING (handle IN (
    SELECT ce.handle FROM channel_enrollments ce
    WHERE ce.account_id = owner_account_id()
      AND ce.channel IN ('sms', 'whatsapp')
      AND ce.handle IS NOT NULL
      AND ce.archived_at IS NULL
  ));

-- ── 3b. sms_sender_opt_out_events (VAL-AUTH-018) ───────────────────────────
-- Owner can SELECT opt-out event records for their account's enrolled phone numbers.

DROP POLICY IF EXISTS sms_sender_opt_out_events_owner_select ON sms_sender_opt_out_events;
CREATE POLICY sms_sender_opt_out_events_owner_select ON sms_sender_opt_out_events
  FOR SELECT TO authenticated
  USING (handle IN (
    SELECT ce.handle FROM channel_enrollments ce
    WHERE ce.account_id = owner_account_id()
      AND ce.channel IN ('sms', 'whatsapp')
      AND ce.handle IS NOT NULL
      AND ce.archived_at IS NULL
  ));

-- ==============================================================================
-- 4. Preserve users_self_select (migration 006) — NO CHANGES
-- ==============================================================================
-- The existing policy on users is:
--   CREATE POLICY users_self_select ON users
--     FOR SELECT TO authenticated
--     USING (auth_id = auth.uid()::text);
--
-- This policy is intentionally left untouched. It does NOT use the
-- account_id predicate pattern (users.auth_id is compared directly to
-- auth.uid()), which is correct because users need to read their own row
-- regardless of account membership.

-- ==============================================================================
-- 5. Verify: users_self_select is untouched
-- ==============================================================================
-- Safety assertion: confirm the users_self_select policy still exists after
-- this migration runs. If it was accidentally dropped, this will raise an error.
-- Idempotent: DO block only asserts, does not modify.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'users' AND p.polname = 'users_self_select'
  ) THEN
    RAISE EXCEPTION
      'users_self_select RLS policy is missing from the users table! '
      'This migration must NOT drop the existing policy from migration 006.';
  END IF;
END $$;
