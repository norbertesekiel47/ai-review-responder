-- Migration 078: WS8 Copilot / Autopilot strict tier contract
--
-- Apply only after migration 077, the strict-code deploy, and controlled smoke.
-- Both NULL-safe data preflights run before any constraint change. The single
-- atomic statement therefore either contracts both tier columns together or
-- leaves both tables untouched for operator repair and a safe re-run.

DO $migration$
DECLARE
  accounts_invalid BOOLEAN;
  businesses_invalid BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.accounts
    WHERE subscription_tier IS NULL
      OR subscription_tier NOT IN ('copilot', 'autopilot')
  )
  INTO accounts_invalid;

  SELECT EXISTS (
    SELECT 1
    FROM public.businesses
    WHERE subscription_tier IS NULL
      OR subscription_tier NOT IN ('copilot', 'autopilot')
  )
  INTO businesses_invalid;

  IF accounts_invalid OR businesses_invalid THEN
    RAISE EXCEPTION
      'migration 078 preflight failed: accounts_invalid=%, businesses_invalid=%',
      accounts_invalid,
      businesses_invalid
      USING ERRCODE = '23514';
  END IF;

  -- accounts.subscription_tier has been NOT NULL since migration 034. Repeat
  -- the declaration so a safe reapply repairs that part of the strict shape.
  ALTER TABLE public.accounts
    ALTER COLUMN subscription_tier SET NOT NULL;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'accounts_subscription_tier_check'
      AND conrelid = 'public.accounts'::regclass
  ) THEN
    ALTER TABLE public.accounts
      DROP CONSTRAINT accounts_subscription_tier_check;
  END IF;
  ALTER TABLE public.accounts
    ADD CONSTRAINT accounts_subscription_tier_check
    CHECK (subscription_tier IN ('copilot', 'autopilot'));

  -- businesses.subscription_tier remains a deprecated write-only mirror, but
  -- its hygiene contract matches the account authority exactly.
  ALTER TABLE public.businesses
    ALTER COLUMN subscription_tier SET NOT NULL;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'businesses_subscription_tier_check'
      AND conrelid = 'public.businesses'::regclass
  ) THEN
    ALTER TABLE public.businesses
      DROP CONSTRAINT businesses_subscription_tier_check;
  END IF;
  ALTER TABLE public.businesses
    ADD CONSTRAINT businesses_subscription_tier_check
    CHECK (subscription_tier IN ('copilot', 'autopilot'));
END
$migration$;
