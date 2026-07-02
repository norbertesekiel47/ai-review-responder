-- Migration 070: reviews.google_review_name — Google-native resource-name capture
--
-- Why: the future direct-GBP posting adapter (GBP API application filed
-- 2026-07-01) must address reviews by Google's review resource name
-- (accounts/{a}/locations/{l}/reviews/{r}). Zernio's payload carries exactly
-- that in ZernioReview.name, but ingest previously parsed it for location
-- routing and discarded it, persisting only the synthetic zernio:// identity.
-- Capture starts now so no forward data is lost; historical rows can be
-- backfilled from inbound_events raw payloads if/when the adapter ships.
--
-- Shape: additive + idempotent (ADD COLUMN IF NOT EXISTS), transactional
-- (no CONCURRENTLY — safe to run as a single transaction). Nullable: SerpAPI /
-- manual-source rows and pre-070 rows have NULL. NOT part of dedup identity
-- (that remains (provider, provider_review_name)). No index (no lookup path
-- yet). No RLS change (column inherits the existing reviews policies).
--
-- Apply staging first, then production, both Supabase projects in lockstep.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS google_review_name TEXT;

COMMENT ON COLUMN reviews.google_review_name IS
  'Google-native review resource name (accounts/{a}/locations/{l}/reviews/{r}) captured from the ingest payload when available. Nullable: non-Zernio sources and pre-070 rows have NULL. Consumed by the future GBP posting adapter; not part of dedup identity.';
