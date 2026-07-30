-- 091 — Send-mode spine lifecycle + physical fan-out primitives (ticket #624)
--
-- Drives: docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md
-- Binding: docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md
--          docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md §3/§5/§9
-- ADR:     docs/adr/0014-send-mode-spine-lifecycle.md
--
-- Additive and re-runnable. Nothing writes solicitation_outreach until #628;
-- the two job_outbox indexes are inert until #628/#630 add their producers
-- (amendment B10 moves the QUEUE_NAMES/typed-helper obligation to them).
--
-- CHECK totality note, applied throughout: a Postgres CHECK rejects only FALSE
-- and PASSES on NULL. 088's own solicitation_asks_status_reason_consistency
-- admits ('withhold', NULL) for exactly that reason — the IN (...) arm yields
-- NULL and FALSE OR NULL is NULL. Every multi-arm CHECK below is therefore
-- wrapped in IS TRUE so a NULL cannot slip past the arm meant to catch it.
-- (Same class of hole 090 closed with IS NOT DISTINCT FROM.)

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── 1. agent_runs: cancelled status + the send-batch parent kind ────────────
--
-- Strict supersets of migration 088's text (NOT 071's — 088 already widened
-- kind, subject_type and the pairing). agent_runs_terminal_consistency and
-- agent_runs_one_active_per_subject are intentionally not replaced: the former
-- is (status='running') = (ended_at IS NULL), which a terminal 'cancelled' row
-- with ended_at set satisfies as FALSE = FALSE; the latter is
-- WHERE status='running', which never covered terminal rows.

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('running', 'completed', 'cancelled', 'failed'));

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_kind_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_check
  CHECK (kind IN (
    'review_handler', 'weekly_insights', 'solicitation_batch',
    'solicitation_ask', 'solicitation_send_batch'
  ));

-- subject_type needs no change: 'solicitation_batch' is already a member and
-- now legitimately pairs with two kinds (the build parent and the send parent).
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_kind_subject_type_pairing;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_subject_type_pairing CHECK (
  (
    (kind = 'review_handler' AND subject_type = 'review') OR
    (kind = 'weekly_insights' AND subject_type = 'account_week') OR
    (kind = 'solicitation_batch' AND subject_type = 'solicitation_batch') OR
    (kind = 'solicitation_ask' AND subject_type = 'solicitation_ask') OR
    (kind = 'solicitation_send_batch' AND subject_type = 'solicitation_batch')
  ) IS TRUE
);

-- ── 2. agent_outcomes: the two send-mode outcome kinds ──────────────────────
--
-- Strict superset of 088's domain. agent_outcomes_unit_count_check is
-- intentionally not replaced: both new kinds carry unit_count = 1, so 088's
-- "zero is legal only for solicitation_batch_built" stays exactly as-is.

ALTER TABLE agent_outcomes
  DROP CONSTRAINT IF EXISTS agent_outcomes_outcome_kind_check;
ALTER TABLE agent_outcomes
  ADD CONSTRAINT agent_outcomes_outcome_kind_check
  CHECK (outcome_kind IN (
    'reply_drafted', 'reply_posted', 'reply_auto_posted',
    'reply_approved_no_edit', 'reply_edited_by_owner', 'reply_vetoed_by_owner',
    'review_escalated', 'escalation_resolved', 'digest_sent',
    'solicitation_batch_built', 'solicitation_sent', 'review_attributed'
  ));

-- ── 3. solicitation_asks: the composite unique the outreach ask FK needs ────
--
-- 088 gave this shape to solicitation_batches and agent_runs but not to asks,
-- which carries only its PK and (batch_id, contact_id). MUST precede §5.

-- Guarded add, not drop-and-re-add: §5's solicitation_outreach_ask_tenant_fk
-- depends on this unique's index, so an unconditional DROP fails on any second
-- apply. Same pg_constraint idiom 088 uses for agent_runs_account_business_id_uniq.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'solicitation_asks'::regclass
      AND conname = 'solicitation_asks_account_business_id_uniq'
  ) THEN
    ALTER TABLE solicitation_asks
      ADD CONSTRAINT solicitation_asks_account_business_id_uniq
      UNIQUE (id, account_id, business_id);
  END IF;
END
$$;

-- ── 4. solicitation_batches: approval / send / halt lifecycle ───────────────

ALTER TABLE solicitation_batches
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_method TEXT,
  ADD COLUMN IF NOT EXISTS approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS veto_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sending_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS halted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS halt_reason TEXT,
  ADD COLUMN IF NOT EXISTS halted_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Approval is a two-way pairing: an approved batch always records HOW, and a
-- method never appears without an approval. approved_by_user_id is present
-- exactly for owner approvals — an auto_policy approval has no acting user.
ALTER TABLE solicitation_batches
  DROP CONSTRAINT IF EXISTS solicitation_batches_approval_consistency;
ALTER TABLE solicitation_batches
  ADD CONSTRAINT solicitation_batches_approval_consistency CHECK (
    (
      (approved_at IS NULL) = (approval_method IS NULL)
      AND (approval_method IS NULL OR approval_method IN ('owner', 'auto_policy'))
      AND (approved_by_user_id IS NOT NULL) = ((approval_method = 'owner') IS TRUE)
    ) IS TRUE
  );

-- Halt is the same shape. send_window_elapsed and batch_expired are
-- system-derived and carry no actor.
ALTER TABLE solicitation_batches
  DROP CONSTRAINT IF EXISTS solicitation_batches_halt_consistency;
ALTER TABLE solicitation_batches
  ADD CONSTRAINT solicitation_batches_halt_consistency CHECK (
    (
      (halted_at IS NULL) = (halt_reason IS NULL)
      AND (
        halt_reason IS NULL OR halt_reason IN (
          'owner_veto', 'owner_halt', 'admin_halt',
          'send_window_elapsed', 'batch_expired'
        )
      )
      AND (halted_by IS NOT NULL)
          = ((halt_reason IN ('owner_veto', 'owner_halt', 'admin_halt')) IS TRUE)
    ) IS TRUE
  );

-- The full transition graph, not just its sending arm. Approval implies built
-- content: without that arm an approved-but-unbuilt batch is legal, and it
-- enters solicitation_batches_one_active_send_per_business below (which keys on
-- approved_at IS NOT NULL) while deriveBatchState reports it 'approved' — a
-- live send over content that does not exist.
--
-- Closure deliberately does NOT imply approval: D14's generation_failed and
-- B7's batch expiry both close a batch that was never approved, and a blanket
-- "closed implies approved" CHECK would reject them. That carve-out is why
-- closure is tied to built_at and to each optional stamp individually.
ALTER TABLE solicitation_batches
  DROP CONSTRAINT IF EXISTS solicitation_batches_send_ordering;
ALTER TABLE solicitation_batches
  ADD CONSTRAINT solicitation_batches_send_ordering CHECK (
    (
      -- approval implies built content, and never precedes it. The first arm is
      -- deliberately explicit even though the second already rejects a NULL
      -- built_at through the IS TRUE wrapper: stating the rule beats relying on
      -- three-valued logic to produce it as a side effect.
      (approved_at IS NULL OR built_at IS NOT NULL)
      AND (approved_at IS NULL OR approved_at >= built_at)
      -- the veto window is an artifact of approval
      AND (veto_deadline_at IS NULL OR approved_at IS NOT NULL)
      AND (veto_deadline_at IS NULL OR veto_deadline_at >= approved_at)
      -- sending implies approval, and never precedes it
      AND (sending_started_at IS NULL OR approved_at IS NOT NULL)
      AND (sending_started_at IS NULL OR sending_started_at >= approved_at)
      -- closure implies built, and never precedes the events it closes
      AND (send_closed_at IS NULL OR built_at IS NOT NULL)
      AND (send_closed_at IS NULL OR send_closed_at >= built_at)
      AND (send_closed_at IS NULL OR approved_at IS NULL OR send_closed_at >= approved_at)
      AND (send_closed_at IS NULL OR sending_started_at IS NULL
           OR send_closed_at >= sending_started_at)
      -- the halt latch cannot predate the build it halts
      AND (halted_at IS NULL OR built_at IS NULL OR halted_at >= built_at)
    ) IS TRUE
  );

-- D8: at most one live send per Business.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_batches_one_active_send_per_business
  ON solicitation_batches (business_id)
  WHERE approved_at IS NOT NULL AND send_closed_at IS NULL AND halted_at IS NULL;

-- ── 5. solicitation_outreach: the one artifact table (B1) ───────────────────
--
-- Column list is §3 D5 as amended by B1 (policy_version dropped, lint /
-- moderation / interpolation / consent-snapshot columns absorbed from #623)
-- and B2 (source is 'llm' only — owner edit is out; 'superseded' is a cancel
-- reason). Every tenant FK is composite, replicating 088's asks shape.

CREATE TABLE IF NOT EXISTS solicitation_outreach (
  id                          UUID PRIMARY KEY,
  account_id                  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id                 UUID NOT NULL,
  batch_id                    UUID NOT NULL,
  ask_id                      UUID NOT NULL,
  contact_id                  UUID NOT NULL,

  channel                     TEXT NOT NULL DEFAULT 'email',
  attempt_no                  SMALLINT NOT NULL DEFAULT 1,

  -- artifact: what was approved IS what sends
  source                      TEXT NOT NULL DEFAULT 'llm',
  rendered_subject            TEXT,
  rendered_body               TEXT,
  prompt_version              TEXT NOT NULL,
  prompt_hash                 TEXT NOT NULL,
  interpolation_inputs        JSONB NOT NULL,
  rendered_at                 TIMESTAMPTZ NOT NULL,
  body_redacted_at            TIMESTAMPTZ,

  -- compliance lint + moderation provenance (B1, absorbed from #623)
  ask_lint_version            TEXT NOT NULL,
  lint_detail                 JSONB NOT NULL,
  moderation_status           TEXT NOT NULL,
  moderation_detail           JSONB NOT NULL,

  -- consent snapshot, stamped at dispatch by #630 (nullable until then)
  consent_basis               TEXT,
  consent_attestation_version TEXT,
  consent_row_id              UUID,

  -- lifecycle
  delivery_status             TEXT NOT NULL,
  disposition_reason          TEXT,

  -- delivery + provider result
  queued_at                   TIMESTAMPTZ,
  sending_at                  TIMESTAMPTZ,
  sent_at                     TIMESTAMPTZ,
  provider_message_id         TEXT,
  provider_error              TEXT,

  -- async provider signals: columns, NOT statuses (D13)
  bounced_at                  TIMESTAMPTZ,
  complained_at               TIMESTAMPTZ,
  unsubscribed_at             TIMESTAMPTZ,

  agent_run_id                UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT solicitation_outreach_business_account_fk
    FOREIGN KEY (business_id, account_id)
    REFERENCES businesses (id, account_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_outreach_batch_tenant_fk
    FOREIGN KEY (batch_id, account_id, business_id)
    REFERENCES solicitation_batches (id, account_id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_outreach_contact_business_fk
    FOREIGN KEY (contact_id, business_id)
    REFERENCES solicitation_contacts (id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_outreach_ask_tenant_fk
    FOREIGN KEY (ask_id, account_id, business_id)
    REFERENCES solicitation_asks (id, account_id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_outreach_run_tenant_fk
    FOREIGN KEY (account_id, business_id, agent_run_id)
    REFERENCES agent_runs (account_id, business_id, id)
    ON DELETE SET NULL (agent_run_id)
);

-- CREATE TABLE IF NOT EXISTS does not retrofit constraints onto a pre-existing
-- local test table, so every CHECK below is replaced explicitly on each run.

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_channel_check;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_channel_check
  CHECK (channel IN ('email'));

-- B2: LLM is the only artifact source. Owner edit is out of the map.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_source_check;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_source_check
  CHECK (source IN ('llm'));

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_moderation_status_check;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_moderation_status_check
  CHECK (moderation_status IN ('clean', 'flagged', 'error', 'disabled'));

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_delivery_status_check;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_delivery_status_check
  CHECK (delivery_status IN (
    'rendered', 'queued', 'sending', 'sent',
    'withheld', 'cancelled', 'failed', 'unknown'
  ));

-- Status ↔ reason totality. Note "terminal" and "reason-bearing" are DIFFERENT
-- partitions: the terminal set is (sent, withheld, cancelled, failed, unknown)
-- but a successful send has nothing to explain, so 'sent' takes a NULL reason
-- alongside the three non-terminal statuses. 'unknown' pairs with
-- send_indeterminate exclusively — an unknown/send_failed row is a
-- contradiction and is made unrepresentable here rather than in code.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_status_reason_consistency;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_status_reason_consistency CHECK (
    (
      (delivery_status IN ('rendered', 'queued', 'sending', 'sent')
        AND disposition_reason IS NULL) OR
      (delivery_status = 'withheld' AND disposition_reason IN (
        'moderation_high', 'render_failed', 'lint_failed',
        'no_consent', 'suppressed', 'unsubscribed'
      )) OR
      (delivery_status = 'cancelled' AND disposition_reason IN (
        'owner_veto', 'owner_halt', 'admin_halt',
        'batch_expired', 'send_window_elapsed', 'superseded'
      )) OR
      (delivery_status = 'failed' AND disposition_reason IN (
        'send_failed', 'send_exhausted'
      )) OR
      (delivery_status = 'unknown' AND disposition_reason = 'send_indeterminate')
    ) IS TRUE
  );

-- Status ↔ lifecycle timestamps. The reason pairing above says nothing about
-- the stamps, which leaves two holes that both wedge real work:
--
--   1. delivery_status='sent' with sent_at NULL. The ArchivalPoller redaction
--      sweep selects on sent_at, so such a row is never a candidate and keeps
--      its rendered body forever — the 90-day retention promise silently does
--      not apply to it.
--   2. A live 'rendered' row carrying a stale sent_at. The sweep filters on
--      sent_at and body_redacted_at only, never on delivery_status, so it would
--      redact a row that has not sent yet, producing a bodyless live attempt
--      that can neither send nor settle — wedging its batch behind
--      solicitation_outreach_one_live_per_ask.
--
-- Both are closed in the data rather than in the sweep's predicate, because the
-- sweep is not the only future reader. Arm 1 subsumes hole 2: once sent_at
-- implies 'sent', a 'rendered' row cannot carry one at all.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_status_timestamp_consistency;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_status_timestamp_consistency CHECK (
    (
      -- sent is the only status that carries sent_at, and it requires it
      (delivery_status = 'sent') = (sent_at IS NOT NULL)
      -- a dispatched status REQUIRES its dispatch stamp. Ordering alone is not
      -- enough: the arms below are vacuous on a NULL, so without these three a
      -- 'sent' row with queued_at NULL is legal — and the daily-send cap (B3)
      -- counts by queued_at, so that dispatch is invisible to the cap and the
      -- account can exceed daily_send_cap. queued_at is required of every
      -- dispatched status for exactly that reason.
      --
      -- sending_at is deliberately NOT required of 'sent': whether the send
      -- worker stamps it before the provider call is #630's contract and no
      -- spec pins it today. Requiring it here would reject a legitimate row if
      -- that worker batches the two writes.
      AND (delivery_status <> 'queued'  OR queued_at IS NOT NULL)
      AND (delivery_status <> 'sending' OR (queued_at IS NOT NULL AND sending_at IS NOT NULL))
      AND (delivery_status <> 'sent'    OR queued_at IS NOT NULL)
      -- and the stamps that ARE present run in order
      AND (sending_at IS NULL OR queued_at IS NOT NULL)
      AND (sending_at IS NULL OR sending_at >= queued_at)
      AND (sent_at IS NULL OR sending_at IS NULL OR sent_at >= sending_at)
      -- a live attempt has not been dispatched yet
      AND (delivery_status <> 'rendered' OR (queued_at IS NULL AND sending_at IS NULL))
      AND (delivery_status <> 'queued'   OR sending_at IS NULL)
    ) IS TRUE
  );

-- Body presence, as three exhaustive rules rather than one disjunction.
-- A single OR-chain admitted a queued row with no body carrying a redaction
-- stamp; queued is dispatchable and must never be bodyless.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_body_presence;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_body_presence CHECK (
    (
      -- bodies are paired
      (rendered_subject IS NULL) = (rendered_body IS NULL)
      -- redaction means gone AND sent
      AND (body_redacted_at IS NULL
        OR (rendered_subject IS NULL AND sent_at IS NOT NULL))
      -- every unredacted, non-withheld row has its bodies
      AND (body_redacted_at IS NOT NULL
        OR delivery_status = 'withheld'
        OR rendered_subject IS NOT NULL)
      -- redaction takes the SOURCE with the prose. interpolation_inputs carries
      -- contact_first_name and visit_note, so a redaction that leaves it behind
      -- deletes the sentence and keeps its ingredients. The ArchivalPoller sweep
      -- empties it, but a sweep is not a guarantee — this is the arm that makes
      -- data minimization a schema fact, so a second future writer of
      -- body_redacted_at cannot stamp a redaction and leave the PII in place.
      AND (body_redacted_at IS NULL OR interpolation_inputs = '{}'::jsonb)
    ) IS TRUE
  );

-- B2's attempt identity: numbers start at 1 and are never reused for an ask.
-- The writer contract is update-old-to-terminal THEN insert attempt_no + 1,
-- both in one transaction.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_attempt_no_check;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_attempt_no_check
  CHECK (attempt_no > 0);

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_ask_attempt_uniq;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_ask_attempt_uniq
  UNIQUE (ask_id, attempt_no);

-- At most one live attempt per ask.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_outreach_one_live_per_ask
  ON solicitation_outreach (ask_id)
  WHERE delivery_status IN ('rendered', 'queued', 'sending');

-- closeBatchIfSettled's settled predicate and status tally.
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_batch_status
  ON solicitation_outreach (batch_id, delivery_status);

-- Daily-cap counting is by DISPATCH ATTEMPT (queued_at), not sent_at (B3).
-- Both levels exist: the account-default policy row carries the per-account
-- cap, a location-override row carries the per-business cap (D19/D20).
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_account_queued
  ON solicitation_outreach (account_id, queued_at);
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_business_queued
  ON solicitation_outreach (business_id, queued_at);

-- ArchivalPoller's 90-day body-redaction sweep. The sent_at IS NOT NULL half is
-- load-bearing: Postgres B-trees index NULL keys, so a predicate of only
-- body_redacted_at IS NULL would permanently hold every never-sent row. With
-- both conjuncts a row enters on send and leaves permanently on redaction.
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_redaction_sweep
  ON solicitation_outreach (sent_at)
  WHERE sent_at IS NOT NULL AND body_redacted_at IS NULL;

-- RI support for FK actions whose lookup order is not covered above. The
-- business-leading requirement is already met by the cap index. Mirrors the
-- shapes 088 added for solicitation_asks.
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_contact_business
  ON solicitation_outreach (contact_id, business_id);
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_agent_run
  ON solicitation_outreach (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

-- D6a: owners read their own outreach so they can approve it — generate-then-
-- approve REQUIRES it. One carve-out: a body withheld by high-severity
-- moderation is never owner-readable, which is invariant #4 read straight
-- across (high-severity reply drafts go to admin-only flagged_responses
-- precisely so the owner is never nudged to approve something unsafe).
ALTER TABLE solicitation_outreach ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS solicitation_outreach_owner_select ON solicitation_outreach;
CREATE POLICY solicitation_outreach_owner_select ON solicitation_outreach
  FOR SELECT TO authenticated
  USING (
    account_id = owner_account_id()
    AND NOT (delivery_status = 'withheld' AND disposition_reason = 'moderation_high')
  );

REVOKE INSERT, UPDATE, DELETE ON solicitation_outreach FROM authenticated;

-- ── 6. auto_approval_policies: the solicitation lane ────────────────────────

ALTER TABLE auto_approval_policies
  ADD COLUMN IF NOT EXISTS daily_send_cap SMALLINT;

ALTER TABLE auto_approval_policies
  DROP CONSTRAINT IF EXISTS auto_approval_policies_persona_check;
ALTER TABLE auto_approval_policies
  ADD CONSTRAINT auto_approval_policies_persona_check
  CHECK (persona IN ('reply', 'solicitation'));

ALTER TABLE auto_approval_policies
  DROP CONSTRAINT IF EXISTS auto_approval_policies_action_class_check;
ALTER TABLE auto_approval_policies
  ADD CONSTRAINT auto_approval_policies_action_class_check
  CHECK (action_class IN ('posting', 'sending'));

-- Loose outer bound only; the pairing CHECK below is what actually constrains
-- each lane's window.
ALTER TABLE auto_approval_policies
  DROP CONSTRAINT IF EXISTS auto_approval_policies_veto_window_check;
ALTER TABLE auto_approval_policies
  ADD CONSTRAINT auto_approval_policies_veto_window_check
  CHECK (veto_window_minutes IN (15, 30, 60));

ALTER TABLE auto_approval_policies
  DROP CONSTRAINT IF EXISTS auto_approval_policies_daily_send_cap_check;
ALTER TABLE auto_approval_policies
  ADD CONSTRAINT auto_approval_policies_daily_send_cap_check
  CHECK (daily_send_cap IS NULL OR (daily_send_cap >= 1 AND daily_send_cap <= 50));

-- Widening persona, action_class and veto_window_minutes INDEPENDENTLY would
-- admit reply+sending, solicitation+posting, and — the subtle one — reply with
-- a 60-minute window, silently loosening the already-live Reply lane that
-- migration 074 pins to (15, 30). One CHECK keeps each persona's whole row
-- consistent. This cannot reject an existing row: 074 already enforced
-- persona='reply', action_class='posting' and veto_window_minutes IN (15,30),
-- so every pre-091 row satisfies the reply arm by construction.
--
-- D19 Correction 2 also excludes each persona from the OTHER lane's dials:
-- otherwise a solicitation row carries a star threshold for an agent that does
-- not read stars — inert nonsense that reads as intent. Safe on existing rows:
-- daily_send_cap is added by this migration (NULL everywhere), and 074 pinned
-- persona IN ('reply'), so no solicitation row can exist yet.
ALTER TABLE auto_approval_policies
  DROP CONSTRAINT IF EXISTS auto_approval_policies_persona_consistency;
ALTER TABLE auto_approval_policies
  ADD CONSTRAINT auto_approval_policies_persona_consistency CHECK (
    (
      (persona = 'reply'
        AND action_class = 'posting'
        AND veto_window_minutes IN (15, 30)
        AND daily_send_cap IS NULL) OR
      (persona = 'solicitation'
        AND action_class = 'sending'
        AND veto_window_minutes IN (30, 60)
        AND auto_approve_min_star IS NULL
        AND daily_auto_post_cap IS NULL)
    ) IS TRUE
  );

-- ── 7. job_outbox: in-flight uniqueness for the two send-mode topics ────────
--
-- The in-flight status set is a byte-for-byte contract owned by
-- src/lib/shared/job-outbox-status.ts and checked for members AND order by
-- ci:outbox-status. It cannot be parameterized — a bind parameter inside an
-- ON CONFLICT ... WHERE defeats partial-index inference — so it is re-spelled
-- here by hand, exactly as every other site does.
--
-- Both are keyed (topic, aggregate_id): job_outbox has no batch_id column,
-- only topic / aggregate_type / aggregate_id / payload. generate_solicitation_asks
-- stores the batch id in aggregate_id, matching the existing batch helper;
-- solicitation_send stores the outreach id.
--
-- Per amendment B10 these ship WITHOUT a QUEUE_NAMES entry or typed helper —
-- those land with their producers in #628/#630, discharged in the same PR as
-- each first raw insert or ci:outbox-seam fails them. Safe because
-- ci:outbox-topics scans src/lib, src/app and worker only, never migrations,
-- and an index with no writer costs nothing while a writer with no index races.

CREATE UNIQUE INDEX IF NOT EXISTS job_outbox_solicitation_send_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'solicitation_send'
    AND status IN ('pending', 'dispatching', 'dispatched');

CREATE UNIQUE INDEX IF NOT EXISTS job_outbox_generate_solicitation_asks_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'generate_solicitation_asks'
    AND status IN ('pending', 'dispatching', 'dispatched');

-- ── Comments ───────────────────────────────────────────────────────────────

COMMENT ON TABLE solicitation_outreach IS
  'One physical send attempt. The single artifact table (B1): what was approved IS what sends. Bodies are redacted after 90 days by ArchivalPoller, not deleted — the row outlives its body.';
COMMENT ON COLUMN solicitation_outreach.attempt_no IS
  'Starts at 1 and is never reused for an ask. Supersession updates the old row to a terminal status, then inserts attempt_no + 1 in the same transaction.';
COMMENT ON COLUMN solicitation_outreach.agent_run_id IS
  'Optional lazy-child run attribution; ON DELETE SET NULL lets outreach facts outlive 180-day run archival.';
COMMENT ON COLUMN solicitation_outreach.provider_error IS
  'Bounded diagnostic text. Must never carry a rendered body (D6e).';
COMMENT ON COLUMN solicitation_batches.send_closed_at IS
  'Set by closeBatchIfSettled via CAS on NULL. Deliberately legal with a NULL approved_at: generation_failed and batch expiry both close a batch that was never approved.';
COMMENT ON COLUMN auto_approval_policies.daily_send_cap IS
  'Per-row send ceiling. The account-default row (location_id IS NULL) carries the per-account cap; a location-override row carries the per-business cap. The resolver applies a platform ceiling of 10 (B3) on top.';

COMMIT;
