-- 105_checkout_attempt_coupon.sql
-- Beta comp coupon on the Checkout attempt snapshot (admin-invite-funnel plan
-- step 2 / ticket T1: docs/superpowers/plans/2026-08-14-admin-invite-funnel.md;
-- the constraint rewrite is review-log round 2 finding 5).
--
-- WHAT: one nullable `accounts.checkout_attempt_coupon_id TEXT`, plus a
-- replacement of the named CHECK 077 created for the attempt lease.
--
-- WHY A COLUMN AT ALL. `createCheckoutSession` builds every Stripe Session
-- parameter from the durable `checkout_attempt_*` snapshot under a per-attempt
-- idempotency key. Reading `BETA_COMP_COUPON_ID` live at session-creation time
-- would let an env change between attempt creation and a retry produce
-- different params under the SAME idempotency key. The coupon decision is
-- therefore taken once — inside `applyTierSnapshot`, under the activation lock
-- — and snapshotted here with the rest of the immutable tuple.
--
-- WHY THE NULL-AT-REST BRANCH GAINS `checkout_attempt_coupon_id IS NULL`.
-- 077's first branch enumerates EVERY attempt column so that a cleared attempt
-- is cleared WHOLE — that all-or-nothing shape is the attempt-completeness
-- invariant, and it is what makes "no attempt" a state the database can
-- recognize rather than a convention the writers happen to follow. A new
-- attempt column left out of that branch would let a cleared attempt retain a
-- coupon snapshot: a row with no attempt but a live comp decision, which the
-- NEXT attempt's writer has no reason to look at and no obligation to
-- overwrite. Adding it keeps the branch exhaustive.
--
-- WHY THE ACTIVE BRANCH DOES NOT CONSTRAIN IT. NULL here is not a missing
-- value; it is the explicit "no coupon" decision `applyTierSnapshot` records
-- for every account that is not an admin invitee (or when the env var is
-- unset). A complete, postable attempt at full price therefore has a NULL
-- coupon, so requiring NOT NULL — or pairing it with any other attempt column
-- — would reject the common case. Everything else in the active branch is
-- reproduced from 077 byte-for-byte: this migration adds one AND to one
-- branch and changes nothing else about the lease contract.
--
-- SEQUENCING. This migration REPLACES a constraint 077 created over columns
-- 077 added, so it cannot be applied where 077 has not been. Per the standing
-- exception in .claude/CLAUDE.md, 077 AND 078 are deliberately absent in
-- production until the WS8 tier cutover (docs/runbooks/ws8-tier-cutover.md):
-- apply 105 to STAGING now, and to production only at/after that cutover — not
-- out-of-band, and never before 077.
--
-- Re-runnable: `ADD COLUMN IF NOT EXISTS` plus DROP-then-ADD of the named
-- CHECK, so a reapply REPAIRS a stale definition instead of trusting name
-- presence (077's own rationale — PostgreSQL has no ADD CONSTRAINT IF NOT
-- EXISTS). The new column is NULL on every existing row, so the widened
-- null-at-rest branch passes trivially and no preflight is needed. The
-- ACCESS EXCLUSIVE window is bounded (104 precedent).
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $migration$
BEGIN
  ALTER TABLE public.accounts
    ADD COLUMN IF NOT EXISTS checkout_attempt_coupon_id TEXT;

  ALTER TABLE public.accounts
    DROP CONSTRAINT IF EXISTS accounts_checkout_attempt_complete_check;
  ALTER TABLE public.accounts
    ADD CONSTRAINT accounts_checkout_attempt_complete_check CHECK (
      (
        checkout_attempt_state IS NULL
        AND checkout_attempt_id IS NULL
        AND checkout_session_id IS NULL
        AND checkout_attempt_tier IS NULL
        AND checkout_attempt_price_variant IS NULL
        AND checkout_attempt_base_price_id IS NULL
        AND checkout_attempt_overage_price_id IS NULL
        AND checkout_attempt_base_price_cents IS NULL
        AND checkout_attempt_overage_price_cents IS NULL
        AND checkout_attempt_locations_included IS NULL
        AND checkout_attempt_locations_paid IS NULL
        AND checkout_attempt_overage_quantity IS NULL
        AND checkout_attempt_trial_period_days IS NULL
        AND checkout_attempt_tax_enabled IS NULL
        AND checkout_attempt_customer_email IS NULL
        AND checkout_attempt_success_url IS NULL
        AND checkout_attempt_cancel_url IS NULL
        AND checkout_attempt_updated_at IS NULL
        AND checkout_attempt_coupon_id IS NULL
      )
      OR
      (
        checkout_attempt_state IS NOT NULL
        AND checkout_attempt_state IN ('creating', 'open', 'completed', 'remediated')
        AND checkout_attempt_id IS NOT NULL
        AND (
          (checkout_attempt_state = 'creating' AND checkout_session_id IS NULL)
          OR
          (checkout_attempt_state <> 'creating' AND checkout_session_id IS NOT NULL)
        )
        AND checkout_attempt_tier IS NOT NULL
        AND checkout_attempt_tier IN ('copilot', 'autopilot')
        AND checkout_attempt_price_variant IS NOT NULL
        AND checkout_attempt_price_variant IN ('list', 'founding')
        AND checkout_attempt_base_price_id IS NOT NULL
        AND checkout_attempt_overage_price_id IS NOT NULL
        AND checkout_attempt_base_price_cents IS NOT NULL
        AND checkout_attempt_base_price_cents > 0
        AND checkout_attempt_overage_price_cents IS NOT NULL
        AND checkout_attempt_overage_price_cents > 0
        AND checkout_attempt_locations_included IS NOT NULL
        AND checkout_attempt_locations_included > 0
        AND checkout_attempt_locations_paid IS NOT NULL
        AND checkout_attempt_locations_paid >= 0
        AND (
          checkout_attempt_state = 'completed'
          OR checkout_attempt_locations_paid = 0
        )
        AND checkout_attempt_overage_quantity IS NOT NULL
        AND checkout_attempt_overage_quantity >= 0
        AND (
          checkout_attempt_trial_period_days IS NULL
          OR checkout_attempt_trial_period_days = 30
        )
        AND checkout_attempt_tax_enabled IS NOT NULL
        AND NULLIF(BTRIM(checkout_attempt_customer_email), '') IS NOT NULL
        AND NULLIF(BTRIM(checkout_attempt_success_url), '') IS NOT NULL
        AND NULLIF(BTRIM(checkout_attempt_cancel_url), '') IS NOT NULL
        AND checkout_attempt_updated_at IS NOT NULL
      )
    );
END
$migration$;

COMMIT;
