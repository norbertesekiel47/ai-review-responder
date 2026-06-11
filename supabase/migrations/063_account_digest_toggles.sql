-- ==============================================================================
-- Migration 063: Account-level digest toggles + backfill
--
-- Moves the weekly-summary / monthly-impact digest opt-out from per-location
-- (`businesses`, migration 014, nullable, written only to the primary location)
-- to account-level (`accounts`). Today a secondary location can never opt out and
-- an archived location keeps emailing because the toggle was read per-location.
-- This migration adds the two account columns and backfills them. The write/read
-- path moves to these columns in later PR-E tasks (E2/E3); the per-business
-- columns are DEPRECATED here (read fallback during the cutover), NOT dropped.
-- See docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md (PR E).
--
-- Additive + transactional: `accounts` is small, so no CONCURRENTLY is needed;
-- `ADD COLUMN IF NOT EXISTS` makes the DDL idempotent in shape. Apply
-- staging-first, then production, both Supabase projects in lockstep.
--
-- The backfill below is RE-RUN ONCE post-deploy (it is idempotent in shape —
-- the same SELECTs over the same `businesses` rows yield the same values) to
-- close the write-path window: rows whose per-business toggle was written
-- between this migration and the E2 write-path cutover are re-derived by the
-- second pass (per spec Fix 5). The UPDATE has no IS NULL guard because the
-- columns are NOT NULL with a default; a second pass simply recomputes the same
-- value from the source-of-truth `businesses` rows.
-- ==============================================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS weekly_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS monthly_impact_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── Backfill (spec contract) ──────────────────────────────────────────────────
-- Per account, three explicit branches (do NOT collapse to a flat
-- COALESCE(primary, aggregate, TRUE) chain — that wrongly falls through to the
-- aggregate when an active primary exists with a stored NULL value):
--   1. Account HAS an active primary business (is_primary AND archived_at IS NULL):
--      use that primary's stored value, NULL → TRUE. Does NOT consult the
--      aggregate even if the primary's value is NULL.
--   2. No active primary row at all: bool_and(COALESCE(<col>, TRUE)) over ALL of
--      the account's businesses rows (active OR archived) — any recorded opt-out
--      anywhere survives. ("Former primary" is not identifiable: archiving sets
--      is_primary = FALSE.)
--   3. No businesses rows at all: bool_and over zero rows is NULL → outer COALESCE
--      yields TRUE (the column default).
UPDATE accounts a SET
  weekly_summary_enabled = CASE
    WHEN EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL
    ) THEN COALESCE(
      (SELECT b.weekly_summary_enabled FROM businesses b
       WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL
       LIMIT 1),
      TRUE)
    ELSE COALESCE(
      (SELECT bool_and(COALESCE(b.weekly_summary_enabled, TRUE)) FROM businesses b
       WHERE b.account_id = a.id),
      TRUE)
  END,
  monthly_impact_enabled = CASE
    WHEN EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL
    ) THEN COALESCE(
      (SELECT b.monthly_impact_enabled FROM businesses b
       WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL
       LIMIT 1),
      TRUE)
    ELSE COALESCE(
      (SELECT bool_and(COALESCE(b.monthly_impact_enabled, TRUE)) FROM businesses b
       WHERE b.account_id = a.id),
      TRUE)
  END;
