-- 054_accounts_base_price_cents.sql
-- Founders price-lock: store the monthly base price (cents) on accounts so it is
-- grandfathered/point-in-time, closing the last live-TIER_CONFIG read in the
-- billing snapshot (CLAUDE.md invariant #9a). Mirrors locations_included /
-- locations_overage_price_cents. Additive + idempotent + re-runnable.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS base_price_cents INTEGER;

-- Backfill existing rows from the CURRENT TIER_CONFIG base prices. Safe now:
-- prices have not drifted, so this capture equals what each account is charged
-- (Stripe grandfathers the original base Price ID). This snapshot IS the
-- grandfathering for the founders "rate locked for life" promise. Re-running is
-- a no-op (WHERE base_price_cents IS NULL).
UPDATE accounts SET base_price_cents = CASE subscription_tier
  WHEN 'basic'    THEN 2900
  WHEN 'standard' THEN 7900
  WHEN 'premium'  THEN 19900
  WHEN 'founders' THEN 1900
  ELSE 7900            -- defensive: unknown legacy tier -> standard base
END
WHERE base_price_cents IS NULL;

-- Default mirrors subscription_tier's DEFAULT 'standard'; backstops any INSERT
-- path that omits the column (wrong-but-safe rather than a NOT NULL failure).
ALTER TABLE accounts ALTER COLUMN base_price_cents SET DEFAULT 7900;
ALTER TABLE accounts ALTER COLUMN base_price_cents SET NOT NULL;

-- Non-negative guard, idempotent via catalog lookup scoped to the accounts
-- relation (conname is unique only per-table, not globally).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'accounts_base_price_cents_nonneg'
      AND t.relname = 'accounts'
      AND n.nspname = 'public'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_base_price_cents_nonneg
      CHECK (base_price_cents >= 0);
  END IF;
END $$;
