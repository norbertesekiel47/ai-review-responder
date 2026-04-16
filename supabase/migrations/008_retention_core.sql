-- Sprint 5A: Retention core — monthly impact emails + notification delivery index
-- Monthly impact email idempotency
-- NOTE: No DEFAULT on id — app must supply UUIDv7, same convention as all tables
-- after migration 002 dropped gen_random_uuid() defaults.
CREATE TABLE IF NOT EXISTS monthly_impact_emails (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month_start_date DATE NOT NULL,
  summary_text TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, month_start_date)
);

ALTER TABLE monthly_impact_emails ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_monthly_impact_emails_business_month
  ON monthly_impact_emails(business_id, month_start_date DESC);

-- Speeds cooldown checks for engagement alerts and value-email delivery records.
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_business_template_sent
  ON notification_deliveries(business_id, template, sent_at DESC)
  WHERE sent_at IS NOT NULL;
