-- Migration 071: agent run spine — agent_runs, agent_run_steps, agent_outcomes
--
-- Phase 1 WS1 of the agentic platform (design doc 2026-07-01 §3.2): attribution
-- data written by the EXISTING pipeline in the SAME transactions as the state
-- changes it describes. NOT an execution engine — no lifecycle machinery here.
--
-- detail JSONB carries ids/enums/counts ONLY — never raw review/response text
-- (logging rules). Deny-all RLS on all three tables (server-only writes; owner
-- reads arrive in WS5 via server routes), same posture as analytics_events (049).
--
-- Additive; transactional (no CONCURRENTLY — all three tables are new, so the
-- index builds are instant). Apply staging first, then production, both
-- Supabase projects in lockstep.

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('review_handler', 'weekly_insights')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('review', 'account_week')),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  correlation_id UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  error JSONB,
  CONSTRAINT agent_runs_terminal_consistency
    CHECK ((status = 'running') = (ended_at IS NULL)),
  CONSTRAINT agent_runs_kind_subject_type_pairing CHECK (
    (kind = 'review_handler' AND subject_type = 'review') OR
    (kind = 'weekly_insights' AND subject_type = 'account_week')
  ),
  CONSTRAINT agent_runs_ended_after_started
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- At most one running run per subject: startOrGetActiveRun's ON CONFLICT
-- target — predicate must stay byte-for-byte with the writer's conflict clause.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_subject
  ON agent_runs (kind, subject_type, subject_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_agent_runs_business_started
  ON agent_runs (business_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_account_started
  ON agent_runs (account_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id UUID PRIMARY KEY,
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  attributed_agent TEXT NOT NULL
    CHECK (attributed_agent IN ('reply', 'guardian', 'insights', 'system')),
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'failed', 'skipped')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_run_steps_index_uniq UNIQUE (agent_run_id, step_index)
);

-- No separate (agent_run_id, step_index) index: the agent_run_steps_index_uniq
-- UNIQUE constraint already builds an identical btree index.

CREATE TABLE IF NOT EXISTS agent_outcomes (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  attributed_agent TEXT NOT NULL
    CHECK (attributed_agent IN ('reply', 'guardian', 'insights', 'system')),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN (
    'reply_drafted', 'reply_posted', 'reply_auto_posted',
    'reply_approved_no_edit', 'reply_edited_by_owner',
    'review_escalated', 'escalation_resolved', 'digest_sent'
  )),
  unit_count INTEGER NOT NULL DEFAULT 1 CHECK (unit_count > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retry-safe outcome dedup: recordOutcome's ON CONFLICT target — predicate
-- must stay byte-for-byte with the writer's conflict clause.
CREATE UNIQUE INDEX IF NOT EXISTS agent_outcomes_once_per_run_kind
  ON agent_outcomes (agent_run_id, outcome_kind)
  WHERE agent_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_outcomes_account_occurred
  ON agent_outcomes (account_id, occurred_at DESC);

COMMENT ON TABLE agent_runs IS
  'One attributed agent run per pipeline pass over a subject (review or account-week). Written by the existing pipeline in the same transactions as the state changes it describes; not an execution engine. Application code should pass UUIDv7 ids.';
COMMENT ON COLUMN agent_runs.subject_id IS
  'Polymorphic subject key, no FK by design: a review UUID as a string when subject_type=''review''; a synthetic account-week key when subject_type=''account_week''.';
COMMENT ON COLUMN agent_runs.error IS
  'Failure context as ids/enums/counts only — never raw review/response text (logging rules).';

COMMENT ON TABLE agent_run_steps IS
  'Ordered attribution steps within an agent run; step_index is unique per run.';
COMMENT ON COLUMN agent_run_steps.detail IS
  'Step metadata as ids/enums/counts only — never raw review/response text (logging rules).';

COMMENT ON TABLE agent_outcomes IS
  'Durable per-agent outcome facts (drafted/posted/escalated/…) for attribution and reporting; deduped per (agent_run_id, outcome_kind) when run-linked.';

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_outcomes ENABLE ROW LEVEL SECURITY;
-- Deny-all: RLS enabled, NO policies. Server reaches these via the
-- RLS-bypassing postgres role only (same as analytics_events, migration 049).
