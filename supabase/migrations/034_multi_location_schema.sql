-- ==============================================================================
-- Migration 034: Multi-location schema
--
-- Creates the accounts table (the "parent org" concept), adds account_id
-- denormalized columns across businesses/users/channel_enrollments/api_costs/
-- notification_deliveries/approval_audit_log, adds display_label/is_primary/
-- archived_at to businesses, adds location_id to channel_enrollments, creates
-- account_audit_log, drops users.business_id, replaces
-- idx_users_owner_auth_by_business with idx_users_owner_auth_by_account, fixes
-- the DROP for channel_enrollments_business_channel_active_key (it is an INDEX
-- not a CONSTRAINT), creates all new indexes, backfills existing data, and
-- adds deprecation comments on businesses subscription columns.
--
-- Idempotent: can be re-run without error (IF NOT EXISTS / IF EXISTS /
-- ON CONFLICT DO NOTHING where applicable).
--
-- Validation contract: VAL-SCHEMA-001 through VAL-SCHEMA-037
-- ==============================================================================

-- ==============================================================================
-- 1. Create accounts table (VAL-SCHEMA-001)
-- ==============================================================================
-- 16 columns per spec §3.1. No DEFAULT on id — app generates UUIDv7 per repo
-- convention (established in migration 002). owner_user_id references users(id)
-- without ON DELETE — deleting a user with an account is blocked by RESTRICT.

CREATE TABLE IF NOT EXISTS accounts (
  id                              UUID PRIMARY KEY,
  owner_user_id                   UUID NOT NULL REFERENCES users(id),
  display_name                    VARCHAR(255) NOT NULL,
  subscription_tier               VARCHAR(20) NOT NULL DEFAULT 'standard',
  subscription_status             VARCHAR(20) NOT NULL DEFAULT 'pending_payment',
  stripe_customer_id              VARCHAR(255),
  stripe_subscription_id          VARCHAR(255),
  trial_ends_at                   TIMESTAMPTZ,
  subscription_activated_at       TIMESTAMPTZ,
  locations_included              INTEGER NOT NULL DEFAULT 1,
  locations_paid                  INTEGER NOT NULL DEFAULT 0,
  locations_overage_price_cents   INTEGER NOT NULL DEFAULT 2500,
  flags                           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

-- VAL-SCHEMA-002: accounts indexes
CREATE INDEX IF NOT EXISTS idx_accounts_owner
  ON accounts(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_accounts_stripe_customer
  ON accounts(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ==============================================================================
-- 2. Create account_audit_log table (VAL-SCHEMA-019)
-- ==============================================================================
-- 7 columns per spec §3.6. ON DELETE CASCADE on account_id — audit entries
-- are owned by the account and should be purged when the account is deleted.
-- No DEFAULT on id — app generates UUIDv7.

CREATE TABLE IF NOT EXISTS account_audit_log (
  id                UUID PRIMARY KEY,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  location_id       UUID REFERENCES businesses(id),
  event_type        TEXT NOT NULL,
  actor_user_id     UUID REFERENCES users(id),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE account_audit_log ENABLE ROW LEVEL SECURITY;

-- VAL-SCHEMA-020: account_audit_log indexes
CREATE INDEX IF NOT EXISTS idx_account_audit
  ON account_audit_log(account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_account_audit_event
  ON account_audit_log(event_type, created_at);

-- ==============================================================================
-- 3. Add nullable columns to existing tables
-- ==============================================================================
-- All account_id columns are added as nullable first; NOT NULL is set after
-- backfill (step 6). FK constraints are added after NOT NULL (step 7).

-- VAL-SCHEMA-003: businesses.account_id
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS account_id UUID;

-- VAL-SCHEMA-010: businesses.display_label (nullable — falls back to name)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS display_label VARCHAR(255);

-- VAL-SCHEMA-011: businesses.is_primary (NOT NULL DEFAULT FALSE — set to TRUE in backfill)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- VAL-SCHEMA-012: businesses.archived_at (nullable — non-NULL = soft-deleted)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- VAL-SCHEMA-004: users.account_id
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id UUID;

-- VAL-SCHEMA-005: channel_enrollments.account_id
ALTER TABLE channel_enrollments ADD COLUMN IF NOT EXISTS account_id UUID;

-- VAL-SCHEMA-006: channel_enrollments.location_id (nullable — NULL = org-level default)
ALTER TABLE channel_enrollments ADD COLUMN IF NOT EXISTS location_id UUID;

-- VAL-SCHEMA-007: api_costs.account_id
ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS account_id UUID;

-- VAL-SCHEMA-008: notification_deliveries.account_id
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS account_id UUID;

-- VAL-SCHEMA-009: approval_audit_log.account_id
ALTER TABLE approval_audit_log ADD COLUMN IF NOT EXISTS account_id UUID;

-- ==============================================================================
-- 4. Drop old indexes (VAL-SCHEMA-014, VAL-SCHEMA-016, VAL-SCHEMA-017)
-- ==============================================================================

-- VAL-SCHEMA-014: Drop the partial index that covers the old users.business_id
-- access pattern. Replaced by idx_users_owner_auth_by_account (step 8).
DROP INDEX IF EXISTS idx_users_owner_auth_by_business;

-- VAL-SCHEMA-016: Drop channel_enrollments_business_channel_active_key as an
-- INDEX (not a CONSTRAINT). This was created via CREATE UNIQUE INDEX in
-- migration 022 — it is an index, not a table constraint, so DROP INDEX is
-- the correct command (ALTER TABLE … DROP CONSTRAINT would fail).
DROP INDEX IF EXISTS channel_enrollments_business_channel_active_key;

-- VAL-SCHEMA-017: Drop the defense-in-depth mobile-per-business index from
-- migration 027. Superseded by channel_enrollments_one_mobile_per_scope (step 8).
DROP INDEX IF EXISTS channel_enrollments_one_mobile_per_biz;

-- VAL-SCHEMA-018: Safety check — the original inline UNIQUE(business_id, channel)
-- constraint from migration 021 was already dropped in migration 022. Assert
-- it's still gone so we don't leave a dangling constraint.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_enrollments_business_id_channel_key') THEN
    ALTER TABLE channel_enrollments DROP CONSTRAINT channel_enrollments_business_id_channel_key;
  END IF;
END $$;

-- ==============================================================================
-- 5. Backfill existing data
-- ==============================================================================
-- VAL-SCHEMA-025 through VAL-SCHEMA-029.

-- ── 5a. Pre-flight: verify all businesses have onboarded_by set ──────────
-- Migration 025 backfilled onboarded_by for all existing businesses. If any
-- business somehow has NULL onboarded_by, the INSERT into accounts would fail
-- with a NOT NULL violation on owner_user_id. Fail-fast with a clear message.
DO $$
DECLARE
  missing_count INTEGER;
BEGIN
  EXECUTE 'SELECT COUNT(*) FROM businesses WHERE onboarded_by IS NULL AND account_id IS NULL' INTO missing_count;
  IF missing_count > 0 THEN
    RAISE EXCEPTION
      'Cannot backfill accounts: % business(es) have NULL onboarded_by. '
      'Set onboarded_by first (see migration 025), then re-run migration 034.',
      missing_count;
  END IF;
END $$;

-- ── 5b. Create one account per existing business (VAL-SCHEMA-025) ────────
-- Each legacy business becomes the sole (primary) location of its own account.
-- gen_random_uuid() is used for backfill rows (same pattern as migration 021
-- backfill comment). Runtime inserts use app-generated UUIDv7.
--
-- Fields copied exactly from businesses (not defaulted):
--   subscription_tier, subscription_status, stripe_customer_id,
--   stripe_subscription_id, subscription_activated_at
-- display_name = businesses.name
-- owner_user_id = businesses.onboarded_by
--
-- Idempotent: WHERE b.account_id IS NULL skips businesses that already have
-- an account assigned (from a previous run of this migration).

DO $$
DECLARE
  b RECORD;
  new_account_id UUID;
BEGIN
  FOR b IN EXECUTE
    'SELECT id, onboarded_by, name, '
    '         subscription_tier, subscription_status, '
    '         stripe_customer_id, stripe_subscription_id, '
    '         subscription_activated_at '
    'FROM businesses b '
    'WHERE b.account_id IS NULL '
    'ORDER BY b.created_at ASC'
  LOOP
    INSERT INTO accounts (
      id, owner_user_id, display_name,
      subscription_tier, subscription_status,
      stripe_customer_id, stripe_subscription_id,
      subscription_activated_at
    )
    VALUES (
      gen_random_uuid(), b.onboarded_by, b.name,
      b.subscription_tier, b.subscription_status,
      b.stripe_customer_id, b.stripe_subscription_id,
      b.subscription_activated_at
    )
    RETURNING id INTO new_account_id;

    UPDATE businesses SET account_id = new_account_id WHERE id = b.id;
  END LOOP;
END $$;

-- ── 5c. Set is_primary = TRUE for all existing businesses (VAL-SCHEMA-026) ──
-- Each legacy business is the sole/primary location of its account.
-- Idempotent: WHERE is_primary = FALSE skips already-set rows.
UPDATE businesses
SET is_primary = TRUE
WHERE is_primary = FALSE
  AND account_id IS NOT NULL;

-- ── 5d. Set users.account_id from business (VAL-SCHEMA-027) ────────────
-- Idempotent: WHERE u.account_id IS NULL skips already-set rows.
-- Uses EXECUTE inside a guard because users.business_id is dropped in step 9.
-- On re-run, business_id no longer exists; the IF NOT EXISTS guard skips the
-- UPDATE entirely, and EXECUTE ensures the SQL is never parsed when skipped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'users'::regclass AND attname = 'business_id' AND NOT attisdropped
  ) THEN
    EXECUTE '
      UPDATE users u
      SET account_id = b.account_id
      FROM businesses b
      WHERE u.business_id = b.id
        AND u.account_id IS NULL
    ';
  END IF;
END $$;

-- ── 5e. Set channel_enrollments.account_id from business (VAL-SCHEMA-028) ──
-- location_id stays NULL for existing rows (org-level default).
-- Idempotent: WHERE ce.account_id IS NULL skips already-set rows.
UPDATE channel_enrollments ce
SET account_id = b.account_id
FROM businesses b
WHERE ce.business_id = b.id
  AND ce.account_id IS NULL;

-- ── 5f. Set hot-table account_id from business (VAL-SCHEMA-029) ────────

-- api_costs
UPDATE api_costs ac
SET account_id = b.account_id
FROM businesses b
WHERE ac.business_id = b.id
  AND ac.account_id IS NULL;

-- notification_deliveries
UPDATE notification_deliveries nd
SET account_id = b.account_id
FROM businesses b
WHERE nd.business_id = b.id
  AND nd.account_id IS NULL;

-- approval_audit_log
UPDATE approval_audit_log aal
SET account_id = b.account_id
FROM businesses b
WHERE aal.business_id = b.id
  AND aal.account_id IS NULL;

-- ==============================================================================
-- 6. Set NOT NULL on account_id columns after backfill
-- ==============================================================================

ALTER TABLE businesses ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE users ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE channel_enrollments ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE api_costs ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE notification_deliveries ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE approval_audit_log ALTER COLUMN account_id SET NOT NULL;

-- ==============================================================================
-- 7. Add foreign key constraints for account_id and location_id
-- ==============================================================================
-- Using idempotent DO-block pattern so re-run doesn't fail on duplicate
-- constraint names. No ON DELETE on account_id FKs — RESTRICT is the default,
-- preventing accidental account deletion while dependent rows exist.
-- account_audit_log.account_id already has ON DELETE CASCADE from step 2.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_businesses_account') THEN
    ALTER TABLE businesses ADD CONSTRAINT fk_businesses_account
      FOREIGN KEY (account_id) REFERENCES accounts(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_account') THEN
    ALTER TABLE users ADD CONSTRAINT fk_users_account
      FOREIGN KEY (account_id) REFERENCES accounts(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_channel_enrollments_account') THEN
    ALTER TABLE channel_enrollments ADD CONSTRAINT fk_channel_enrollments_account
      FOREIGN KEY (account_id) REFERENCES accounts(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_channel_enrollments_location') THEN
    ALTER TABLE channel_enrollments ADD CONSTRAINT fk_channel_enrollments_location
      FOREIGN KEY (location_id) REFERENCES businesses(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_api_costs_account') THEN
    ALTER TABLE api_costs ADD CONSTRAINT fk_api_costs_account
      FOREIGN KEY (account_id) REFERENCES accounts(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_notification_deliveries_account') THEN
    ALTER TABLE notification_deliveries ADD CONSTRAINT fk_notification_deliveries_account
      FOREIGN KEY (account_id) REFERENCES accounts(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_approval_audit_log_account') THEN
    ALTER TABLE approval_audit_log ADD CONSTRAINT fk_approval_audit_log_account
      FOREIGN KEY (account_id) REFERENCES accounts(id);
  END IF;
END $$;

-- ==============================================================================
-- 8. Create new indexes
-- ==============================================================================

-- VAL-SCHEMA-015: Replace the dropped idx_users_owner_auth_by_business
CREATE INDEX IF NOT EXISTS idx_users_owner_auth_by_account
  ON users(account_id)
  WHERE role = 'owner' AND auth_id IS NOT NULL;

-- VAL-SCHEMA-021: businesses account/primary indexes
CREATE INDEX IF NOT EXISTS idx_businesses_account
  ON businesses(account_id)
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS businesses_account_primary_uniq
  ON businesses(account_id)
  WHERE is_primary = TRUE AND archived_at IS NULL;

-- VAL-SCHEMA-022: hot-table account indexes
CREATE INDEX IF NOT EXISTS idx_api_costs_account
  ON api_costs(account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_nd_account
  ON notification_deliveries(account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_account
  ON approval_audit_log(account_id, created_at);

-- VAL-SCHEMA-023: channel_enrollments scope uniqueness index
-- Enforces at most one active enrollment per (account, channel, scope).
-- COALESCE maps NULL location_id to a sentinel UUID so that org-level
-- defaults (location_id IS NULL) are treated as the same scope within
-- an account+channel, preventing duplicate org-level defaults.
CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_account_channel_scope_uniq
  ON channel_enrollments (
    account_id,
    channel,
    COALESCE(location_id, '00000000-0000-0000-0000-000000000000')
  )
  WHERE archived_at IS NULL;

-- VAL-SCHEMA-024: channel_enrollments mobile-per-scope index
-- Enforces at most one pending/verified mobile channel per (account, scope).
-- Replaces channel_enrollments_one_mobile_per_biz (dropped in step 4).
CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_one_mobile_per_scope
  ON channel_enrollments (
    account_id,
    COALESCE(location_id, '00000000-0000-0000-0000-000000000000')
  )
  WHERE channel IN ('sms','telegram','whatsapp')
    AND status IN ('pending_verification','verified')
    AND archived_at IS NULL;

-- ==============================================================================
-- 9. Drop users.business_id column (VAL-SCHEMA-013)
-- ==============================================================================
-- Per key decision: users.business_id is DROPPED outright in migration 034
-- with no deprecation window (VAL-SCHEMA-035). This is distinct from the
-- businesses subscription columns which get deprecation comments (step 10).
-- Must drop FK constraint first, then the column.

ALTER TABLE users DROP CONSTRAINT IF EXISTS fk_users_business;
ALTER TABLE users DROP COLUMN IF EXISTS business_id;

-- ==============================================================================
-- 10. Deprecation comments on businesses subscription columns (VAL-SCHEMA-036)
-- ==============================================================================
-- These columns are retained for a one-release backward-compatibility window
-- but are marked deprecated. Application code should read from accounts
-- instead. This is distinct from users.business_id which is dropped outright
-- (step 9 / VAL-SCHEMA-035).
-- VAL-SCHEMA-037: these columns are NOT dropped in 034.

COMMENT ON COLUMN businesses.subscription_tier IS
  'DEPRECATED — read from accounts.subscription_tier instead';
COMMENT ON COLUMN businesses.subscription_status IS
  'DEPRECATED — read from accounts.subscription_status instead';
COMMENT ON COLUMN businesses.stripe_customer_id IS
  'DEPRECATED — read from accounts.stripe_customer_id instead';
COMMENT ON COLUMN businesses.stripe_subscription_id IS
  'DEPRECATED — read from accounts.stripe_subscription_id instead';
COMMENT ON COLUMN businesses.subscription_activated_at IS
  'DEPRECATED — read from accounts.subscription_activated_at instead';
