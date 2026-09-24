-- ==============================================================================
-- Migration 125: Backfill accounts.cancelled_at for legacy cancellations (#1455)
--
-- Gives the cancellation-grace clock ONE owner. Every current write of
-- subscription_status = 'cancelled' also stamps cancelled_at = NOW() in the
-- SAME UPDATE (worker/ingress/stripe/apply-subscription-state.ts,
-- persistStatusTransition — the only writer of that status since migration
-- 037 added the column). A row that reached 'cancelled' BEFORE 037 shipped
-- has cancelled_at = NULL, and until now the two consumers disagreed on what
-- to do about it: the dashboard route fell back to
-- subscription_activated_at, while CancellationGracePoller's SQL predicate
-- required cancelled_at IS NOT NULL outright and simply never selected the
-- row for archival. Same PR that ships this migration removes the route's
-- fallback (src/lib/shared/cancellation-grace.ts,
-- resolveCancellationGraceState) so cancelled_at becomes the only clock
-- either side reads, going forward.
--
-- Provenance, best available first (COALESCE):
--   1. The EARLIEST account_audit_log 'subscription_status_changed' row whose
--      payload recorded a transition INTO 'cancelled'
--      (payload ->> 'toStatus' = 'cancelled'). That event is written by the
--      SAME applier, in the SAME transaction, that would have stamped
--      cancelled_at had the column existed yet — the closest thing to a real
--      cancellation timestamp for a pre-037 row that was cancelled AFTER 034
--      created the audit table. MIN() is defensive, not load-bearing:
--      'cancelled' is a terminal status (no transition table entry ever
--      leaves it — see ALLOWED_TRANSITION_SOURCES), so at most one such row
--      can exist per account.
--   2. subscription_activated_at — the pre-037 fallback this migration is
--      correcting, kept as a last resort so a row with no audit trail (e.g.
--      cancelled before 034 added account_audit_log, or a webhook replay gap)
--      still gets a real, if approximate, clock instead of staying NULL.
--
-- A row with NEITHER source (no matching audit row and no
-- subscription_activated_at) is left with cancelled_at = NULL.
-- resolveCancellationGraceState() treats that as indefinite grace
-- (readAccess: true, no countdown) — the same "do nothing" posture
-- CancellationGracePoller already takes for an unknown clock (its
-- `cancelled_at IS NOT NULL` predicate never selects such a row). Deliberately
-- DATA-ONLY: no CHECK constraint requiring cancelled_at whenever
-- subscription_status = 'cancelled'. The single writer already keeps the two
-- columns in lockstep going forward (this backfill only cleans up rows from
-- before that writer's invariant existed), and a hard CHECK would foreclose
-- the one legitimate escape hatch the fail-safe above exists for — an
-- emergency manual status correction (e.g. a support/DB fix) that cannot also
-- supply a trustworthy cancellation date at the same time.
--
-- Idempotent: the WHERE clause only touches rows still missing cancelled_at,
-- so re-running is a no-op and an account mid-grace is never reset. Measured
-- against both Supabase projects on 2026-09-23 (SELECT count(*) FROM accounts
-- WHERE subscription_status = 'cancelled' AND cancelled_at IS NULL): 0 rows on
-- staging, 0 rows on production — this is a defensive correctness fix, not a
-- response to an active incident with data in this shape today.
--
-- Transactional (no CONCURRENTLY — one UPDATE over the small `accounts`
-- table; no index/table change). Apply staging-first, then production, both
-- Supabase projects in lockstep.
-- ==============================================================================

UPDATE accounts a
SET cancelled_at = COALESCE(
  (
    SELECT MIN(l.created_at)
    FROM account_audit_log l
    WHERE l.account_id = a.id
      AND l.event_type = 'subscription_status_changed'
      AND l.payload ->> 'toStatus' = 'cancelled'
  ),
  a.subscription_activated_at
)
WHERE a.subscription_status = 'cancelled'
  AND a.cancelled_at IS NULL;
