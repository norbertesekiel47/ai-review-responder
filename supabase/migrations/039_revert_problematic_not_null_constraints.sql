-- ==============================================================================
-- Migration 039: Revert problematic NOT NULL constraints from migration 034
--
-- Migration 034 set NOT NULL on account_id columns for users, api_costs, and
-- notification_deliveries after backfilling existing rows. However, these
-- NOT NULL constraints are architecturally incorrect for three tables:
--
-- 1. users.account_id: admin and sales_partner users legitimately have NULL
--    account_id — they are not associated with any business account. The
--    backfill only populated account_id for users with a business_id (i.e.,
--    owner-role users). Setting NOT NULL broke admin/sales_partner user
--    creation at the DB level. The code already models account_id as nullable
--    for non-owner roles (auth.ts, middleware.ts).
--
-- 2. api_costs.account_id: platform-level API costs (e.g., LLM calls for
--    system operations) have business_id = NULL and therefore no account_id.
--    The backfill only populated account_id for rows with a non-NULL
--    business_id. The recordApiCost() function already accepts
--    businessId: string | null and does not include account_id in its INSERT.
--    The NOT NULL constraint would cause runtime violations for platform costs.
--
-- 3. notification_deliveries.account_id: the INSERT statements in
--    recordNotificationDelivery() and insertFailedDelivery() do not include
--    account_id in their column lists. The NOT NULL constraint would cause
--    runtime violations for every notification delivery INSERT. This NOT NULL
--    can be reinstated once the notification writer fix is deployed (see
--    feature fix-notification-delivery-account-id).
--
-- Additionally, this migration adds a partial index on api_costs(account_id)
-- WHERE account_id IS NOT NULL for the admin denorm query path, which only
-- needs to scan rows belonging to specific accounts (excluding platform-level
-- costs with NULL account_id).
--
-- Idempotent: uses DO blocks with attnotnull checks before ALTER TABLE, and
-- CREATE INDEX IF NOT EXISTS.
--
-- Validation contract: corrective-migration-039 feature expected behavior
-- ==============================================================================

-- ── 1. Drop NOT NULL on users.account_id ──────────────────────────────────
-- admin/sales_partner users legitimately have NULL account_id.
-- The code already handles this: auth.ts models account_id as
-- `string | null`, middleware.ts guards with `!self.account_id`.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'users'::regclass
      AND attname = 'account_id'
      AND attnotnull = TRUE
  ) THEN
    ALTER TABLE users ALTER COLUMN account_id DROP NOT NULL;
  END IF;
END $$;

-- ── 2. Drop NOT NULL on api_costs.account_id ──────────────────────────────
-- Platform-level costs (business_id = NULL) have no account association.
-- recordApiCost() does not include account_id in its INSERT column list.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'api_costs'::regclass
      AND attname = 'account_id'
      AND attnotnull = TRUE
  ) THEN
    ALTER TABLE api_costs ALTER COLUMN account_id DROP NOT NULL;
  END IF;
END $$;

-- ── 3. Drop NOT NULL on notification_deliveries.account_id ────────────────
-- recordNotificationDelivery() and insertFailedDelivery() do not include
-- account_id in their INSERT column lists. The NOT NULL constraint would
-- cause runtime violations for every delivery INSERT. This can be reinstated
-- once the notification writer fix (feature fix-notification-delivery-account-id)
-- is deployed.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'notification_deliveries'::regclass
      AND attname = 'account_id'
      AND attnotnull = TRUE
  ) THEN
    ALTER TABLE notification_deliveries ALTER COLUMN account_id DROP NOT NULL;
  END IF;
END $$;

-- ── 4. Add partial index on api_costs for admin denorm query path ──────────
-- The existing idx_api_costs_account is a composite btree(account_id, created_at)
-- that indexes ALL rows including those with NULL account_id. The admin denorm
-- query path only needs rows where account_id IS NOT NULL, so a partial index
-- is more efficient and smaller.
CREATE INDEX IF NOT EXISTS idx_api_costs_account_partial
  ON api_costs(account_id)
  WHERE account_id IS NOT NULL;
