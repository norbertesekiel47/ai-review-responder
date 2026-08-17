-- 108_outreach_owner_excluded_disposition.sql
--
-- Adds 'owner_excluded' to solicitation_outreach's CANCEL disposition set so
-- the owner approval lane (#629, executor spec D23) can record a per-ask
-- exclusion. 091 shipped the cancel set without it — the term existed only in
-- the spec — so partial approval could not be written at all.
--
-- Additive and re-runnable: one CHECK is replaced by a wider one. No data
-- change; no row can carry the new value until #629's writer ships. Rollback
-- is re-applying 091's constraint text verbatim.
--
-- The whole predicate is RE-SPELLED rather than patched: a CHECK cannot be
-- widened in place, and re-spelling keeps this file readable next to 091.

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
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded',
        'batch_expired', 'send_window_elapsed', 'superseded'
      )) OR
      (delivery_status = 'failed' AND disposition_reason IN (
        'send_failed', 'send_exhausted'
      )) OR
      (delivery_status = 'unknown' AND disposition_reason = 'send_indeterminate')
    ) IS TRUE
  );

COMMENT ON CONSTRAINT solicitation_outreach_status_reason_consistency ON solicitation_outreach IS
  'Status <-> reason totality. 108 added owner_excluded to the cancel set for the owner approval lane (#629 D23); every other arm is 091 verbatim.';
