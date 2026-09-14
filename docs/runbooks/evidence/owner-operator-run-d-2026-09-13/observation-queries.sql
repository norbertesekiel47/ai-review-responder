-- PREPARATION ONLY: read-only PostgreSQL; not executed.
-- Run against staging kubdiqdhqbhwmqfditeg only, before fixture teardown.
-- Query 1: complete cumulative turn/outbox snapshot and recomputable summaries.
-- Replace attempts_json ONLY with sanitized entries from the UI submission
-- ledger (see notes). [] deliberately means the UI-attempt denominator is unknown.
-- observation_end is this capture's database clock. At final capture it MUST be
-- >= 2026-09-14T21:46:17Z and include the final planned submission's outcome.
WITH parameters AS MATERIALIZED (
  SELECT
    '019f43d0-0000-7000-8000-000000000001'::uuid AS account_id,
    '2026-09-13T21:46:17Z'::timestamptz AS observation_start,
    '2026-09-14T21:46:17Z'::timestamptz AS earliest_end,
    clock_timestamp() AS observation_end,
    '4b13d96621b156a47dbc4140995f45745bc8114d'::text AS declared_candidate_sha,
    '[]'::jsonb AS attempts_json
), submission_ledger AS MATERIALIZED (
  SELECT l.*,
    l.account_id = p.account_id AS tenant_matches,
    l.attempted_at >= p.observation_start AND l.attempted_at <= p.observation_end AS in_window
  FROM parameters p
  CROSS JOIN LATERAL jsonb_to_recordset(p.attempts_json) AS l(
    attempt_id text, slot integer, attempted_at timestamptz,
    account_id uuid, turn_id text, client_turn_key text,
    outcome text, http_status integer
  )
), scoped_turns AS MATERIALIZED (
  SELECT t.id AS turn_id, t.account_id, t.conversation_id, t.location_id,
    t.client_turn_key, t.sequence, t.status, t.failure_reason,
    t.attempt AS current_turn_attempt, (t.attempt_token IS NOT NULL) AS claim_token_present,
    t.created_at AS accepted_at, t.claimed_at AS latest_claimed_at, t.completed_at,
    t.created_at >= p.observation_start AND t.created_at <= p.observation_end AS accepted_in_window,
    CASE WHEN t.completed_at IS NOT NULL
      THEN extract(epoch FROM (t.completed_at - t.created_at))::double precision END AS accepted_to_terminal_seconds,
    CASE WHEN t.claimed_at IS NOT NULL
      THEN extract(epoch FROM (t.claimed_at - t.created_at))::double precision END AS latest_claim_offset_seconds
  FROM parameters p
  JOIN agent_turns t ON t.account_id = p.account_id
  WHERE (t.created_at >= p.observation_start AND t.created_at <= p.observation_end)
    OR EXISTS (
      SELECT 1 FROM submission_ledger l
      WHERE l.tenant_matches AND (
        l.turn_id = t.id::text OR l.client_turn_key = t.client_turn_key::text
      )
    )
), turns_with_outbox AS MATERIALIZED (
  SELECT t.*,
    o.outbox_rows,
    o.outbox_count,
    o.total_dispatch_claims,
    o.observed_redispatch_claims,
    o.outbox_identity_mismatches
  FROM scoped_turns t
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'outbox_id', j.id,
      'aggregate_type', j.aggregate_type,
      'aggregate_id', j.aggregate_id,
      'status', j.status,
      'attempts', j.attempts,
      'max_attempts', j.max_attempts,
      'created_at', j.created_at,
      'available_at', j.available_at,
      'latest_dispatched_or_heartbeat_at', j.dispatched_at,
      'completed_at', j.completed_at,
      'payload_account_matches', j.payload->>'account_id' = t.account_id::text,
      'payload_turn_matches', j.payload->>'turn_id' = t.turn_id::text,
      'payload_conversation_matches', j.payload->>'conversation_id' = t.conversation_id::text,
      'correlation_id', CASE WHEN j.payload->>'correlation_id' ~ '^[0-9A-Za-z_-]{1,128}$' THEN j.payload->>'correlation_id' END,
      'last_error_present', NULLIF(j.last_error, '') IS NOT NULL,
      'last_error_fingerprint_md5', CASE WHEN NULLIF(j.last_error, '') IS NOT NULL THEN md5(j.last_error) END,
      'created_to_latest_dispatch_or_heartbeat_seconds', CASE WHEN j.dispatched_at IS NOT NULL
        THEN extract(epoch FROM (j.dispatched_at - j.created_at))::double precision END
    ) ORDER BY j.created_at, j.id), '[]'::jsonb) AS outbox_rows,
    count(*) AS outbox_count,
    COALESCE(sum(j.attempts), 0) AS total_dispatch_claims,
    COALESCE(sum(greatest(j.attempts - 1, 0)), 0) AS observed_redispatch_claims,
    count(*) FILTER (WHERE j.aggregate_type <> 'agent_turn'
      OR j.payload->>'account_id' IS DISTINCT FROM t.account_id::text
      OR j.payload->>'turn_id' IS DISTINCT FROM t.turn_id::text
      OR j.payload->>'conversation_id' IS DISTINCT FROM t.conversation_id::text) AS outbox_identity_mismatches
    FROM job_outbox j
    WHERE j.topic = 'agent_turn' AND j.aggregate_id = t.turn_id
    -- Tenant authority is the account-scoped turn's UUID, not JSON payload.
  ) o
), completed_samples AS MATERIALIZED (
  SELECT t.* FROM turns_with_outbox t CROSS JOIN parameters p
  WHERE t.accepted_in_window AND t.status = 'completed'
    AND t.completed_at IS NOT NULL
    AND t.completed_at >= t.accepted_at
    AND t.completed_at <= p.observation_end
), status_counts AS (
  SELECT status, failure_reason, count(*) AS turn_count
  FROM turns_with_outbox WHERE accepted_in_window GROUP BY status, failure_reason
), hours AS (
  SELECT s AS hour_start,
    least(s + interval '1 hour', p.observation_end) AS hour_end,
    s + interval '1 hour' <= p.observation_end AS full_hour_elapsed
  FROM parameters p
  CROSS JOIN LATERAL generate_series(p.observation_start, p.observation_end, interval '1 hour') s
), hourly_coverage AS (
  SELECT h.*,
    (SELECT count(*) FROM scoped_turns t WHERE t.accepted_in_window
      AND t.accepted_at >= h.hour_start AND t.accepted_at < h.hour_start + interval '1 hour') AS accepted_turns,
    (SELECT count(*) FROM completed_samples t
      WHERE t.accepted_at >= h.hour_start AND t.accepted_at < h.hour_start + interval '1 hour') AS completed_turns,
    (SELECT count(*) FROM scoped_turns t WHERE t.accepted_in_window AND t.status = 'failed'
      AND t.accepted_at >= h.hour_start AND t.accepted_at < h.hour_start + interval '1 hour') AS failed_turns,
    CASE WHEN jsonb_array_length(p.attempts_json) > 0 THEN
      (SELECT count(*) FROM submission_ledger l WHERE l.tenant_matches AND l.in_window
        AND l.attempted_at >= h.hour_start AND l.attempted_at < h.hour_start + interval '1 hour')
    END AS recorded_ui_submissions
  FROM hours h CROSS JOIN parameters p
), submissions_with_matches AS (
  SELECT l.*, (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'turn_id', t.turn_id, 'status', t.status, 'failure_reason', t.failure_reason,
      'accepted_in_window', t.accepted_in_window,
      'accepted_at', t.accepted_at, 'completed_at', t.completed_at
    ) ORDER BY t.accepted_at, t.turn_id), '[]'::jsonb)
    FROM scoped_turns t
    WHERE l.tenant_matches AND (
      l.turn_id = t.turn_id::text OR l.client_turn_key = t.client_turn_key::text
    )
  ) AS matching_turns
  FROM submission_ledger l
)
SELECT jsonb_build_object(
  'measurement', jsonb_build_object(
    'account_id', p.account_id,
    'observation_start', p.observation_start,
    'snapshot_at_and_observation_end', p.observation_end,
    'earliest_eligible_end', p.earliest_end,
    'full_24_hours_elapsed', p.observation_end >= p.earliest_end,
    'elapsed_seconds', extract(epoch FROM (p.observation_end - p.observation_start)),
    'declared_candidate_sha', p.declared_candidate_sha,
    'deployment_verification', 'Separate retained UI/worker deployment evidence is required',
    'percentile_method', 'PostgreSQL percentile_cont on unrounded completed accepted-to-completed seconds',
    'ui_submission_ledger_supplied', jsonb_array_length(p.attempts_json) > 0
  ),
  'summary', jsonb_build_object(
    'durable_turns_accepted_in_window', (SELECT count(*) FROM scoped_turns WHERE accepted_in_window),
    'recorded_ui_attempts', CASE WHEN jsonb_array_length(p.attempts_json) > 0 THEN
      (SELECT count(*) FROM submission_ledger WHERE tenant_matches AND in_window) END,
    'ledger_rows_without_attempt_time', (SELECT count(*) FROM submission_ledger WHERE attempted_at IS NULL),
    'ledger_tenant_mismatches', (SELECT count(*) FROM submission_ledger WHERE tenant_matches IS DISTINCT FROM true),
    'ledger_attempts_without_durable_match', (SELECT count(*) FROM submissions_with_matches
      WHERE tenant_matches AND in_window AND jsonb_array_length(matching_turns) = 0),
    'ledger_ambiguous_matches', (SELECT count(*) FROM submissions_with_matches WHERE jsonb_array_length(matching_turns) > 1),
    'completed_latency_n', (SELECT count(*) FROM completed_samples),
    'completed_latency_min_seconds', (SELECT min(accepted_to_terminal_seconds) FROM completed_samples),
    'completed_latency_p50_seconds', (SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY accepted_to_terminal_seconds) FROM completed_samples),
    'completed_latency_p95_seconds', (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY accepted_to_terminal_seconds) FROM completed_samples),
    'completed_latency_max_seconds', (SELECT max(accepted_to_terminal_seconds) FROM completed_samples),
    'completed_rows_excluded_for_invalid_or_future_timestamp', (SELECT count(*) FROM scoped_turns t
      WHERE accepted_in_window AND status = 'completed' AND NOT EXISTS
        (SELECT 1 FROM completed_samples c WHERE c.turn_id = t.turn_id)),
    'nonterminal_turns', (SELECT count(*) FROM scoped_turns WHERE accepted_in_window AND status IN ('accepted', 'running')),
    'turns_missing_outbox', (SELECT count(*) FROM turns_with_outbox WHERE accepted_in_window AND outbox_count = 0),
    'turns_with_multiple_outbox_rows', (SELECT count(*) FROM turns_with_outbox WHERE accepted_in_window AND outbox_count > 1),
    'outbox_identity_mismatches', (SELECT COALESCE(sum(outbox_identity_mismatches), 0) FROM turns_with_outbox WHERE accepted_in_window),
    'observed_outbox_redispatch_claims', (SELECT COALESCE(sum(observed_redispatch_claims), 0) FROM turns_with_outbox WHERE accepted_in_window),
    'full_hours_with_accepted_turn', (SELECT count(*) FROM hourly_coverage WHERE full_hour_elapsed AND accepted_turns > 0),
    'full_hours_elapsed', (SELECT count(*) FROM hourly_coverage WHERE full_hour_elapsed)
  ),
  'status_and_failure_counts', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY status, failure_reason), '[]'::jsonb) FROM status_counts s),
  'hourly_coverage', (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY hour_start), '[]'::jsonb) FROM hourly_coverage h),
  'every_retained_turn', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY accepted_at, turn_id), '[]'::jsonb) FROM turns_with_outbox t),
  'every_supplied_submission', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY attempted_at NULLS FIRST, attempt_id), '[]'::jsonb) FROM submissions_with_matches l)
) AS observation_snapshot
FROM parameters p;

-- Query 2: account/location-scoped Operator cost records, kept SEPARATE from
-- turns. These are temporal account records, NOT per-turn attribution.
-- Do not join on overlapping timestamps or assign nearest-cost rows to turns.
WITH p AS MATERIALIZED (
  SELECT '019f43d0-0000-7000-8000-000000000001'::uuid AS account_id,
    '2026-09-13T21:46:17Z'::timestamptz AS starts_at,
    clock_timestamp() AS captured_at
), audit_rows AS MATERIALIZED (
SELECT c.id AS api_cost_id, c.account_id, c.business_id, c.created_at,
  c.provider, c.endpoint, c.input_tokens, c.output_tokens, c.cost_usd,
  c.response_id, c.system_prompt_hash, c.prompt_version, c.latency_ms,
  'account/location observation-window cost row; no durable turn link'::text AS attribution_limit
FROM p JOIN api_costs c ON c.account_id = p.account_id
JOIN businesses b ON b.id = c.business_id AND b.account_id = p.account_id
WHERE c.endpoint = 'owner-operator' AND c.created_at >= p.starts_at AND c.created_at <= p.captured_at
), timed_rows AS (
  SELECT * FROM audit_rows WHERE latency_ms IS NOT NULL AND latency_ms >= 0
)
SELECT jsonb_build_object(
  'attribution', 'Unassigned account/location audit-row latency distribution; not per-turn or per-provider-call attribution',
  'duplicate_duration_limit', 'All-invalid provider attempts can repeat one whole-call latency across multiple audit rows; do not sum latency_ms or deduplicate by time/latency guesses',
  'snapshot_at', p.captured_at,
  'audit_row_count', (SELECT count(*) FROM audit_rows),
  'timed_audit_row_count', (SELECT count(*) FROM timed_rows),
  'missing_or_invalid_latency_rows', (SELECT count(*) FROM audit_rows WHERE latency_ms IS NULL OR latency_ms < 0),
  'audit_row_latency_min_ms', (SELECT min(latency_ms) FROM timed_rows),
  'audit_row_latency_p50_ms', (SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) FROM timed_rows),
  'audit_row_latency_p95_ms', (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FROM timed_rows),
  'audit_row_latency_max_ms', (SELECT max(latency_ms) FROM timed_rows),
  'raw_unassigned_audit_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY created_at, api_cost_id), '[]'::jsonb) FROM audit_rows r)
) AS unassigned_cost_audit_snapshot
FROM p;

-- Query 3: retain anomalous account-claimed Operator outbox records that fail
-- the ordinary turn aggregate binding. No payload text is returned.
WITH p AS (
  SELECT '019f43d0-0000-7000-8000-000000000001'::uuid AS account_id,
    '2026-09-13T21:46:17Z'::timestamptz AS starts_at,
    clock_timestamp() AS captured_at
)
SELECT j.id AS outbox_id, j.aggregate_type, j.aggregate_id, j.status,
  j.attempts, j.max_attempts, j.created_at, j.available_at, j.dispatched_at, j.completed_at,
  t.id AS bound_turn_id,
  j.payload->>'turn_id' = j.aggregate_id::text AS payload_aggregate_matches,
  t.conversation_id::text = j.payload->>'conversation_id' AS conversation_matches,
  NULLIF(j.last_error, '') IS NOT NULL AS last_error_present,
  CASE WHEN NULLIF(j.last_error, '') IS NOT NULL THEN md5(j.last_error) END AS last_error_fingerprint_md5
FROM p JOIN job_outbox j ON j.payload->>'account_id' = p.account_id::text
LEFT JOIN agent_turns t ON t.account_id = p.account_id AND t.id = j.aggregate_id
WHERE j.topic = 'agent_turn' AND j.created_at >= p.starts_at AND j.created_at <= p.captured_at
  AND (t.id IS NULL OR j.aggregate_type <> 'agent_turn'
    OR j.payload->>'turn_id' IS DISTINCT FROM j.aggregate_id::text
    OR j.payload->>'conversation_id' IS DISTINCT FROM t.conversation_id::text)
ORDER BY j.created_at, j.id;
