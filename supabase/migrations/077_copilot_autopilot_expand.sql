-- Migration 077: WS8 Copilot / Autopilot expansion + quiesced normalization
--
-- This is the expand step in the only supported rollout path:
--   quiesce -> provider-wide Stripe preflight -> 077 -> strict code -> smoke
--   -> 078 -> resume.
--
-- The migration is one atomic statement, uses direct SQL constants only, and
-- is fully re-runnable. Whether accounts.price_variant existed before this
-- statement is the first-apply sentinel. Only the first apply rewrites data;
-- later applies repair defaults, the value CHECK, and the immutable-variant
-- function/trigger without changing account or business rows.
--
-- There is deliberately no Stripe/Redis/TypeScript dependency and no outbox or
-- reconciliation enqueue. The required preflight has already proved that no
-- nonterminal Stripe subscription quantity exists to preserve.

DO $migration$
DECLARE
  first_apply BOOLEAN;
BEGIN
  SELECT NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.accounts'::regclass
      AND attname = 'price_variant'
      AND NOT attisdropped
  )
  INTO first_apply;

  -- Add nullable first so the complete first-apply snapshot can be written in
  -- one UPDATE. SET NOT NULL follows after that unconditional normalization.
  ALTER TABLE public.accounts
    ADD COLUMN IF NOT EXISTS price_variant TEXT DEFAULT 'list',
    ADD COLUMN IF NOT EXISTS checkout_attempt_id UUID,
    ADD COLUMN IF NOT EXISTS checkout_session_id TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_state TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_tier TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_price_variant TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_base_price_id TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_overage_price_id TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_base_price_cents INTEGER,
    ADD COLUMN IF NOT EXISTS checkout_attempt_overage_price_cents INTEGER,
    ADD COLUMN IF NOT EXISTS checkout_attempt_locations_included INTEGER,
    ADD COLUMN IF NOT EXISTS checkout_attempt_locations_paid INTEGER,
    ADD COLUMN IF NOT EXISTS checkout_attempt_overage_quantity INTEGER,
    ADD COLUMN IF NOT EXISTS checkout_attempt_trial_period_days INTEGER,
    ADD COLUMN IF NOT EXISTS checkout_attempt_tax_enabled BOOLEAN,
    ADD COLUMN IF NOT EXISTS checkout_attempt_customer_email TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_success_url TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_cancel_url TEXT,
    ADD COLUMN IF NOT EXISTS checkout_attempt_updated_at TIMESTAMPTZ;

  IF first_apply THEN
    UPDATE public.accounts
    SET
      subscription_tier = 'copilot',
      price_variant = 'list',
      base_price_cents = 2900,
      locations_overage_price_cents = 1500,
      locations_included = 1,
      locations_paid = 0;

    -- Deprecated write-only compatibility mirror. It is normalized only in
    -- the same first-apply window as accounts; reapplication never rewrites it.
    UPDATE public.businesses
    SET subscription_tier = 'copilot';
  END IF;

  -- Launch defaults. locations_paid already has the canonical DEFAULT 0 from
  -- migration 034; it is nevertheless explicitly written above on first apply.
  ALTER TABLE public.accounts
    ALTER COLUMN subscription_tier SET DEFAULT 'copilot',
    ALTER COLUMN price_variant SET DEFAULT 'list',
    ALTER COLUMN price_variant SET NOT NULL,
    ALTER COLUMN base_price_cents SET DEFAULT 2900,
    ALTER COLUMN locations_overage_price_cents SET DEFAULT 1500,
    ALTER COLUMN locations_included SET DEFAULT 1;

  ALTER TABLE public.businesses
    ALTER COLUMN subscription_tier SET DEFAULT 'copilot';

  -- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Replacing the named CHECK
  -- makes a reapply repair a stale/widened definition instead of trusting name
  -- presence alone. Strict tier CHECKs intentionally wait for migration 078.
  ALTER TABLE public.accounts
    DROP CONSTRAINT IF EXISTS accounts_price_variant_check;
  ALTER TABLE public.accounts
    ADD CONSTRAINT accounts_price_variant_check
    CHECK (price_variant IN ('list', 'founding'));

  -- One account row owns the authoritative Checkout attempt lease. A
  -- `creating` lease is durable before the provider side effect and therefore
  -- gives retries one stable attempt/idempotency identity. An exposed Session
  -- is always attached to a complete immutable tier/Price/snapshot tuple.
  ALTER TABLE public.accounts
    DROP CONSTRAINT IF EXISTS accounts_checkout_attempt_complete_check;
  ALTER TABLE public.accounts
    ADD CONSTRAINT accounts_checkout_attempt_complete_check CHECK (
      (
        checkout_attempt_state IS NULL
        AND checkout_attempt_id IS NULL
        AND checkout_session_id IS NULL
        AND checkout_attempt_tier IS NULL
        AND checkout_attempt_price_variant IS NULL
        AND checkout_attempt_base_price_id IS NULL
        AND checkout_attempt_overage_price_id IS NULL
        AND checkout_attempt_base_price_cents IS NULL
        AND checkout_attempt_overage_price_cents IS NULL
        AND checkout_attempt_locations_included IS NULL
        AND checkout_attempt_locations_paid IS NULL
        AND checkout_attempt_overage_quantity IS NULL
        AND checkout_attempt_trial_period_days IS NULL
        AND checkout_attempt_tax_enabled IS NULL
        AND checkout_attempt_customer_email IS NULL
        AND checkout_attempt_success_url IS NULL
        AND checkout_attempt_cancel_url IS NULL
        AND checkout_attempt_updated_at IS NULL
      )
      OR
      (
        checkout_attempt_state IS NOT NULL
        AND checkout_attempt_state IN ('creating', 'open', 'completed', 'remediated')
        AND checkout_attempt_id IS NOT NULL
        AND (
          (checkout_attempt_state = 'creating' AND checkout_session_id IS NULL)
          OR
          (checkout_attempt_state <> 'creating' AND checkout_session_id IS NOT NULL)
        )
        AND checkout_attempt_tier IS NOT NULL
        AND checkout_attempt_tier IN ('copilot', 'autopilot')
        AND checkout_attempt_price_variant IS NOT NULL
        AND checkout_attempt_price_variant IN ('list', 'founding')
        AND checkout_attempt_base_price_id IS NOT NULL
        AND checkout_attempt_overage_price_id IS NOT NULL
        AND checkout_attempt_base_price_cents IS NOT NULL
        AND checkout_attempt_base_price_cents > 0
        AND checkout_attempt_overage_price_cents IS NOT NULL
        AND checkout_attempt_overage_price_cents > 0
        AND checkout_attempt_locations_included IS NOT NULL
        AND checkout_attempt_locations_included > 0
        AND checkout_attempt_locations_paid IS NOT NULL
        AND checkout_attempt_locations_paid >= 0
        AND (
          checkout_attempt_state = 'completed'
          OR checkout_attempt_locations_paid = 0
        )
        AND checkout_attempt_overage_quantity IS NOT NULL
        AND checkout_attempt_overage_quantity >= 0
        AND (
          checkout_attempt_trial_period_days IS NULL
          OR checkout_attempt_trial_period_days = 30
        )
        AND checkout_attempt_tax_enabled IS NOT NULL
        AND NULLIF(BTRIM(checkout_attempt_customer_email), '') IS NOT NULL
        AND NULLIF(BTRIM(checkout_attempt_success_url), '') IS NOT NULL
        AND NULLIF(BTRIM(checkout_attempt_cancel_url), '') IS NOT NULL
        AND checkout_attempt_updated_at IS NOT NULL
      )
    );

  EXECUTE 'DROP INDEX IF EXISTS public.accounts_checkout_session_id_uniq';
  EXECUTE $index$
    CREATE UNIQUE INDEX accounts_checkout_session_id_uniq
      ON public.accounts (checkout_session_id)
      WHERE checkout_session_id IS NOT NULL
  $index$;

  -- Dynamic DDL is required because CREATE FUNCTION is not a PL/pgSQL statement
  -- inside this atomic DO block. The function has no object lookups, and its
  -- fixed search_path prevents caller-controlled resolution.
  EXECUTE $function$
    CREATE OR REPLACE FUNCTION public.reject_accounts_price_variant_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $body$
    BEGIN
      IF NEW.price_variant IS DISTINCT FROM OLD.price_variant THEN
        RAISE EXCEPTION 'accounts_price_variant_immutable: price_variant cannot change once assigned'
          USING ERRCODE = '23514',
                CONSTRAINT = 'accounts_price_variant_immutable';
      END IF;
      RETURN NEW;
    END;
    $body$
  $function$;

  DROP TRIGGER IF EXISTS accounts_price_variant_immutable ON public.accounts;
  CREATE TRIGGER accounts_price_variant_immutable
    BEFORE UPDATE OF price_variant ON public.accounts
    FOR EACH ROW
    EXECUTE FUNCTION public.reject_accounts_price_variant_mutation();
END
$migration$;
