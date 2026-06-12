-- 064: explicit post-pay wizard completion stamp.
--
-- /api/auth/signup-status previously inferred "wizard ran after Stripe" from
-- a timestamp proxy (businesses.updated_at > accounts.subscription_activated_at
-- + 2s) that could false-positive when the PlaceIdValidationWorker's UPDATE
-- landed after activation. The wizard route (/api/onboarding/business) now
-- stamps this column in its own transaction; signup-status reads the column
-- directly. Audit ref: launch-ready-part1 "Signup wizard-complete signal is a
-- timestamp proxy".

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarding_wizard_completed_at TIMESTAMPTZ;

-- Backfill using the exact proxy predicate the route used until now, so
-- pre-migration accounts keep their current businessOnboarded answer.
UPDATE accounts a
SET onboarding_wizard_completed_at = b.updated_at
FROM businesses b
WHERE b.account_id = a.id
  AND b.is_primary = TRUE
  AND a.subscription_activated_at IS NOT NULL
  AND b.updated_at > a.subscription_activated_at + INTERVAL '2 seconds'
  AND a.onboarding_wizard_completed_at IS NULL;
