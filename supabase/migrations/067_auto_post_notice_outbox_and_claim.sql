-- =====================================================================
-- 067_auto_post_notice_outbox_and_claim.sql
--
-- Backing indexes for the auto-approved "your response was posted" FYI
-- (Workstream B of the channels-rollout plan). Two PARTIAL UNIQUE indexes:
--
--   1. idx_jo_auto_post_notice_inflight — in-flight dedup on job_outbox.
--      Mirrors idx_jo_publish_response_inflight (migration 026). Its predicate
--      MUST match enqueueAutoPostNotice's ON CONFLICT clause BYTE-FOR-BYTE
--      (src/lib/shared/job-outbox-helpers.ts) or Postgres rejects the clause
--      with "no matching unique constraint". A full (topic, aggregate_id)
--      unique index would over-constrain every other topic — the partial
--      predicate scopes it to auto_post_notice only.
--
--   2. notification_deliveries_auto_post_notice_claim — claim-before-send
--      dedup. Keyed (response_id, channel, recipient) so the FYI dispatcher
--      can claim a row BEFORE the provider send; a crash-after-send retry
--      then re-claims as a no-op instead of duplicating the "we posted this"
--      message. Predicate MUST match the claim INSERT's ON CONFLICT
--      byte-for-byte. Distinct from the (response_id, template) dedup indexes
--      (migrations 024/026) because the FYI fans out to multiple channels per
--      response, so the claim key must include channel + recipient.
--
-- Both predicates match ZERO existing rows (auto_post_notice is a brand-new
-- topic AND a brand-new notification template), so the index builds are
-- instant and SAFE TO APPLY IN A SINGLE TRANSACTION (no CONCURRENTLY needed).
-- No table/column/data/RLS change.
--
-- Apply staging-first, then production, both Supabase projects in lockstep.
-- Verification after apply:
--   SELECT indexname FROM pg_indexes
--    WHERE indexname IN ('idx_jo_auto_post_notice_inflight',
--                        'notification_deliveries_auto_post_notice_claim');
--   -> both present.
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_auto_post_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'auto_post_notice'
    AND status IN ('pending', 'dispatching', 'dispatched');

COMMENT ON INDEX idx_jo_auto_post_notice_inflight IS
  'At-most-one in-flight auto_post_notice per response. Mirrors idx_jo_publish_response_inflight (migration 026). Backs enqueueAutoPostNotice ON CONFLICT (topic, aggregate_id) WHERE topic = auto_post_notice AND status IN (pending,dispatching,dispatched), byte-for-byte.';

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_auto_post_notice_claim
  ON notification_deliveries (response_id, channel, recipient)
  WHERE response_id IS NOT NULL AND template = 'auto_post_notice';

COMMENT ON INDEX notification_deliveries_auto_post_notice_claim IS
  'Claim-before-send dedup for the auto-approved post FYI: at most one delivery per (response_id, channel, recipient). Backs the FYI dispatcher claim INSERT ON CONFLICT (response_id, channel, recipient) WHERE response_id IS NOT NULL AND template = auto_post_notice, byte-for-byte.';
