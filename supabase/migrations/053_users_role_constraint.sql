-- 053_users_role_constraint.sql
-- Issue #50: retire the legacy sales_partner role (deferred from #43).
-- #43 already blocks sales_partner at every runtime auth path. This completes
-- the cleanup at the database layer: convert any stray legacy row to admin,
-- then enforce the owner/admin allowlist with a CHECK constraint.
--
-- No enum/CHECK previously existed on users.role (it was a bare VARCHAR(20));
-- this ADDs the first such constraint. Additive + idempotent.

-- Defensive conversion. Production has 0 sales_partner rows; this protects other
-- environments and any row created between #43 and this migration. Runs once;
-- re-running is a no-op once no sales_partner rows remain.
UPDATE users SET role = 'admin' WHERE role = 'sales_partner';

-- Role allowlist guard (idempotent via catalog check; conname is not globally
-- unique, so scope the lookup to the users relation).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'users_role_check'
      AND t.relname = 'users'
      AND n.nspname = 'public'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('owner', 'admin'));
  END IF;
END $$;
