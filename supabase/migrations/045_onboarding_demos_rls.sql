-- Migration 045: RLS coverage for onboarding_demos
--
-- onboarding_demos is a tenant-scoped table introduced in migration 032. The
-- rows are created and mutated by owner-authenticated route handlers and
-- service-role workers, but authenticated reads should still be constrained to
-- the owning account's locations.

ALTER TABLE onboarding_demos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_demos_owner_select ON onboarding_demos;
CREATE POLICY onboarding_demos_owner_select ON onboarding_demos
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT id FROM users WHERE auth_id = auth.uid()::text)
    AND business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id())
  );
