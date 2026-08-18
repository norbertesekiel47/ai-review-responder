-- 109_outreach_owner_withdrawn_disposition.sql
--
-- Adds 'owner_withdrawn' to solicitation_outreach's CANCEL disposition set so
-- the owner approval lane can record a post-approval Ask withdrawal (#872,
-- ADR 0021). 108 added 'owner_excluded' for the at-approval act; this value is
-- deliberately distinct — Ask exclusion is defined by WHEN it is written (in
-- the approval transaction), and a post-approval row that borrowed its value
-- would misstate when and how it was cancelled.
--
-- Additive and re-runnable: one CHECK is replaced by a wider one. No data
-- change; no row can carry the new value until #872's writer ships. Rollback
-- is re-applying 108's constraint text verbatim — legal while no
-- 'owner_withdrawn' row exists.
--
-- The whole predicate is RE-SPELLED rather than patched: a CHECK cannot be
-- widened in place, and re-spelling keeps this file readable next to 108.
--
-- ONE TRANSACTION, load-bearing (108's reasoning verbatim): psql autocommits
-- each statement, so an unwrapped DROP that succeeds followed by an ADD that
-- fails would leave solicitation_outreach with NO status/reason constraint at
-- all. lock_timeout bounds the ACCESS EXCLUSIVE acquisition so a long
-- Supavisor session cannot make this migration queue behind it.

BEGIN;
SET LOCAL lock_timeout = '3s';

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
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded', 'owner_withdrawn',
        'batch_expired', 'send_window_elapsed', 'superseded'
      )) OR
      (delivery_status = 'failed' AND disposition_reason IN (
        'send_failed', 'send_exhausted'
      )) OR
      (delivery_status = 'unknown' AND disposition_reason = 'send_indeterminate')
    ) IS TRUE
  );

COMMENT ON CONSTRAINT solicitation_outreach_status_reason_consistency ON solicitation_outreach IS
  'Status <-> reason totality. 109 added owner_withdrawn to the cancel set for post-approval Ask withdrawal (#872, ADR 0021); 108 added owner_excluded; every other arm is 091 verbatim.';

COMMIT;
