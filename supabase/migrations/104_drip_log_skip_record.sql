-- 104_drip_log_skip_record.sql
-- #738 (follow-up of #719 step-7 review A3): durable record for SCHEDULER-side
-- Drip staleness cap skips. The cap's two enforcement points were not equally
-- observable: the handler chokepoint completes its outbox row with
-- completion_reason='drip_too_stale' (durable for the ArchivalPoller's 7-day
-- completed-row window), but the scheduler excluded a too-late pair from the
-- candidate query without minting any row at all — leaving only a logger.warn
-- that fires only while the scheduler runs, which is exactly what a long
-- outage stops. A multi-day outage could permanently drop day_1/day_7/day_30
-- for every affected location with nothing behind but log lines.
--
-- These columns make onboarding_drip_log — never touched by ArchivalPoller,
-- one row per (business_id, drip_type) — the permanent record: the scheduler
-- stamps skipped_at/skip_reason for a too-late pair, and that stamp both
-- answers "which drips were dropped as too-late, and when" and replaces the
-- old one-day GRACE+1 reporting window as the candidate-query dedup (so a
-- backlog already past the window at deploy is recorded too, not silently
-- skipped).
--
-- skip_reason vocabulary is owned by DRIP_SKIP_REASONS in
-- worker/jobs/OnboardingDripWorker.ts ('drip_too_stale' — deliberately the
-- same spelling as OUTBOX_COMPLETION_REASON.DRIP_TOO_STALE, so one grep finds
-- both enforcement points). No CHECK on the value: the vocabulary lives in TS
-- like job_outbox.completion_reason's (migration 083).
--
-- Both CHECKs pass on every existing row (new columns are NULL everywhere) —
-- no preflight needed. Additive nullable columns are metadata-only, but bound
-- the brief ACCESS EXCLUSIVE lock anyway (083 precedent). Constraints are
-- guarded on pg_constraint so the migration stays re-runnable.
-- Apply staging first, then prod in lockstep.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE onboarding_drip_log
  ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS skip_reason TEXT;

DO $$
BEGIN
  -- A skip is stamped whole or not at all: skipped_at and skip_reason are
  -- paired, so a skip row is always self-describing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'onboarding_drip_log_skip_pairing'
  ) THEN
    ALTER TABLE onboarding_drip_log
      ADD CONSTRAINT onboarding_drip_log_skip_pairing
      CHECK ((skipped_at IS NULL) = (skip_reason IS NULL));
  END IF;

  -- A skip and a send are mutually exclusive outcomes for a pair. Unreachable
  -- by construction (the handler chokepoint refuses a too-stale drip BEFORE
  -- the claim, and staleness is monotone), so a violation here is a loud
  -- logic-bug signal rather than a silent contradiction in the record.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'onboarding_drip_log_skip_send_exclusive'
  ) THEN
    ALTER TABLE onboarding_drip_log
      ADD CONSTRAINT onboarding_drip_log_skip_send_exclusive
      CHECK (skipped_at IS NULL OR sent_at IS NULL);
  END IF;
END $$;

COMMIT;
