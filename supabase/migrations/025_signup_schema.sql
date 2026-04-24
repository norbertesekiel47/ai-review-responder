-- Migration 025: signup schema — indexes + email normalization + onboarded_by backfill.
-- See docs/superpowers/specs/2026-04-23-owner-self-serve-signup-design.md §2.

-- ===== Block 1: Indexes =====

CREATE INDEX IF NOT EXISTS idx_businesses_pending_unpaid_self_serve_cleanup
  ON businesses (created_at)
  WHERE subscription_status = 'pending_payment'
    AND stripe_customer_id IS NULL
    AND onboarded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_owner_auth_by_business
  ON users (business_id)
  WHERE role = 'owner' AND auth_id IS NOT NULL;

COMMENT ON INDEX idx_businesses_pending_unpaid_self_serve_cleanup IS
  'Covers CleanupAbandonedSignupsPoller scan (self-serve abandoned signups past 7 days). See docs/superpowers/specs/2026-04-23-owner-self-serve-signup-design.md §1.5.';

COMMENT ON INDEX idx_users_owner_auth_by_business IS
  'Speeds the cleanup-poller JOIN (and dashboard payment-status JOIN) on users.business_id for owner rows with auth_id set. Partial because admin-created owner rows legitimately have auth_id=NULL. See docs/superpowers/specs/2026-04-23-owner-self-serve-signup-design.md §2.2.';

-- ===== Block 2: Email normalization =====

DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT COUNT(*) INTO collisions FROM (
    SELECT lower(trim(email)) AS norm_email
    FROM users
    GROUP BY lower(trim(email))
    HAVING COUNT(*) > 1
  ) c;
  IF collisions > 0 THEN
    RAISE EXCEPTION
      'Email normalization would create % duplicate(s). Run: SELECT lower(trim(email)) AS norm, array_agg(id) FROM users GROUP BY lower(trim(email)) HAVING COUNT(*) > 1. Resolve manually, then re-run.',
      collisions;
  END IF;
END $$;

UPDATE users SET email = lower(trim(email))
WHERE email <> lower(trim(email));

-- ===== Block 3: onboarded_by backfill =====

DO $$
DECLARE
  placeholder_admin_id UUID;
  affected_businesses INTEGER;
BEGIN
  SELECT id INTO placeholder_admin_id
  FROM users
  WHERE role IN ('admin', 'sales_partner')
  ORDER BY created_at
  LIMIT 1;

  SELECT COUNT(*) INTO affected_businesses
  FROM businesses
  WHERE onboarded_by IS NULL;

  IF affected_businesses > 0 AND placeholder_admin_id IS NULL THEN
    RAISE EXCEPTION
      'Cannot backfill onboarded_by: % business(es) need a value but no admin/sales_partner user exists. Create one first, then re-run.',
      affected_businesses;
  END IF;

  IF placeholder_admin_id IS NOT NULL THEN
    UPDATE businesses SET onboarded_by = placeholder_admin_id
    WHERE onboarded_by IS NULL;
  END IF;
END $$;
