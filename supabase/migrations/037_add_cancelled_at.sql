-- Add dedicated cancelled_at column to accounts table.
-- CancellationGracePoller needs a stable timestamp for the 30-day grace period.
-- Using updated_at is unreliable because any write to the accounts row resets it.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

COMMENT ON COLUMN accounts.cancelled_at IS
  'Set when subscription_status transitions to cancelled. Used by CancellationGracePoller for 30-day grace period calculation. NULL when subscription is active/past_due/pending_payment.';
