-- Migration 073: WS3 Guardian escalation — review_escalations + escalation-notice dedup
--
-- Spec: docs/superpowers/specs/2026-07-07-ws3-guardian-escalation-design.md §2.3.
-- One row per raised escalation; forward-only state machine
-- escalated → acknowledged → resolved (direct escalated → resolved allowed,
-- stamping BOTH timestamps — resolve implies acknowledge). Triage columns are
-- a SNAPSHOT of what Guardian acted on (reviews.triage_* is rewritable by
-- re-triage). agent_run_id is captured at raise so escalation_resolved can be
-- attributed days later, after the run completed (ON DELETE SET NULL).
--
-- RLS: deny-all (enable, no policies — agent_outcomes/migration-071 posture).
-- All access via server routes/workers, app-enforced account scoping.
--
-- Additive; re-runnable (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS); no
-- CONCURRENTLY (brand-new table + zero-row predicates). Apply staging first,
-- then production, both Supabase projects in lockstep.

CREATE TABLE IF NOT EXISTS review_escalations (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id),
  business_id UUID NOT NULL REFERENCES businesses(id),
  review_id UUID NOT NULL REFERENCES reviews(id),
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'escalated',
  triage_severity TEXT NOT NULL,
  triage_source TEXT NOT NULL,
  triage_suggested_action TEXT NOT NULL,
  triage_issues TEXT[],
  escalated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE review_escalations IS
  'Guardian escalations (WS3): one row per raised escalation. Triage columns snapshot what Guardian acted on at raise time.';

ALTER TABLE review_escalations DROP CONSTRAINT IF EXISTS review_escalations_status;
ALTER TABLE review_escalations ADD CONSTRAINT review_escalations_status
  CHECK (status IN ('escalated', 'acknowledged', 'resolved'));

ALTER TABLE review_escalations DROP CONSTRAINT IF EXISTS review_escalations_severity;
ALTER TABLE review_escalations ADD CONSTRAINT review_escalations_severity
  CHECK (triage_severity IN ('low', 'medium', 'high'));

ALTER TABLE review_escalations DROP CONSTRAINT IF EXISTS review_escalations_suggested_action;
ALTER TABLE review_escalations ADD CONSTRAINT review_escalations_suggested_action
  CHECK (triage_suggested_action IN ('escalate', 'respond_and_escalate'));

-- Forward-only state/timestamp consistency. Direct resolve stamps BOTH
-- timestamps, so 'resolved' always implies acknowledged_at IS NOT NULL.
ALTER TABLE review_escalations DROP CONSTRAINT IF EXISTS review_escalations_state_timestamps;
ALTER TABLE review_escalations ADD CONSTRAINT review_escalations_state_timestamps
  CHECK (
    (status = 'escalated'    AND acknowledged_at IS NULL     AND resolved_at IS NULL)
    OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND resolved_at IS NULL)
    OR (status = 'resolved'     AND acknowledged_at IS NOT NULL AND resolved_at IS NOT NULL)
  );

-- One OPEN escalation per review: dedups the cost-cap fallback burst, absorbs
-- the concurrent-generation duplicate-triage race, and allows a NEW escalation
-- after the previous one resolved. Backs raiseEscalation's
-- ON CONFLICT (review_id) WHERE status <> 'resolved', byte-for-byte.
CREATE UNIQUE INDEX IF NOT EXISTS review_escalations_one_open_per_review
  ON review_escalations (review_id) WHERE status <> 'resolved';

COMMENT ON INDEX review_escalations_one_open_per_review IS
  'At most one open (non-resolved) escalation per review. Backs raiseEscalation ON CONFLICT (review_id) WHERE status <> resolved, byte-for-byte.';

-- Dashboard read shape: open escalations per account (WS3 §2.3).
CREATE INDEX IF NOT EXISTS idx_review_escalations_account_status
  ON review_escalations (account_id, status);

-- Deny-all RLS (no policies): server-only access, app-enforced scoping.
ALTER TABLE review_escalations ENABLE ROW LEVEL SECURITY;

-- Claim-before-send dedup for the escalation notice. An escalation is not a
-- response, so the notice claim keys on a new nullable escalation_id column
-- (auto_post_notice keys on response_id — migration 067 precedent).
ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS escalation_id UUID REFERENCES review_escalations(id) ON DELETE SET NULL;

COMMENT ON COLUMN notification_deliveries.escalation_id IS
  'FK to review_escalations for template=escalation_notice deliveries; NULL for every other template.';

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_escalation_notice_claim
  ON notification_deliveries (escalation_id, channel, recipient)
  WHERE escalation_id IS NOT NULL AND template = 'escalation_notice';

COMMENT ON INDEX notification_deliveries_escalation_notice_claim IS
  'Claim-before-send dedup for the escalation notice: at most one delivery per (escalation_id, channel, recipient). Backs claimEscalationNoticeDelivery ON CONFLICT (escalation_id, channel, recipient) WHERE escalation_id IS NOT NULL AND template = escalation_notice, byte-for-byte.';

-- In-flight outbox dedup (mirrors idx_jo_auto_post_notice_inflight, migration 067).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_escalation_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'escalation_notice'
    AND status IN ('pending', 'dispatching', 'dispatched');

COMMENT ON INDEX idx_jo_escalation_notice_inflight IS
  'At-most-one in-flight escalation_notice per escalation. Backs enqueueEscalationNotice ON CONFLICT (topic, aggregate_id) WHERE topic = escalation_notice AND status IN (pending,dispatching,dispatched), byte-for-byte.';
