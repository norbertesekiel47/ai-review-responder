-- ==============================================================================
-- Migration 055: Auto-approval policy schema and approval attribution
--
-- PR1 scaffolding only: this adds durable policy/audit shape for the future
-- owner-configured auto-approval feature. It does not add any runtime branch that
-- can auto-approve or publish without explicit owner approval.
-- ==============================================================================

-- ==============================================================================
-- 1. auto_approval_policies
-- ==============================================================================
-- App code generates UUIDv7 IDs. Keep the table deny-by-default for
-- authenticated browser clients; owner settings routes will use service-role
-- writes with app-enforced account scope in a later PR.

CREATE TABLE IF NOT EXISTS auto_approval_policies (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  location_id UUID NULL,
  auto_approve_min_star SMALLINT NULL
    CHECK (auto_approve_min_star IS NULL OR auto_approve_min_star BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE auto_approval_policies IS
  'Owner-configured auto-approval thresholds. NULL location_id is the account default; non-NULL location_id is a per-location override. PR1 schema only; runtime auto-approval remains disabled until later PRs.';

COMMENT ON COLUMN auto_approval_policies.auto_approve_min_star IS
  'Nullable minimum star rating for auto approval. NULL means manual/off; 1..5 means all rated reviews at or above that star threshold, subject to runtime gates.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.conname = 'businesses_id_account_id_key'
      AND t.relname = 'businesses'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_id_account_id_key UNIQUE (id, account_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.conname = 'auto_approval_policies_location_account_fk'
      AND t.relname = 'auto_approval_policies'
  ) THEN
    ALTER TABLE auto_approval_policies
      ADD CONSTRAINT auto_approval_policies_location_account_fk
      FOREIGN KEY (location_id, account_id)
      REFERENCES businesses(id, account_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_policies_one_account_default
  ON auto_approval_policies(account_id)
  WHERE location_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_policies_one_location_override
  ON auto_approval_policies(account_id, location_id)
  WHERE location_id IS NOT NULL;

ALTER TABLE auto_approval_policies ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON auto_approval_policies FROM authenticated;

-- ==============================================================================
-- 2. responses.approval_method
-- ==============================================================================
-- Nullable by design. Pending/manual-fallback rows have not been approved, and
-- externally imported Google replies were not necessarily approved in RepWorth.

ALTER TABLE responses ADD COLUMN IF NOT EXISTS approval_method TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.conname = 'responses_approval_method_check'
      AND t.relname = 'responses'
  ) THEN
    ALTER TABLE responses
      ADD CONSTRAINT responses_approval_method_check
      CHECK (approval_method IS NULL OR approval_method IN ('owner', 'auto_policy'));
  END IF;
END $$;

COMMENT ON COLUMN responses.approval_method IS
  'How this response became approved. NULL for pending/manual-fallback/external or ambiguous rows; owner for explicit owner approval; auto_policy for future owner-configured auto approval.';

UPDATE responses
SET approval_method = 'owner'
WHERE approval_method IS NULL
  AND status IN ('approved', 'edited', 'awaiting_owner_connect');

UPDATE responses
SET approval_method = 'owner'
WHERE approval_method IS NULL
  AND status = 'posted'
  AND EXISTS (
    SELECT 1
    FROM approval_audit_log aal
    WHERE aal.response_id = responses.id
  );

-- ==============================================================================
-- 3. approval_audit_log.auth_method
-- ==============================================================================
-- Keep the default token auth method from migration 014. Future auto-policy code
-- must explicitly write auth_method='auto_policy'.

ALTER TABLE approval_audit_log
  DROP CONSTRAINT IF EXISTS approval_audit_log_auth_method_check;

ALTER TABLE approval_audit_log
  ADD CONSTRAINT approval_audit_log_auth_method_check
  CHECK (auth_method IN ('token', 'owner_session', 'auto_policy'));
