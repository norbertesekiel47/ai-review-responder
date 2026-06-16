-- =====================================================================
-- 068_approval_method_required.sql
--
-- F-4 (security audit 2026-06-15): schema backstop for invariant #3
-- ("no unapproved posting"). Today approval_method is nullable and only a
-- value-check exists (responses_approval_method_check: NULL or in
-- ('owner','auto_policy')). Nothing ties an *approved* status to a non-null
-- method, so the invariant is code-enforced only. This adds that backstop.
--
-- Constraint: any row in an approved/edited/awaiting-owner-connect state MUST
-- carry an approval_method. 'posted' is intentionally OMITTED: migration 055
-- left some legacy 'posted' rows with NULL approval_method (only audit-logged
-- ones were backfilled), and a row can only reach 'posted' THROUGH
-- approved/edited (now guarded), so the invariant holds without choking on
-- grandfathered rows.
--
-- Safety: migration 055 exhaustively backfilled approved/edited/
-- awaiting_owner_connect rows to 'owner', so this applies cleanly.
-- Apply staging-first, then production, both Supabase projects in lockstep.
--
-- Preflight BEFORE applying (run on each project; expect 0 rows):
--   SELECT status, count(*) FROM responses
--    WHERE status IN ('approved','edited','awaiting_owner_connect')
--      AND approval_method IS NULL
--    GROUP BY status;
--
-- Verification after apply (should reject):
--   -- UPDATE responses SET status='approved', approval_method=NULL WHERE id=<test row>;  -- expect CHECK violation
-- =====================================================================

ALTER TABLE responses
  ADD CONSTRAINT responses_approval_method_required
  CHECK (
    status NOT IN ('approved', 'edited', 'awaiting_owner_connect')
    OR approval_method IS NOT NULL
  );
