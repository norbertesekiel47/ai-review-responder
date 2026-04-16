-- Add claimed_at to weekly_summaries for atomic claim before processing
ALTER TABLE weekly_summaries ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Add claimed_at to monthly_impact_emails for same purpose
ALTER TABLE monthly_impact_emails ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
