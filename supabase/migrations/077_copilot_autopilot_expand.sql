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
    ADD COLUMN IF NOT EXISTS price_variant TEXT DEFAULT 'list';

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
