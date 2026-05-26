-- Migration 047: backfill accounts.past_due_at for pre-043 past-due accounts
--
-- Migration 043 added accounts.past_due_at (nullable) and started setting it on
-- the active->past_due transition. Any account already in past_due BEFORE 043
-- shipped has past_due_at = NULL. The Wave 2 recovery helper
-- (src/lib/shared/past-due-recovery.ts) treats a NULL past_due_at on a past_due
-- account as immediately read-only, which would yank the grace window from
-- those existing customers the moment Wave 2 deploys. Backfill from updated_at
-- (the clock the old subscription guard used) to preserve their grace.
--
-- Scoped to NULL only so accounts mid-grace are never reset.

UPDATE accounts
SET past_due_at = updated_at
WHERE subscription_status = 'past_due'
  AND past_due_at IS NULL;
