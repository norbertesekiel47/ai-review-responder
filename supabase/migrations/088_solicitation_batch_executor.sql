-- 088_solicitation_batch_executor.sql
-- Run-spine + persistence foundation for #543's watch-mode Solicitation
-- executor (plan T1; docs/adr/0011-watch-mode-executor-shape.md).
--
-- This migration only represents the run graph and authoritative decisions:
-- the trigger and worker arrive in later tracers. Watch-mode sends nothing.
-- IDs are application-supplied UUIDv7. Run detail/evidence carries ids, enums,
-- dates, and counts only; contact PII remains in solicitation_contacts.
--
-- Additive and re-runnable. No CONCURRENTLY: both domain tables and their
-- indexes are new, and the run-spine CHECK replacements are bounded catalog /
-- validation work. The active-run predicate and three-state run status CHECK
-- are deliberately untouched. Apply staging first, then production, in
-- lockstep only when the high-risk #543 staging lane reaches migration apply.

SET LOCAL lock_timeout = '3s';

-- ── 1. Run-spine parent linkage and Solicitation vocabulary ────────────────

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS parent_run_id UUID;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_parent_run_id_fkey;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_parent_run_id_fkey
  FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_run
  ON agent_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;

-- Strict supersets of migration 071. agent_runs_status_check and
-- agent_runs_one_active_per_subject are intentionally not replaced.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_kind_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_check
  CHECK (kind IN ('review_handler', 'weekly_insights', 'solicitation_batch', 'solicitation_ask'));

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_subject_type_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_subject_type_check
  CHECK (subject_type IN ('review', 'account_week', 'solicitation_batch', 'solicitation_ask'));

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_kind_subject_type_pairing;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_subject_type_pairing CHECK (
  (kind = 'review_handler' AND subject_type = 'review') OR
  (kind = 'weekly_insights' AND subject_type = 'account_week') OR
  (kind = 'solicitation_batch' AND subject_type = 'solicitation_batch') OR
  (kind = 'solicitation_ask' AND subject_type = 'solicitation_ask')
);

ALTER TABLE agent_run_steps
  DROP CONSTRAINT IF EXISTS agent_run_steps_attributed_agent_check;
ALTER TABLE agent_run_steps
  ADD CONSTRAINT agent_run_steps_attributed_agent_check
  CHECK (attributed_agent IN ('reply', 'guardian', 'insights', 'solicitation', 'system'));

ALTER TABLE agent_outcomes
  DROP CONSTRAINT IF EXISTS agent_outcomes_attributed_agent_check;
ALTER TABLE agent_outcomes
  ADD CONSTRAINT agent_outcomes_attributed_agent_check
  CHECK (attributed_agent IN ('reply', 'guardian', 'insights', 'solicitation', 'system'));

-- Strict superset of migration 074's outcome-kind domain.
ALTER TABLE agent_outcomes
  DROP CONSTRAINT IF EXISTS agent_outcomes_outcome_kind_check;
ALTER TABLE agent_outcomes
  ADD CONSTRAINT agent_outcomes_outcome_kind_check
  CHECK (outcome_kind IN (
    'reply_drafted', 'reply_posted', 'reply_auto_posted',
    'reply_approved_no_edit', 'reply_edited_by_owner', 'reply_vetoed_by_owner',
    'review_escalated', 'escalation_resolved', 'digest_sent',
    'solicitation_batch_built'
  ));

-- Empty accumulated pools still produce a valid built batch. Zero is legal
-- only for that aggregate; every pre-existing outcome kind stays positive.
ALTER TABLE agent_outcomes
  DROP CONSTRAINT IF EXISTS agent_outcomes_unit_count_check;
ALTER TABLE agent_outcomes
  ADD CONSTRAINT agent_outcomes_unit_count_check
  CHECK (unit_count > 0 OR (outcome_kind = 'solicitation_batch_built' AND unit_count = 0));

-- ── 2. Tenant-safe Solicitation batch and ask persistence ──────────────────

-- Composite target lets a batch prove its source upload belongs to the same
-- account and Business. The leading PK remains the identity/idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS contact_csv_uploads_id_account_business_uniq
  ON contact_csv_uploads (id, account_id, business_id);

CREATE TABLE IF NOT EXISTS solicitation_batches (
  id UUID PRIMARY KEY, -- UUIDv7 supplied by the ingest completion transaction
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL,
  source_upload_id UUID NOT NULL,
  built_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitation_batches_source_upload_uniq UNIQUE (source_upload_id),
  CONSTRAINT solicitation_batches_id_account_business_uniq
    UNIQUE (id, account_id, business_id),
  CONSTRAINT solicitation_batches_business_account_fk
    FOREIGN KEY (business_id, account_id)
    REFERENCES businesses (id, account_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_batches_source_upload_tenant_fk
    FOREIGN KEY (source_upload_id, account_id, business_id)
    REFERENCES contact_csv_uploads (id, account_id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_batches_built_after_created
    CHECK (built_at IS NULL OR built_at >= created_at),
  CONSTRAINT solicitation_batches_reviewed_after_built
    CHECK (reviewed_at IS NULL OR (built_at IS NOT NULL AND reviewed_at >= built_at))
);

CREATE INDEX IF NOT EXISTS idx_solicitation_batches_account_built
  ON solicitation_batches (account_id, built_at DESC)
  WHERE built_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_solicitation_batches_business_created
  ON solicitation_batches (business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS solicitation_asks (
  id UUID PRIMARY KEY, -- UUIDv7 supplied by the batch executor
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  status TEXT NOT NULL,
  withheld_reason TEXT,
  evidence JSONB NOT NULL,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitation_asks_batch_contact_uniq UNIQUE (batch_id, contact_id),
  CONSTRAINT solicitation_asks_business_account_fk
    FOREIGN KEY (business_id, account_id)
    REFERENCES businesses (id, account_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_asks_batch_tenant_fk
    FOREIGN KEY (batch_id, account_id, business_id)
    REFERENCES solicitation_batches (id, account_id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_asks_contact_business_fk
    FOREIGN KEY (contact_id, business_id)
    REFERENCES solicitation_contacts (id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_asks_status_reason_consistency CHECK (
    (status = 'send' AND withheld_reason IS NULL) OR
    (
      status = 'withhold'
      AND withheld_reason IN (
        'no_consent', 'suppressed', 'already_reviewed',
        'stale_visit', 'over_contacted', 'velocity_banked'
      )
    )
  )
);

-- Candidate-window scheduling needs the latest evaluation of every contact;
-- simulated contact history is a separate send-only clock. velocity_banked
-- and every other withhold are absent from the partial send-history index.
CREATE INDEX IF NOT EXISTS idx_solicitation_contacts_business_candidate
  ON solicitation_contacts (business_id, id);
CREATE INDEX IF NOT EXISTS idx_solicitation_visits_business_contact_latest
  ON solicitation_visits (business_id, contact_id, visit_date DESC, upload_id);
CREATE INDEX IF NOT EXISTS idx_solicitation_asks_business_contact_decided
  ON solicitation_asks (business_id, contact_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_solicitation_asks_business_contact_send
  ON solicitation_asks (business_id, contact_id, decided_at DESC)
  WHERE status = 'send';

-- RI support for FK actions whose lookup order is not covered above.
CREATE INDEX IF NOT EXISTS idx_solicitation_asks_account
  ON solicitation_asks (account_id);
CREATE INDEX IF NOT EXISTS idx_solicitation_asks_contact_business
  ON solicitation_asks (contact_id, business_id);
CREATE INDEX IF NOT EXISTS idx_solicitation_asks_agent_run
  ON solicitation_asks (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

ALTER TABLE solicitation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitation_asks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS solicitation_batches_owner_select ON solicitation_batches;
CREATE POLICY solicitation_batches_owner_select ON solicitation_batches
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id() AND built_at IS NOT NULL);

DROP POLICY IF EXISTS solicitation_asks_owner_select ON solicitation_asks;
CREATE POLICY solicitation_asks_owner_select ON solicitation_asks
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

-- Authenticated owners can only read; all writes use server-side Postgres.js.
REVOKE INSERT, UPDATE, DELETE ON solicitation_batches FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON solicitation_asks FROM authenticated;

COMMENT ON COLUMN agent_runs.parent_run_id IS
  'Nullable parent run for logical fan-out. ON DELETE SET NULL keeps children archival-safe.';
COMMENT ON TABLE solicitation_batches IS
  'Solicitation batch lifecycle parent. NULL built_at is pending construction and is hidden by owner SELECT RLS.';
COMMENT ON TABLE solicitation_asks IS
  'Authoritative per-candidate send/withhold decisions. In watch-mode send means would-send only; no transmission occurs.';
COMMENT ON COLUMN solicitation_asks.agent_run_id IS
  'Optional child-run attribution; ON DELETE SET NULL lets asks outlive 180-day run archival.';
