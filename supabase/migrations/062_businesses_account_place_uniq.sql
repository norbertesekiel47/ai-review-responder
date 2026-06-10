-- ==============================================================================
-- Migration 062: Server-side duplicate google_place_id enforcement
--
-- Adds a partial UNIQUE index so an account cannot hold two ACTIVE locations
-- with the same google_place_id. Duplicate prevention was previously client-side
-- only; a duplicate double-ingests every review (double LLM spend + double
-- notifications). See docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md
-- Fix 7.
--
-- IMPORTANT: this file uses CREATE INDEX CONCURRENTLY and therefore must be applied
-- NON-transactionally — uncheck the "single transaction" box in the Supabase SQL
-- editor (a CONCURRENTLY build cannot run inside a transaction block). Apply
-- staging-first, then production, both Supabase projects in lockstep.
--
-- ── PRE-FLIGHT CHECK (run BEFORE applying, against staging AND prod) ────────────
--   SELECT account_id, google_place_id, count(*)
--     FROM businesses
--     WHERE archived_at IS NULL AND google_place_id IS NOT NULL
--     GROUP BY account_id, google_place_id
--     HAVING count(*) > 1;
--   -- expect: 0 rows.
--
-- If NON-EMPTY, BLOCK the migration and resolve each pair by the written rule:
-- archive the duplicate WITHOUT a Zernio connection; if both or neither have one,
-- archive the newer; reviews are preserved. The migration never auto-mutates data.
-- A pre-existing duplicate would abort the CONCURRENTLY build mid-way and leave an
-- INVALID index (recover via the POST-MIGRATION step below).
-- ==============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS businesses_account_place_uniq
  ON businesses (account_id, google_place_id)
  WHERE archived_at IS NULL AND google_place_id IS NOT NULL;

-- ── POST-MIGRATION VERIFICATION (run AFTER applying) ───────────────────────────
--   SELECT indexrelid::regclass AS index, indisvalid
--     FROM pg_index
--     WHERE indexrelid = 'businesses_account_place_uniq'::regclass;
--   -- expect: indisvalid = true.
--
-- If indisvalid = false, the CONCURRENTLY build was interrupted (almost always a
-- pre-existing active duplicate that slipped past the pre-flight). Recover with:
--   DROP INDEX businesses_account_place_uniq;
-- resolve the duplicate, then re-run this migration.
