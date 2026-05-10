-- ==============================================================================
-- Migration 038: Replace non-unique idx_accounts_owner with partial unique index
--
-- Enforces 1:1 account-owner relationship at the DB level.
-- The existing idx_accounts_owner is a plain btree index that allows duplicate
-- owner_user_id values. This migration drops it and creates a partial unique
-- index instead. The partial predicate (WHERE owner_user_id IS NOT NULL) allows
-- system accounts or future rows with NULL owner_user_id to coexist without
-- violating uniqueness.
--
-- Validation contract: VAL-LOC-055
--
-- Idempotent: uses DROP INDEX IF EXISTS and CREATE UNIQUE INDEX IF NOT EXISTS.
-- ==============================================================================

-- 1. Drop the old non-unique index
DROP INDEX IF EXISTS idx_accounts_owner;

-- 2. Create partial unique index enforcing one account per owner
--    The partial predicate allows NULL owner_user_id rows (system accounts)
--    to exist without violating the unique constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_owner_unique
  ON accounts(owner_user_id)
  WHERE owner_user_id IS NOT NULL;
