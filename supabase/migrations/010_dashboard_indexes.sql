-- Supports dashboard velocity and recent-review queries
CREATE INDEX IF NOT EXISTS idx_reviews_business_detected_at
  ON reviews(business_id, detected_at DESC);
