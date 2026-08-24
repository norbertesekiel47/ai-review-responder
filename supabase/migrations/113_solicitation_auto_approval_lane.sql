-- 113_solicitation_auto_approval_lane.sql
--
-- #631 Auto-approval lane: two dedup indexes for the new
-- solicitation_veto_notice topic/template. 074 §4 shape (pending_post_notice
-- precedent) — index-only, no columns, no CHECKs (091 already widened
-- auto_approval_policies for this lane per D19).
--
-- (a) In-flight outbox dedup on job_outbox (topic, aggregate_id). The status
--     literal is a byte-for-byte contract owned by
--     src/lib/shared/job-outbox-status.ts and re-spelled by hand at every
--     site (ci:outbox-status checks members AND order) — never parameterize
--     it, a bind parameter inside an ON CONFLICT … WHERE defeats partial-
--     index inference.
-- (b) Claim-before-send dedup on notification_deliveries (entity_id, channel,
--     recipient). entity_id is 076's generic non-response notice entity key;
--     for this template it carries the solicitation_batches id.
--
-- Plain CREATE INDEX (not CONCURRENTLY, which cannot run inside a migration
-- transaction): both predicates are brand-new topic/template values with zero
-- existing rows in every environment, so the build is instant and the lock
-- moot (112's precedent).

CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_solicitation_veto_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'solicitation_veto_notice'
    AND status IN ('pending', 'dispatching', 'dispatched');

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_solicitation_veto_notice_claim
  ON notification_deliveries (entity_id, channel, recipient)
  WHERE entity_id IS NOT NULL AND template = 'solicitation_veto_notice';
