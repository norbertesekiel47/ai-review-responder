-- ==============================================================================
-- Migration 056: Owner account offboarding lifecycle
--
-- PR1 Task 1.1 schema only. No owner route, worker, feature flag, or purge logic
-- exists in this migration. Both tables are service-only: RLS is enabled with no
-- policies, and app code must use the postgres/service role with explicit account
-- scope checks.
--
-- Deploy: apply to staging Supabase first, verify, then production — both
-- projects in lockstep (never leave one ahead of the other).
-- ==============================================================================

-- ==============================================================================
-- 1. account_offboardings
-- ==============================================================================
-- App code generates UUIDv7 IDs. `terminal_at` is the active-row concurrency
-- marker; ordinary failures are intentionally non-terminal so the unique partial
-- index keeps unresolved work from allowing another offboarding for the account.

CREATE TABLE IF NOT EXISTS account_offboardings (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL
    CHECK (mode IN ('cancel_only', 'delete_data')),
  system_origin TEXT NOT NULL DEFAULT 'owner'
    CHECK (system_origin = 'owner'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'scheduled', 'tearing_down', 'purge_scheduled', 'purged', 'churned', 'reactivated', 'failed')),
  failed_step TEXT NULL,

  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_ends_at TIMESTAMPTZ NULL,
  billing_cancel_confirmed_at TIMESTAMPTZ NULL,
  teardown_started_at TIMESTAMPTZ NULL,
  teardown_completed_at TIMESTAMPTZ NULL,
  purge_after TIMESTAMPTZ NULL,
  purge_started_at TIMESTAMPTZ NULL,
  purged_at TIMESTAMPTZ NULL,
  purge_cancelled_at TIMESTAMPTZ NULL,
  reactivated_at TIMESTAMPTZ NULL,
  terminal_at TIMESTAMPTZ NULL,

  stripe_customer_id TEXT NULL,
  stripe_subscription_id TEXT NULL,
  zernio_account_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  zernio_profile_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  location_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  auth_user_id TEXT NULL,

  stripe_step TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (stripe_step IN ('success', 'failed', 'not_applicable')),
  zernio_accounts_step TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (zernio_accounts_step IN ('success', 'failed', 'not_applicable')),
  zernio_profiles_step TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (zernio_profiles_step IN ('success', 'failed', 'not_applicable')),
  location_archival_step TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (location_archival_step IN ('success', 'failed', 'not_applicable')),
  job_terminalization_step TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (job_terminalization_step IN ('success', 'failed', 'not_applicable')),
  retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (retry_count >= 0),
  last_error TEXT NULL,

  provider_dispositions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(provider_dispositions) = 'array'),
  recipient_email TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT account_offboardings_failed_step_check
    CHECK (
      -- `failed_step IS NOT NULL` is required: without it, `failed_step IN (...)` is
      -- NULL for a failed row with no failed_step, and a CHECK passes on NULL — so the
      -- DB would silently admit status='failed' with no failed_step. The explicit
      -- NOT NULL test makes that branch FALSE and the row is rejected.
      (status = 'failed' AND failed_step IS NOT NULL AND failed_step IN ('billing', 'teardown', 'purge'))
      OR (status <> 'failed' AND failed_step IS NULL)
    ),
  CONSTRAINT account_offboardings_terminal_status_check
    CHECK (
      (status IN ('purged', 'churned', 'reactivated') AND terminal_at IS NOT NULL)
      OR (status NOT IN ('purged', 'churned', 'reactivated') AND terminal_at IS NULL)
    ),
  CONSTRAINT account_offboardings_mode_status_check
    CHECK (
      (
        mode = 'cancel_only'
        AND status IN ('pending', 'scheduled', 'tearing_down', 'churned', 'reactivated', 'failed')
      )
      OR (
        mode = 'delete_data'
        AND status IN ('pending', 'tearing_down', 'purge_scheduled', 'purged', 'churned', 'failed')
      )
    )
);

COMMENT ON TABLE account_offboardings IS
  'Durable owner account offboarding lifecycle. Service-only deny-all RLS; one active non-terminal row per account.';

COMMENT ON COLUMN account_offboardings.provider_dispositions IS
  'Deletion-safe provider disposition records for admin reconciliation/override. Stored on the lifecycle row; no separate provider-disposition table in v1.';

CREATE UNIQUE INDEX IF NOT EXISTS account_offboardings_one_active_per_account
  ON account_offboardings(account_id)
  WHERE terminal_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_account_offboardings_purge_after_scheduled
  ON account_offboardings(purge_after)
  WHERE status = 'purge_scheduled';

CREATE INDEX IF NOT EXISTS idx_account_offboardings_access_ends_scheduled
  ON account_offboardings(access_ends_at)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_account_offboardings_account_id
  ON account_offboardings(account_id);

CREATE INDEX IF NOT EXISTS idx_account_offboardings_stripe_subscription_id
  ON account_offboardings(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE account_offboardings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON account_offboardings FROM anon, authenticated;

-- ==============================================================================
-- 2. account_offboarding_tokens
-- ==============================================================================
-- Approval-security pattern: raw tokens exist only in memory and in the email
-- link. Postgres stores only the SHA-256 hex digest and audit metadata.

CREATE TABLE IF NOT EXISTS account_offboarding_tokens (
  id UUID PRIMARY KEY,
  account_offboarding_id UUID NOT NULL REFERENCES account_offboardings(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_type TEXT NOT NULL DEFAULT 'keep_my_data'
    CHECK (token_type = 'keep_my_data'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,

  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  consumed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_ip TEXT NULL,
  created_user_agent TEXT NULL,
  consumed_ip TEXT NULL,
  consumed_user_agent TEXT NULL,
  revoked_reason TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE account_offboarding_tokens IS
  'Single-use keep-my-data token metadata for delete-data offboarding. Stores SHA-256 token hashes only; raw tokens are never persisted.';

CREATE UNIQUE INDEX IF NOT EXISTS account_offboarding_tokens_token_hash_key
  ON account_offboarding_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_account_offboarding_tokens_offboarding_id
  ON account_offboarding_tokens(account_offboarding_id);

CREATE INDEX IF NOT EXISTS idx_account_offboarding_tokens_active_expiry
  ON account_offboarding_tokens(expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_account_offboarding_token_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  offboarding_purge_after TIMESTAMPTZ;
BEGIN
  SELECT purge_after
  INTO offboarding_purge_after
  FROM account_offboardings
  WHERE id = NEW.account_offboarding_id;

  IF offboarding_purge_after IS NULL THEN
    RAISE EXCEPTION 'keep-my-data token requires account_offboardings.purge_after';
  END IF;

  IF NEW.expires_at > offboarding_purge_after THEN
    RAISE EXCEPTION 'keep-my-data token expires_at must not exceed account_offboardings.purge_after';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER account_offboarding_tokens_expiry_guard
  BEFORE INSERT OR UPDATE OF account_offboarding_id, expires_at
  ON account_offboarding_tokens
  FOR EACH ROW
  EXECUTE FUNCTION enforce_account_offboarding_token_expiry();

CREATE OR REPLACE FUNCTION enforce_account_offboarding_purge_after_token_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.purge_after IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM account_offboarding_tokens
    WHERE account_offboarding_id = NEW.id
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > NEW.purge_after
  ) THEN
    RAISE EXCEPTION 'account_offboardings.purge_after cannot be earlier than an active keep-my-data token expires_at';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER account_offboardings_purge_after_token_expiry_guard
  BEFORE UPDATE OF purge_after
  ON account_offboardings
  FOR EACH ROW
  EXECUTE FUNCTION enforce_account_offboarding_purge_after_token_expiry();

ALTER TABLE account_offboarding_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON account_offboarding_tokens FROM anon, authenticated;
