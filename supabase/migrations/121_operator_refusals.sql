-- 121_operator_refusals.sql — Owner Operator Run E, spec §6.6.
-- Adds location-scoped content refusals and account-wide policy refusals to
-- the existing ledger. No new table, writer, index, role grant or RLS policy.
-- Apply staging first, then production before deploying the new writers.
-- LOCAL-ONLY until the migrations inventory records remote introspection.
-- The five replacements are atomic; retained C2/C4/C5 still reject incomplete
-- subjects, missing codes and code arrays belonging to another lane.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE refusal_events
  DROP CONSTRAINT refusal_events_refusal_source_check,
  ADD CONSTRAINT refusal_events_refusal_source_check CHECK (refusal_source IN (
    'held_draft', 'auto_post_revoked', 'autonomy_suspended', 'ask_withheld',
    'outreach_withheld', 'batch_halted', 'policy_gate_held',
    'operator_content_refused', 'operator_policy_refused')),
  DROP CONSTRAINT refusal_events_refusal_category_check,
  ADD CONSTRAINT refusal_events_refusal_category_check CHECK (refusal_category IN (
    'unsafe_content', 'watchdog_unavailable', 'below_our_bar', 'no_permission',
    'wrong_moment', 'autonomy_paused', 'missing_information',
    'owner_review_required', 'request_not_allowed')),
  DROP CONSTRAINT refusal_events_subject_type_check,
  ADD CONSTRAINT refusal_events_subject_type_check CHECK (subject_type IN (
    'response', 'solicitation_ask', 'solicitation_outreach',
    'solicitation_batch', 'operator_refusal')),
  DROP CONSTRAINT refusal_events_source_subject_pairing,
  ADD CONSTRAINT refusal_events_source_subject_pairing CHECK (
    (CASE refusal_source
       WHEN 'held_draft' THEN subject_type = 'response'
       WHEN 'policy_gate_held' THEN subject_type = 'response'
       WHEN 'auto_post_revoked' THEN subject_type = 'response'
       WHEN 'ask_withheld' THEN subject_type = 'solicitation_ask'
       WHEN 'outreach_withheld' THEN subject_type = 'solicitation_outreach'
       WHEN 'batch_halted' THEN subject_type = 'solicitation_batch'
       WHEN 'autonomy_suspended' THEN subject_type IS NULL
       WHEN 'operator_content_refused' THEN subject_type = 'operator_refusal'
       WHEN 'operator_policy_refused' THEN subject_type = 'operator_refusal'
     END) IS TRUE
  ),
  DROP CONSTRAINT refusal_events_business_pairing,
  ADD CONSTRAINT refusal_events_business_pairing CHECK (
    (business_id IS NOT NULL) =
      (refusal_source NOT IN ('autonomy_suspended', 'operator_policy_refused'))
  );

COMMENT ON TABLE refusal_events IS
  'The Refusal ledger. One row is one decision RepWorth made not to act, recorded when decided. Nine lanes, nine owner-facing categories. Deny-all RLS: owners read through a server route.';
COMMENT ON COLUMN refusal_events.business_id IS
  'The location; NULL exactly for account-wide autonomy_suspended and operator_policy_refused decisions (C3). Location reads include account-wide rows without multiplying them.';
COMMENT ON COLUMN refusal_events.subject_type IS
  'One of five subject types, or NULL for autonomy_suspended. operator_refusal identifies a server-minted refusal stored in an Operator reply.';

COMMIT;

