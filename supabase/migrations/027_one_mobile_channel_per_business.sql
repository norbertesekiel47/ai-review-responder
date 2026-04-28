-- supabase/migrations/027_one_mobile_channel_per_business.sql
--
-- Phase 4: enforce "at most one pending/verified mobile channel per business"
-- at the DB level. The UI also gates this client-side; the index is
-- defense-in-depth so a buggy client or future API path can't enroll
-- multiple mobile channels for the same business.
--
-- Predicate exclusions are intentional:
--  - 'disabled' / 'unsubscribed' rows are NOT covered, so an owner's
--    enrollment history (e.g., previously-verified Telegram now disabled)
--    can coexist with a freshly-pending different mobile channel.
--  - 'archived_at IS NULL' mirrors the partial-uniqueness pattern from
--    migration 022 (channel_enrollments_business_channel_active_key).
--
-- Surface area: any INSERT/UPDATE that lands a (business_id, channel,
-- status, archived_at) tuple matching the predicate twice will hit
-- Postgres error 23505 with constraint_name='channel_enrollments_one_mobile_per_biz'.
-- Routes catch this and return 409 with body { error: 'multiple_mobile_channels' }.
--
-- See docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §6.2.

CREATE UNIQUE INDEX channel_enrollments_one_mobile_per_biz
  ON channel_enrollments (business_id)
  WHERE channel IN ('sms','telegram','whatsapp')
    AND status IN ('pending_verification','verified')
    AND archived_at IS NULL;
