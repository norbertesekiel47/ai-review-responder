-- ==============================================================================
-- Migration 060: Owner offboarding reactivation claim columns
--
-- M1/M2. The cancel_only reactivation flow coordinates a 3-transaction Stripe
-- reversal. v1 overloaded `last_error` as the claim mutex and used
-- `reactivated_at` as the in-flight marker, which (a) coupled two orthogonal
-- facts onto one column and (b) could strand a row non-terminal with Stripe
-- already reversed and no autonomous recovery. These dedicated columns give the
-- claim its own owner:
--   * reactivation_claimed_at  — the in-flight claim timestamp (was reactivated_at)
--   * reactivation_claim_token — the claiming idempotency-key hash (was last_error)
-- `reactivated_at` now stamps ONLY at terminal reactivation success.
--
-- The partial index backs AccountOffboardingReactivationResetPoller, which finds
-- stale claims (an originating process that died mid-reversal), compensates Stripe
-- back to cancel_at_period_end=true, and clears the claim so the row is no longer
-- stranded.
--
-- Additive + nullable; no backfill needed. Existing rows have NULL claim columns,
-- which is exactly the "no active reactivation claim" state.
--
-- Deploy: apply to staging Supabase first, verify, then production — both
-- projects in lockstep, staging first.
-- ==============================================================================

ALTER TABLE account_offboardings
  ADD COLUMN IF NOT EXISTS reactivation_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reactivation_claim_token TEXT;

CREATE INDEX IF NOT EXISTS idx_account_offboardings_reactivation_claim
  ON account_offboardings (reactivation_claimed_at)
  WHERE reactivation_claimed_at IS NOT NULL AND terminal_at IS NULL;
