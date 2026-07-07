-- Migration 072: WS2 Guardian triage — classification columns on reviews
--
-- Spec: docs/superpowers/specs/2026-07-07-ws2-triage-design.md §2.3.
-- Follows the sentiment_* precedent (migration 052): per-review classification
-- lives on the reviews row, NOT in the run spine (the spine is attribution
-- data; WS3 escalation logic reads these columns, never agent_run_steps).
--
-- All columns nullable; existing rows are untouched (all-NULL passes the
-- consistency CHECK, so the ALTER's validation scan is trivially satisfied).
-- triage_issues values are validated app-side against the fixed taxonomy in
-- src/lib/reviews/triage-schema.ts (single owner) — no element-level CHECK.
-- No new index: WS3 defines its own query shape.
--
-- Additive; transactional. Apply staging first, then production, both
-- Supabase projects in lockstep.

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS triage_severity TEXT
    CHECK (triage_severity IN ('low', 'medium', 'high')),
  ADD COLUMN IF NOT EXISTS triage_issues TEXT[],
  ADD COLUMN IF NOT EXISTS triage_suggested_action TEXT
    CHECK (triage_suggested_action IN ('respond', 'escalate', 'respond_and_escalate')),
  ADD COLUMN IF NOT EXISTS triage_source TEXT,
  ADD COLUMN IF NOT EXISTS triage_model TEXT,
  ADD COLUMN IF NOT EXISTS triage_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS triaged_at TIMESTAMPTZ;

-- A triage result is written atomically or not at all: either every column is
-- NULL (never triaged) or the core trio is present. model/issues/hash stay
-- individually nullable (fallback has no model; hash can be legitimately NULL).
ALTER TABLE reviews ADD CONSTRAINT reviews_triage_consistency CHECK (
  (
    triage_severity IS NULL AND triage_issues IS NULL
    AND triage_suggested_action IS NULL AND triage_source IS NULL
    AND triage_model IS NULL AND triage_content_hash IS NULL
    AND triaged_at IS NULL
  )
  OR (
    triage_severity IS NOT NULL AND triage_source IS NOT NULL
    AND triaged_at IS NOT NULL
  )
);

COMMENT ON COLUMN reviews.triage_severity IS 'WS2 Guardian triage severity (low/medium/high); NULL = not triaged (positive lane, legacy, or flag off)';
COMMENT ON COLUMN reviews.triage_source IS 'llm_triage_v1 | fallback_high_v1 | mock_v1 — fallback rows are re-attempted on the next generation job';
COMMENT ON COLUMN reviews.triage_content_hash IS 'review_content_hash that was classified; mismatch with current hash invalidates the triage';
