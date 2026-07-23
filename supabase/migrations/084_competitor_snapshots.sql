-- 084_competitor_snapshots.sql
-- Competitor pack persistence (#538, wayfinder map #528; semantics locked in #532).
-- Persists the full ~20-entry google_maps local pack per
-- (business, keyword, search_location, snapshot_date) from the SAME SerpAPI
-- response RankingTrackingWorker already fetches — zero marginal quota.
-- Idempotency is replace-pack: rows are deleted + reinserted atomically per
-- (business_id, keyword, snapshot_date); there is deliberately NO per-row
-- unique key because place_id can be NULL on rare entries.
-- search_location is deliberately NOT part of the replace key: the parent
-- ranking_snapshots upsert key is (business_id, keyword, snapshot_date) and
-- OVERWRITES search_location on same-day re-run — the pack mirrors that, so an
-- owner editing ranking_search_location can never orphan a stale same-day pack.
-- #532's business+keyword+search_location key is the READ-side comparison
-- filter, applied by consumers over these ≤~20-row packs.
-- Concurrency: the worker's tx performs the ranking_snapshots upsert FIRST;
-- its unique-index row lock serializes concurrent same-key jobs, so the
-- DELETE+INSERT below it can never interleave into a duplicated pack.
-- data_cid is write-only in v1 — insurance for place_id-rotation continuity.
-- RLS: owner read-only, mirroring ranking_snapshots (035 §2f). All writes come
-- from the Railway worker over the direct Postgres connection (not subject to
-- these authenticated-role policies).

CREATE TABLE competitor_snapshots (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  keyword VARCHAR(255) NOT NULL,
  search_location VARCHAR(255),
  snapshot_date DATE NOT NULL,
  rank_position INTEGER,               -- normalized pack position (SerpAPI position, else array index + 1)
  place_id TEXT,                       -- canonical ChIJ… Place ID; NULL when SerpAPI omits it
  data_cid TEXT,                       -- long-lived Google CID; unread in v1
  title TEXT NOT NULL,                 -- '' when SerpAPI omits the name
  rating REAL,                         -- NULL when unrated
  review_count INTEGER,                -- NULL when absent
  is_self BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_competitor_snapshots_lookup
  ON competitor_snapshots (business_id, keyword, snapshot_date DESC);

ALTER TABLE competitor_snapshots ENABLE ROW LEVEL SECURITY;

-- Owner can SELECT competitor packs for their account's locations. Read-only —
-- no INSERT/UPDATE/DELETE policies for the authenticated role.
DROP POLICY IF EXISTS competitor_snapshots_owner_select ON competitor_snapshots;
CREATE POLICY competitor_snapshots_owner_select ON competitor_snapshots
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));
