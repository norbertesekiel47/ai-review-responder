-- Supports churn metrics queries in admin overview and business detail APIs.
-- These aggregate scans run every 30s (overview polling) and need indexes to
-- avoid sequential scans as response volume grows.

-- Pending count + approval latency windows
CREATE INDEX IF NOT EXISTS idx_responses_business_status_created
  ON responses(business_id, status, created_at);

-- Approval date lookups for "days since last approval"
CREATE INDEX IF NOT EXISTS idx_responses_business_approved
  ON responses(business_id, approved_at DESC)
  WHERE approved_at IS NOT NULL;
