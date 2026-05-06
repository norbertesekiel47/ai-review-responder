CREATE TABLE IF NOT EXISTS owner_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  business_name TEXT NOT NULL,
  google_maps_url TEXT,
  intent TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT owner_leads_intent_check
    CHECK (intent IN ('waitlist', 'demo')),
  CONSTRAINT owner_leads_status_check
    CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'archived')),
  CONSTRAINT owner_leads_email_intent_key
    UNIQUE (email_normalized, intent)
);

ALTER TABLE owner_leads ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS owner_leads_status_created_idx
  ON owner_leads (status, created_at DESC);

CREATE INDEX IF NOT EXISTS owner_leads_source_created_idx
  ON owner_leads (source, created_at DESC);

COMMENT ON TABLE owner_leads IS
  'Public owner interest captured from marketing pages. Supports waitlist and demo lead intake.';

COMMENT ON COLUMN owner_leads.intent IS
  'Current lead intent. waitlist is used during early access; demo can be used when demo booking returns.';
