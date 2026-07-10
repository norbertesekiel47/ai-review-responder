-- Migration 074: WS4 trust dial + veto window
-- (spec docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md
-- §2.1 policy schema, §2.2 rating bands, §2.3 cap accounting (audit-row count
-- per the §6 amendment — no responses-side index), §2.7 notice indexes,
-- §2.8 outcome kind).
--
-- Additive + fully re-runnable (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT
-- IF EXISTS before ADD, DROP INDEX IF EXISTS before CREATE, guarded UPDATE);
-- transactional (no CONCURRENTLY: the new partial indexes have zero-row
-- predicates — 'pending_post_notice' is a brand-new topic/template — and the
-- policies/responses tables are small pre-launch). Apply staging first, then
-- production, both Supabase projects in lockstep.
--
-- APPLY WINDOW: apply this migration in the same maintenance window as
-- deploying the code from its PR. The index rebuild in §1 drops the unique
-- indexes that the PREVIOUS settings.ts upserts' ON CONFLICT clauses infer on,
-- so during the gap between applying 074 and deploying the updated code,
-- `auto_approval_policies` upserts (owner settings save) fail with a
-- no-matching-constraint error. Reads and the auto-approval evaluator are
-- unaffected. Pre-launch accepted tradeoff — documented explicitly rather than
-- keeping redundant transition indexes.

-- ── 1. auto_approval_policies: scope + dial columns ─────────────────────────
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS persona TEXT NOT NULL DEFAULT 'reply';
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS action_class TEXT NOT NULL DEFAULT 'posting';
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS veto_window_minutes SMALLINT NOT NULL DEFAULT 15;
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS daily_auto_post_cap SMALLINT NULL;
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ NULL;
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS suspended_reason TEXT NULL;

COMMENT ON COLUMN auto_approval_policies.persona IS
  'Agent persona this policy row scopes (single-valued today; Solicitation widens the CHECK in its own migration — design §3.3).';
COMMENT ON COLUMN auto_approval_policies.action_class IS
  'Action class this policy row scopes (single-valued today; widened by future personas, not redesigned).';
COMMENT ON COLUMN auto_approval_policies.daily_auto_post_cap IS
  'Per-location daily auto-post cap. NULL = platform default (DEFAULT_DAILY_AUTO_POST_CAP in src/lib/auto-approval/policy.ts).';
COMMENT ON COLUMN auto_approval_policies.suspended_at IS
  'System kill switch (governor/admin — writer lands in WS6). Non-NULL blocks auto-approval via the policy_suspended gate.';

ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_persona_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_persona_check
  CHECK (persona IN ('reply'));
ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_action_class_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_action_class_check
  CHECK (action_class IN ('posting'));
ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_veto_window_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_veto_window_check
  CHECK (veto_window_minutes IN (15, 30));
ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_daily_cap_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_daily_cap_check
  CHECK (daily_auto_post_cap IS NULL OR daily_auto_post_cap BETWEEN 1 AND 50);

-- Positive-quadrant raise BEFORE tightening the threshold CHECK (product
-- unlaunched — user-confirmed 2026-07-07; no grandfathering machinery).
UPDATE auto_approval_policies
SET auto_approve_min_star = 4, updated_at = NOW()
WHERE auto_approve_min_star IS NOT NULL AND auto_approve_min_star < 4;

ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_auto_approve_min_star_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_auto_approve_min_star_check
  CHECK (auto_approve_min_star IS NULL OR auto_approve_min_star BETWEEN 4 AND 5);

-- Uniqueness now includes the (persona, action_class) scope. The ON CONFLICT
-- writers in src/lib/auto-approval/settings.ts are updated in the same PR
-- (Task 12) to match these predicates BYTE-FOR-BYTE.
DROP INDEX IF EXISTS auto_approval_policies_one_account_default;
CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_policies_one_account_default
  ON auto_approval_policies (account_id, persona, action_class)
  WHERE location_id IS NULL;
DROP INDEX IF EXISTS auto_approval_policies_one_location_override;
CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_policies_one_location_override
  ON auto_approval_policies (account_id, location_id, persona, action_class)
  WHERE location_id IS NOT NULL;

-- ── 2. responses: veto-window deadline + cap-count index ────────────────────
ALTER TABLE responses ADD COLUMN IF NOT EXISTS auto_post_scheduled_at TIMESTAMPTZ NULL;
COMMENT ON COLUMN responses.auto_post_scheduled_at IS
  'Auto-approved publish deadline (veto window end). Single source of truth for the notice copy, approve-page scheduled state, and veto guard. NULL for every owner-approved response; cleared by the owner veto. The publisher kill-switch downgrade deliberately leaves it — the stale value is inert because every consumer keys on status=approved AND approval_method=auto_policy plus a future deadline. WS4 spec §2.5.';

-- Daily-cap accounting read (§2.3, amended §6): the count moved from
-- responses to approval_audit_log rows (action='auto_approved_by_policy') —
-- durable and never mutated, so an owner veto (which NULLs
-- responses.approval_method/approved_at) cannot refund the day's slot. That
-- read is served by the existing idx_aal_business (business_id, created_at;
-- migration 002), so the responses-side partial index this migration
-- originally created has no reader; the guarded DROP cleans DBs where an
-- earlier revision of this re-runnable migration already created it.
DROP INDEX IF EXISTS idx_responses_auto_policy_daily_cap;

-- ── 3. agent_outcomes: veto outcome kind ────────────────────────────────────
-- Replicates migration 071's CHECK text with 'reply_vetoed_by_owner' appended
-- after its edit sibling — a strict superset of the previous kind list.
ALTER TABLE agent_outcomes DROP CONSTRAINT IF EXISTS agent_outcomes_outcome_kind_check;
ALTER TABLE agent_outcomes ADD CONSTRAINT agent_outcomes_outcome_kind_check
  CHECK (outcome_kind IN (
    'reply_drafted', 'reply_posted', 'reply_auto_posted',
    'reply_approved_no_edit', 'reply_edited_by_owner', 'reply_vetoed_by_owner',
    'review_escalated', 'escalation_resolved', 'digest_sent'
  ));

-- ── 4. pending_post_notice outbox in-flight + delivery claim indexes ────────
-- In-flight outbox dedup (mirrors idx_jo_auto_post_notice_inflight, 067, and
-- idx_jo_escalation_notice_inflight, 073). Backs enqueuePendingPostNotice's
-- ON CONFLICT (src/lib/shared/job-outbox-helpers.ts, Task 4) byte-for-byte.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_pending_post_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'pending_post_notice' AND status IN ('pending', 'dispatching', 'dispatched');

-- Claim-before-send dedup (067 shape — the notice is about a response, so it
-- keys on response_id like auto_post_notice). Backs
-- claimPendingPostNoticeDelivery's ON CONFLICT (src/lib/notifications/
-- delivery.ts, Task 6) byte-for-byte.
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_pending_post_notice_claim
  ON notification_deliveries (response_id, channel, recipient)
  WHERE response_id IS NOT NULL AND template = 'pending_post_notice';
