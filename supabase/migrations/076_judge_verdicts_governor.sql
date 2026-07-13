-- Migration 076: WS6 judge verdicts + governor support objects
--
-- Spec: docs/superpowers/specs/2026-07-13-ws6-judge-governor-design.md §2.3.
-- Stores one server-only judge verdict per posted response and adds the indexes
-- used by the judge sweep, judge health checks, and suspension notice/admin
-- alert claim paths.
--
-- Additive + fully re-runnable (CREATE TABLE/INDEX IF NOT EXISTS and ADD COLUMN
-- IF NOT EXISTS); transactional; no CONCURRENTLY. judge_verdicts is new, and
-- the topic/template predicates are zero-row before the WS6 code deploy. The
-- responses table is still pre-launch-sized. Apply staging first, then
-- production, both Supabase projects in lockstep.

-- ── 1. Server-only judge verdicts ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS judge_verdicts (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  response_id UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  agent_run_id UUID NULL REFERENCES agent_runs(id) ON DELETE SET NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'warn', 'flag', 'error')),
  reasons JSONB NULL,
  rationale TEXT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (response_id)
);

COMMENT ON TABLE judge_verdicts IS
  'Post-hoc LLM judge verdicts for auto-policy responses. One verdict per response; server-only, deny-all RLS. Application code supplies UUIDv7 ids.';
COMMENT ON COLUMN judge_verdicts.reasons IS
  'Judge reason category enums only; never raw review or response text.';
COMMENT ON COLUMN judge_verdicts.agent_run_id IS
  'Latest review-subject agent run at verdict-write time; nullable for orphan tolerance and SET NULL if the run is deleted.';

CREATE INDEX IF NOT EXISTS idx_judge_verdicts_account_created
  ON judge_verdicts (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_judge_verdicts_created
  ON judge_verdicts (created_at DESC);

-- RI support for child-side FK actions. account_id is covered by
-- idx_judge_verdicts_account_created and response_id by the UNIQUE constraint;
-- these three prevent business/review CASCADE and agent-run SET NULL triggers
-- from scanning judge_verdicts.
CREATE INDEX IF NOT EXISTS idx_judge_verdicts_business
  ON judge_verdicts (business_id);

CREATE INDEX IF NOT EXISTS idx_judge_verdicts_review
  ON judge_verdicts (review_id);

CREATE INDEX IF NOT EXISTS idx_judge_verdicts_agent_run
  ON judge_verdicts (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

ALTER TABLE judge_verdicts ENABLE ROW LEVEL SECURITY;
-- Deny-all: RLS enabled, NO policies. Server reaches the table through the
-- RLS-bypassing postgres role only (agent-run spine/migration-071 posture).
REVOKE INSERT, UPDATE, DELETE ON judge_verdicts FROM authenticated;

-- ── 2. Judge sweep + health query support ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_responses_auto_policy_posted
  ON responses (posted_at DESC)
  WHERE status = 'posted' AND approval_method = 'auto_policy';

-- In-flight judge work dedup. Backs enqueueJudgeVerdict's ON CONFLICT
-- predicate byte-for-byte.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_judge_verdict_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'judge_verdict' AND status IN ('pending', 'dispatching', 'dispatched');

-- ── 3. Suspension notice delivery claim + outbox dedup ─────────────────────
-- Generic entity key for notice families that are not response-anchored.
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS entity_id UUID;

COMMENT ON COLUMN notification_deliveries.entity_id IS
  'Generic non-response notice entity key. WS6 uses the autonomy suspension event id; NULL for response-anchored templates.';

-- Backs claimAutonomySuspendedNoticeDelivery's ON CONFLICT predicate
-- byte-for-byte. response_id remains NULL for this template.
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_autonomy_suspended_claim
  ON notification_deliveries (entity_id, channel, recipient)
  WHERE entity_id IS NOT NULL AND template = 'autonomy_suspended_notice';

-- Both notice topics use the suspension event id as aggregate_id. These
-- predicates must stay byte-for-byte with their enqueue helpers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_autonomy_suspended_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'autonomy_suspended_notice' AND status IN ('pending', 'dispatching', 'dispatched');

CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_autonomy_admin_alert_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'autonomy_admin_alert' AND status IN ('pending', 'dispatching', 'dispatched');
