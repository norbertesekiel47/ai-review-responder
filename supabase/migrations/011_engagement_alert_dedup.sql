-- Prevents concurrent EngagementMonitorPoller runs from inserting duplicate
-- engagement alerts for the same business + alert_type.
-- The INSERT ... WHERE NOT EXISTS guard catches most duplicates at the query
-- level, but under READ COMMITTED two concurrent statements can both observe
-- no matching row. This index makes one of them fail with 23505.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_engagement_alert_inflight
  ON job_outbox (aggregate_id, (payload->>'alert_type'))
  WHERE topic = 'engagement_alert'
    AND status IN ('pending', 'dispatched');
