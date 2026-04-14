-- Add place_id_verified flag (defaults false — forces explicit verification)
ALTER TABLE businesses ADD COLUMN place_id_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Store original URL for re-resolution if needed
ALTER TABLE businesses ADD COLUMN google_maps_url TEXT;

-- Only verify existing businesses whose google_place_id is a canonical base64url
-- Place ID (starts with a letter, 20+ chars). Do NOT grandfather hex CIDs.
UPDATE businesses
SET place_id_verified = TRUE
WHERE google_place_id IS NOT NULL
  AND google_place_id ~ '^[A-Za-z][A-Za-z0-9_-]{19,}$';

-- Existing businesses with non-canonical IDs stay place_id_verified = FALSE.
-- Insert a review_exception so the admin sees them in the dashboard.
-- review_id is NULL (no review involved), columns match the actual schema.
INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload, created_at)
SELECT
  gen_random_uuid(),
  id,
  NULL,
  'place_id_resolution_required',
  'open',
  jsonb_build_object(
    'reason', 'Existing google_place_id is not a canonical Place ID',
    'current_value', google_place_id
  ),
  NOW()
FROM businesses
WHERE google_place_id IS NOT NULL
  AND NOT (google_place_id ~ '^[A-Za-z][A-Za-z0-9_-]{19,}$');

-- Add google_maps_url to prospect_demos too
ALTER TABLE prospect_demos ADD COLUMN google_maps_url TEXT;

-- Partial index for ReconciliationPoller filter
CREATE INDEX idx_businesses_verified_active
  ON businesses (subscription_status, place_id_verified)
  WHERE subscription_status = 'active' AND place_id_verified = TRUE;
