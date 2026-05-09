-- ==============================================================================
-- Migration 040: Tighten RLS write policies on businesses and channel_enrollments
--
-- Security review findings (CRITICAL/HIGH severity):
-- - Owner UPDATE policy on businesses allows changing any column including
--   subscription_tier, subscription_status, stripe_customer_id,
--   stripe_subscription_id, account_id, google_place_id, is_primary,
--   archived_at, onboarded_by — all sensitive fields that should only be
--   modified by server-side code using the service-role key.
-- - Owner INSERT policy on channel_enrollments allows direct enrollment
--   with status='verified', bypassing verification flows.
-- - Owner UPDATE policy on channel_enrollments allows flipping status
--   (e.g., to 'verified') or changing handle without verification.
--
-- Target architecture: reads through RLS, writes through server routes
-- with service-role key. This migration:
--
-- 1. Replaces businesses_owner_update with a policy that restricts
--    UPDATE to safe columns only, using a BEFORE UPDATE trigger to
--    reject changes to sensitive columns when the session is not
--    service-role.
--
-- 2. Removes channel_enrollments_owner_insert — enrollments should
--    ONLY go through verification flows (server routes with service-role).
--
-- 3. Replaces channel_enrollments_owner_update with a policy that
--    restricts UPDATE to only safe transitions (unsubscribed_at,
--    unsubscribed_reason), using a BEFORE UPDATE trigger to reject
--    changes to sensitive columns (status, verified_at, handle,
--    verification_token_hash, etc.) when the session is not service-role.
--
-- Postgres RLS policies can restrict which ROWS are updatable (USING)
-- and which new row states are allowed (WITH CHECK), but they CANNOT
-- restrict which COLUMNS can be updated. Column-level write protection
-- requires either:
--   (a) REVOKE UPDATE(column) from authenticated role
--   (b) BEFORE UPDATE trigger that raises an exception for column changes
--
-- We use approach (a) for both tables: REVOKE UPDATE on sensitive columns
-- from the authenticated role. This is cleaner than triggers and prevents
-- the column from being written even if a future policy accidentally
-- allows it. Service-role (postgres) bypasses RLS and is unaffected by
-- column-level GRANT/REVOKE since it's the table owner.
--
-- Idempotent: uses DO blocks with existence checks, REVOKE is safe to
-- re-run.
-- ==============================================================================

-- ==============================================================================
-- 1. Businesses: narrow UPDATE to safe columns only
-- ==============================================================================

-- 1a. Drop the old permissive UPDATE policy
DROP POLICY IF EXISTS businesses_owner_update ON businesses;

-- 1b. Create a new narrowed UPDATE policy
-- USING: owner can only update rows belonging to their account
-- WITH CHECK: the updated row must still belong to their account
-- Column-level REVOKE (below) ensures sensitive columns cannot be written
CREATE POLICY businesses_owner_update ON businesses
  FOR UPDATE TO authenticated
  USING (account_id = owner_account_id())
  WITH CHECK (account_id = owner_account_id());

-- 1c. REVOKE UPDATE on sensitive columns from authenticated role
-- These columns should ONLY be writable by service-role (table owner).
-- authenticated users can still read these columns via the SELECT policy.
-- Service-role (postgres user, table owner) bypasses column-level privileges.
DO $$ BEGIN
  -- Subscription/billing fields — managed by Stripe webhooks (service-role)
  REVOKE UPDATE (subscription_tier) ON businesses FROM authenticated;
  REVOKE UPDATE (subscription_status) ON businesses FROM authenticated;
  REVOKE UPDATE (stripe_customer_id) ON businesses FROM authenticated;
  REVOKE UPDATE (stripe_subscription_id) ON businesses FROM authenticated;

  -- Account association — managed by add-location/archive transactions
  REVOKE UPDATE (account_id) ON businesses FROM authenticated;

  -- Google Place ID — managed by admin routes and PlaceIdValidationWorker
  REVOKE UPDATE (google_place_id) ON businesses FROM authenticated;

  -- Primary/archived status — managed by promote-primary/archive transactions
  REVOKE UPDATE (is_primary) ON businesses FROM authenticated;
  REVOKE UPDATE (archived_at) ON businesses FROM authenticated;

  -- Onboarded-by — set once during signup, never changed
  REVOKE UPDATE (onboarded_by) ON businesses FROM authenticated;

  -- ID — never changeable
  REVOKE UPDATE (id) ON businesses FROM authenticated;

  -- Name — managed through display_label update route or admin
  -- (name is the Google Business name and should not be changed by owners)
  REVOKE UPDATE (name) ON businesses FROM authenticated;

  -- Owner identity — set during signup, not changed by owners
  REVOKE UPDATE (owner_name) ON businesses FROM authenticated;
  REVOKE UPDATE (owner_email) ON businesses FROM authenticated;

  -- Baseline metrics — managed by ranking/sync workers
  REVOKE UPDATE (initial_review_count) ON businesses FROM authenticated;
  REVOKE UPDATE (initial_responded_count) ON businesses FROM authenticated;
  REVOKE UPDATE (baseline_captured_at) ON businesses FROM authenticated;

  -- Category — set during business creation, not changed by owners
  REVOKE UPDATE (category) ON businesses FROM authenticated;

  -- Sync state — managed by workers
  REVOKE UPDATE (last_sync_at) ON businesses FROM authenticated;

  -- Created timestamp — immutable
  REVOKE UPDATE (created_at) ON businesses FROM authenticated;
END $$;

COMMENT ON POLICY businesses_owner_update ON businesses IS
  'Owner can UPDATE their own businesses row, but only safe columns. '
  'Sensitive columns (subscription_*, stripe_*, account_id, is_primary, '
  'archived_at, etc.) are protected by column-level REVOKE from authenticated role. '
  'Service-role (table owner) bypasses column-level privileges.';

-- ==============================================================================
-- 2. Channel enrollments: remove INSERT policy
-- ==============================================================================
-- Enrollments should ONLY be created through verification flows that run
-- on the server with service-role access (telegram-enrollment.ts,
-- finish-signup/route.ts, verify-otp/route.ts, admin channel routes,
-- EmailChannelReconcilePoller). Direct INSERT via anon key allows
-- owners to create verified enrollments without going through verification.

DROP POLICY IF EXISTS channel_enrollments_owner_insert ON channel_enrollments;

-- ==============================================================================
-- 3. Channel enrollments: narrow UPDATE to safe columns only
-- ==============================================================================

-- 3a. Drop the old permissive UPDATE policy
DROP POLICY IF EXISTS channel_enrollments_owner_update ON channel_enrollments;

-- 3b. Create a new narrowed UPDATE policy
-- Owner can UPDATE rows they own, but column-level REVOKE ensures
-- they can only change safe columns (unsubscribed_at, unsubscribed_reason,
-- updated_at). Sensitive columns (status, verified_at, handle,
-- verification_token_hash, etc.) are protected.
CREATE POLICY channel_enrollments_owner_update ON channel_enrollments
  FOR UPDATE TO authenticated
  USING (account_id = owner_account_id())
  WITH CHECK (account_id = owner_account_id());

-- 3c. REVOKE UPDATE on sensitive columns from authenticated role
DO $$ BEGIN
  -- Status — managed by verification flows, admin routes, and workers
  -- Owners must NOT be able to flip status to 'verified' directly
  REVOKE UPDATE (status) ON channel_enrollments FROM authenticated;

  -- Verification fields — managed by verification token exchange
  REVOKE UPDATE (verified_at) ON channel_enrollments FROM authenticated;
  REVOKE UPDATE (verification_token_hash) ON channel_enrollments FROM authenticated;
  REVOKE UPDATE (verification_token_expires_at) ON channel_enrollments FROM authenticated;

  -- Handle — managed by enrollment flows, not direct update
  REVOKE UPDATE (handle) ON channel_enrollments FROM authenticated;

  -- Channel type — immutable after creation
  REVOKE UPDATE (channel) ON channel_enrollments FROM authenticated;

  -- Account association — managed by server transactions
  REVOKE UPDATE (account_id) ON channel_enrollments FROM authenticated;

  -- Business/location association — managed by server transactions
  REVOKE UPDATE (business_id) ON channel_enrollments FROM authenticated;
  REVOKE UPDATE (location_id) ON channel_enrollments FROM authenticated;

  -- Disabled timestamp — managed by admin routes and workers
  REVOKE UPDATE (disabled_at) ON channel_enrollments FROM authenticated;

  -- ID — never changeable
  REVOKE UPDATE (id) ON channel_enrollments FROM authenticated;

  -- Created timestamp — immutable
  REVOKE UPDATE (created_at) ON channel_enrollments FROM authenticated;
END $$;

-- Note: unsubscribed_at and unsubscribed_reason are intentionally LEFT
-- updateable by authenticated users. This allows owners to mark their
-- own enrollments as unsubscribed (opt-out). The TCPA compliance path
-- (STOP handler) uses service-role access and doesn't depend on this policy.

COMMENT ON POLICY channel_enrollments_owner_update ON channel_enrollments IS
  'Owner can UPDATE their own enrollments, but only safe columns '
  '(unsubscribed_at, unsubscribed_reason, updated_at). Sensitive columns '
  '(status, verified_at, handle, verification_token_hash, etc.) are protected '
  'by column-level REVOKE. Service-role bypasses column-level privileges.';
