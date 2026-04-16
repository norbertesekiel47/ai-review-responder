-- =============================================================================
-- Fix: exclude partner_satisfaction_alert from the broad engagement-alert
-- dedup index (migration 011). The broad index keys on (aggregate_id, alert_type)
-- without week, which means a pending satisfaction alert from last week blocks
-- this week's valid alert. Replace with a week-scoped index for satisfaction
-- alerts specifically.
-- =============================================================================

-- Drop the old broad index that conflicts
DROP INDEX IF EXISTS idx_jo_engagement_alert_inflight;

-- Recreate it excluding partner_satisfaction_alert
-- (owner_nudge, partner_engagement_alert, partner_escalation_alert, partner_low_engagement
-- are still one-per-business-at-a-time, which is correct)
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_engagement_alert_inflight
  ON job_outbox (aggregate_id, (payload->>'alert_type'))
  WHERE topic = 'engagement_alert'
    AND status IN ('pending', 'dispatching', 'dispatched')
    AND payload->>'alert_type' <> 'partner_satisfaction_alert';

-- Week-scoped dedup index for partner_satisfaction_alert only
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_satisfaction_alert_weekly
  ON job_outbox (aggregate_id, (payload->'satisfaction'->>'week_start_date'))
  WHERE topic = 'engagement_alert'
    AND status IN ('pending', 'dispatching', 'dispatched')
    AND payload->>'alert_type' = 'partner_satisfaction_alert';
