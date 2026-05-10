-- ==============================================================================
-- Migration 041: REVOKE UPDATE on columns missed by migration 040
--
-- Security review follow-up: migration 040 revoked UPDATE on many sensitive
-- columns, but missed several that were added by earlier migrations (007, 014,
-- 022). Owners should not be able to write these columns via the anon key:
--
-- businesses:
--   (1) subscription_activated_at — added by migration 014. Managed by
--       Stripe webhooks. Owners must not control subscription timing.
--   (2) place_id_verified — added by migration 007. Managed by
--       PlaceIdValidationWorker. Owners must not bypass Place ID validation.
--   (3) google_maps_url — added by migration 007. Managed by onboarding
--       wizard guard. Owners must not bypass the wizard to set arbitrary URLs.
--
-- channel_enrollments:
--   (4) archived_at — added by migration 022. Managed by admin archive
--       transactions. Owners must not un-archive admin-deleted enrollments.
--   (5) archive_reason — added by migration 022. Managed by admin archive
--       transactions. Owners must not rewrite the audit trail for archiving.
--
-- Idempotent: REVOKE is idempotent by default in PostgreSQL — revoking a
-- privilege that is already revoked is a no-op.
-- ==============================================================================

DO $$ BEGIN
  -- ── businesses: subscription_activated_at ──────────────────────────────
  -- Managed by Stripe webhook (checkout.session.completed → service-role).
  -- If an owner could set this, they could extend trial or grace-period
  -- windows without paying.
  REVOKE UPDATE (subscription_activated_at) ON businesses FROM authenticated;

  -- ── businesses: place_id_verified ──────────────────────────────────────
  -- Managed by PlaceIdValidationWorker and admin routes (service-role).
  -- If an owner could flip this to TRUE, they could bypass Place ID
  -- validation and point their listing at an arbitrary Google Business.
  REVOKE UPDATE (place_id_verified) ON businesses FROM authenticated;

  -- ── businesses: google_maps_url ────────────────────────────────────────
  -- Managed by onboarding wizard guard and admin routes (service-role).
  -- If an owner could set this directly, they could bypass the onboarding
  -- wizard's Google Place selection step and inject arbitrary URLs.
  REVOKE UPDATE (google_maps_url) ON businesses FROM authenticated;

  -- ── channel_enrollments: archived_at ───────────────────────────────────
  -- Managed by admin archive/stop routes (service-role).
  -- If an owner could set archived_at = NULL, they could un-archive an
  -- enrollment that was admin-deleted (e.g., for TCPA compliance or abuse).
  REVOKE UPDATE (archived_at) ON channel_enrollments FROM authenticated;

  -- ── channel_enrollments: archive_reason ─────────────────────────────────
  -- Managed by admin archive routes (service-role).
  -- If an owner could change archive_reason, they could rewrite the audit
  -- trail for why an enrollment was archived (e.g., 'admin_delete' → null).
  REVOKE UPDATE (archive_reason) ON channel_enrollments FROM authenticated;
END $$;
