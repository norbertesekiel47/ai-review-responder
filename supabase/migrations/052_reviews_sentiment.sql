-- 052_reviews_sentiment.sql
-- Wave 3 PR 5a: deterministic review sentiment.
-- Adds nullable sentiment_* columns to reviews (LLM-ready via sentiment_source),
-- a label domain CHECK, and a one-time star-based deterministic backfill.
-- Additive + idempotent. RLS already enabled on reviews (migration 001); the
-- existing reviews_owner_select policy covers the new columns.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_score NUMERIC;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_label TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_classified_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_source TEXT;

-- Label domain guard (idempotent via catalog check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_sentiment_label_check'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_sentiment_label_check
      CHECK (sentiment_label IS NULL OR sentiment_label IN ('positive', 'neutral', 'negative'));
  END IF;
END $$;

-- One-time deterministic backfill (star-based; matches src/lib/reviews/sentiment.ts).
-- Bounded by sentiment_label IS NULL so re-running the migration is a no-op.
UPDATE reviews
SET sentiment_label = CASE
      WHEN star_rating >= 4 THEN 'positive'
      WHEN star_rating <= 2 THEN 'negative'
      ELSE 'neutral'
    END,
    sentiment_score = CASE
      WHEN star_rating IS NULL THEN 0
      ELSE (LEAST(GREATEST(star_rating, 1), 5) - 3) / 2.0
    END,
    sentiment_classified_at = NOW(),
    sentiment_source = 'deterministic_star_v1'
WHERE sentiment_label IS NULL;
