-- 085: competitor_snapshots.rating REAL → NUMERIC(2,1)
--
-- Why: Google ratings are one-decimal values; REAL (float4) stores 4.8 as
-- 4.80000019…, so any future SQL band comparison for the Competitor Delta
-- line (e.g. rating >= 4.8) silently mis-matches at boundaries. NUMERIC(2,1)
-- is exact and free at this row count (≤ ~20 rows per business/keyword/day).
-- Raised in the PR #554 pre-merge review (ticket #538, wayfinder map #528).
-- 084 was already applied to staging, hence a new migration, not an amend
-- (migrations are immutable once applied).
--
-- Read-side note: Postgres.js returns NUMERIC as a JS string. No production
-- code reads this column yet (write-only until the Competitor Delta line,
-- ticket #539) — #539 must parse it (e.g. Number(rating)) when it lands.
--
-- Retryable: ALTER COLUMN TYPE to the same type is a no-op rewrite, and the
-- USING clause is idempotent for values already in range.

SET lock_timeout = '5s';

ALTER TABLE competitor_snapshots
  ALTER COLUMN rating TYPE NUMERIC(2,1) USING round(rating::numeric, 1);
