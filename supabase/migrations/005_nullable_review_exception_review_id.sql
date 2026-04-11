-- Allow review_exceptions.review_id to be NULL.
-- Identity collisions are detected at fetch time BEFORE the review row is inserted,
-- so there is no review_id to reference. Prompt 9 requires storing these in the table.
ALTER TABLE review_exceptions ALTER COLUMN review_id DROP NOT NULL;

-- Dedup constraint for identity collisions (review_id IS NULL).
-- The existing idx_review_exceptions_open uses (review_id, type) WHERE status = 'open',
-- but NULL != NULL in SQL so it doesn't prevent duplicate collision rows.
-- This index enforces at most one open identity_collision per provider_review_id per business.
CREATE UNIQUE INDEX idx_review_exceptions_collision_dedup
  ON review_exceptions (business_id, type, (payload->>'provider_review_id'))
  WHERE status = 'open' AND review_id IS NULL;
