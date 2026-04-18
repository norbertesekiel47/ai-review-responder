-- Migration 020: Normalize double-encoded JSONB rows produced before the
-- `jsonb()` helper was introduced in src/lib/db/server.ts.
--
-- Root cause: every outbox/event INSERT used the pattern
--   VALUES (... ${JSON.stringify(payload)}::jsonb ...)
-- which caused Postgres.js to send the already-stringified JSON as a TEXT
-- parameter, and its JSONB type adapter wrapped the string in additional
-- JSON quotes — producing a JSONB scalar string instead of a JSONB object.
-- As a result `payload->>'correlation_id'` returned NULL on those rows
-- (the column held the string-form of the JSON, not an object).
--
-- After the fix (all sites now use `${jsonb(payload)}`), new rows are
-- proper JSONB objects. This migration normalizes any existing rows that
-- were written under the old pattern by extracting the inner value and
-- casting it back to jsonb.
--
-- The transformation (payload#>>'{}')::jsonb:
--   - payload#>>'{}' returns the JSONB value AS TEXT (the inner string
--     content if the value is a scalar string; a normal JSON dump if the
--     value is an object).
--   - Casting that text back to jsonb parses it. For scalar-string rows
--     this correctly materializes the original object. For already-proper
--     object rows it's a no-op round-trip.
--
-- Guarded by `WHERE jsonb_typeof(...) = 'string'` so proper object rows
-- are not touched at all.

UPDATE job_outbox
SET payload = (payload#>>'{}')::jsonb
WHERE jsonb_typeof(payload) = 'string';

UPDATE inbound_events
SET payload = (payload#>>'{}')::jsonb
WHERE jsonb_typeof(payload) = 'string';

UPDATE review_exceptions
SET payload = (payload#>>'{}')::jsonb
WHERE payload IS NOT NULL AND jsonb_typeof(payload) = 'string';

UPDATE approval_audit_log
SET metadata = (metadata#>>'{}')::jsonb
WHERE metadata IS NOT NULL AND jsonb_typeof(metadata) = 'string';

UPDATE prospect_demos
SET reviews_snapshot = (reviews_snapshot#>>'{}')::jsonb
WHERE reviews_snapshot IS NOT NULL AND jsonb_typeof(reviews_snapshot) = 'string';

UPDATE prospect_demos
SET generated_responses = (generated_responses#>>'{}')::jsonb
WHERE generated_responses IS NOT NULL AND jsonb_typeof(generated_responses) = 'string';

UPDATE weekly_summaries
SET notable_reviews = (notable_reviews#>>'{}')::jsonb
WHERE notable_reviews IS NOT NULL AND jsonb_typeof(notable_reviews) = 'string';

UPDATE businesses
SET tracked_keywords = (tracked_keywords#>>'{}')::jsonb
WHERE tracked_keywords IS NOT NULL AND jsonb_typeof(tracked_keywords) = 'string';
