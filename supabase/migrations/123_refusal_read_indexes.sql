-- 123_refusal_read_indexes.sql
--
-- #1081 — make the three reads behind the **Restraint tab**
-- (`src/lib/refusals/read.ts`) index-servable. Index-only migration: no table,
-- no column, no constraint, no data. Additive except for one index this file
-- SUPERSEDES, named below.
--
-- IMPORTANT: this file uses CREATE/DROP INDEX CONCURRENTLY, which cannot run
-- inside a transaction. Apply non-transactionally — uncheck the "single
-- transaction" box in the Supabase SQL editor. Apply to staging first, then
-- prod, in lockstep. If a statement fails partway it can leave an INVALID
-- index behind; check with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- then DROP INDEX the invalid one and re-run. (079's header, verbatim, and
-- the same reason: `account_audit_log` is one of the tables #996 found NOTHING
-- sweeps, so it is the one table here whose build must not take a write lock.)
--
-- MEASURED BEFORE CHOOSING, and reproducible. PG 17 in the local test
-- container (`repworth-testdb-pg17`), 256,000 `refusal_events` rows across 50
-- accounts — 60,000 of them in the measured account's 90-day window, spread
-- over 20 locations — and 200,000 `account_audit_log` rows, 20,000 of them the
-- measured account's. `VACUUM (ANALYZE)` before each side, because an
-- Index Only Scan that misses the visibility map is an Index Scan wearing a
-- different node name. The full plans are in the PR body and in
-- `.claude/reference/lab-notes/history/2026-09-19-to-30.md`.
--
--   1. account-arm `total` COUNT
--        before: Index Scan using idx_refusal_events_account_window
--                — 60,366 buffers, 373.6 ms
--        after:  Index Only Scan using idx_refusal_events_account_window_covering
--                — 586 buffers, 111.5 ms   (103x buffers, 3.3x time)
--   2. location-arm `total` COUNT
--        before: Bitmap Heap Scan, business_id applied after the heap fetch
--                — 1,613 buffers, 5.39 ms
--        after:  Index Only Scan, business_id applied on the index tuple
--                — 568 buffers, 3.37 ms
--   3. per-location archived periods (`account_audit_log`)
--        before: Bitmap Index Scan on idx_account_audit_event + Sort,
--                Rows Removed by Filter: 10,785 — 3,242 buffers, 3.79 ms
--        after:  Index Only Scan using idx_account_audit_location_window,
--                no Sort node — 15 buffers, 0.09 ms  (216x buffers, 42x time)
--   4. entry read ordering
--        before: Incremental Sort, Presorted Key: r.occurred_at
--        after:  no sort node at all
--
-- `Heap Fetches: 35` on both COUNT arms is the visibility map catching up on
-- pages the fixture had just written, not a residual heap read per row: 35
-- against 60,000 rows. It falls to 0 on a table autovacuum has kept up with,
-- which is what #3's `Heap Fetches: 0` shows on the older half of the fixture.
--
-- WHY THE COUNT WAS NEVER INDEX-ONLY. 116's `idx_refusal_events_account_window
-- (account_id, occurred_at DESC)` was built for the ENTRY read, which fetches
-- six columns and is capped at 200 rows, so a heap fetch per returned row is
-- the price of the projection. The `total` COUNT returns ONE row but touches
-- every row in the window, and its only non-indexed input is `business_id` —
-- both arms filter on it (the location arm as `= $2 OR IS NULL`, the account
-- arm as the `EXISTS` correlation). One column short of covering is the whole
-- defect: 60,000 heap fetches to answer "60000".
--
-- WHY `business_id` IS AN `INCLUDE` AND NOT A FOURTH KEY COLUMN. It is never a
-- range or an ordering input — it is a residual filter, applied to the index
-- tuple an Index Only Scan already has in hand. As a key column it would
-- enlarge every internal page and buy nothing the filter does not already get.
--
-- WHY `id DESC` IS IN THE KEY. `read.ts` orders `occurred_at DESC, id DESC`
-- and the tiebreak is load-bearing, not decoration:
-- `batch-builder.ts:694` shares ONE `Date` across up to 5,000 rows, so the
-- writer creates 5,000-row ties BY DESIGN. Without `id` in the index the
-- planner adds an Incremental Sort whose presorted group is that whole tie —
-- 5,000 rows sorted to return 200. `DESC` matches the query; an ASC `id`
-- column would serve neither a forward nor a backward scan.
--
-- WHY 116'S INDEX IS DROPPED RATHER THAN LEFT IN PLACE. The new index has
-- `(account_id, occurred_at DESC)` as a strict prefix, so every plan the old
-- one could serve — the owner read, the offboarding purge's account-scoped
-- DELETE — the new one serves identically. Keeping both would cost a second
-- index write on every insert from the ledger's eleven write sites and buy
-- nothing. CREATE FIRST, DROP SECOND, so no window exists in which neither
-- index is available to a concurrent read. 116 is immutable; this is the new
-- migration that changes it, as 116's own closing line requires.
--
-- WHY `account_audit_log` GETS A PARTIAL INDEX. The archived-period read is
-- the only query in `read.ts` that reads this table, and it always pins ONE
-- location: `location_id = $2` is strict, so it implies the partial
-- predicate `location_id IS NOT NULL` and the planner proves it (065's
-- `idx_jo_recovery` pattern, cited again by 079). Every account-level row —
-- subscription changes, billing events, offboarding — carries a NULL
-- `location_id` and can never match a location read, so the predicate keeps
-- that whole class out of the index. `event_type` rides as an
-- INCLUDE for the same reason `business_id` does above — it is a filter and a
-- projected column, never an ordering input, and putting it in the key ahead
-- of `created_at` would cost the free ordering the `LIMIT` depends on.
--
-- WHAT THIS MIGRATION DOES NOT FIX. The silent `ARCHIVAL_EVENT_LIMIT`
-- truncation is #1077 and is deliberately untouched here. The missing
-- `created_at <= windowEnd` bound on that same query IS fixed, in `read.ts`,
-- in this change — it is a query bug, not a schema one.
--
-- LOCAL-ONLY at merge. Applied and verified only against the rebuildable local
-- test container (`pnpm test:db:setup`). Promotion is staging first, then
-- production, both Supabase projects in lockstep, verified by schema
-- introspection (`pg_indexes` / `pg_index.indisvalid` for the three objects
-- below) and NEVER via `list_migrations`, which does not track this repo's 0xx
-- migrations. Removing the LOCAL-ONLY marker from the migrations log is the
-- promotion change and is what re-arms `migration-immutability-guard.sh`.

-- 1. The covering, fully-ordered window index. Supersedes
--    `idx_refusal_events_account_window` (dropped below).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refusal_events_account_window_covering
  ON refusal_events (account_id, occurred_at DESC, id DESC)
  INCLUDE (business_id);

COMMENT ON INDEX idx_refusal_events_account_window_covering IS
  'The Restraint tab window index (#1081), superseding 116''s idx_refusal_events_account_window. account_id LEADS (096 G4): PG has no skip scan and the offboarding purge filters account-first. id DESC is in the key because read.ts orders occurred_at DESC, id DESC and the writer creates ties by design; business_id is INCLUDEd so the total COUNT is an Index Only Scan rather than one heap fetch per row in the window.';

-- 2. Now redundant: a strict prefix of the index created above.
DROP INDEX CONCURRENTLY IF EXISTS idx_refusal_events_account_window;

-- 3. The per-location archived-period read. Partial, because a fifth of this
--    table's rows are account-level and can never match a location read.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_account_audit_location_window
  ON account_audit_log (account_id, location_id, created_at DESC, id DESC)
  INCLUDE (event_type)
  WHERE location_id IS NOT NULL;

COMMENT ON INDEX idx_account_audit_location_window IS
  'Per-location audit history (#1081, first reader src/lib/refusals/read.ts). account_audit_log has no retention sweep (#996), so a read that filtered location_id after the fact got monotonically worse forever. Partial on location_id IS NOT NULL, which location_id = $2 implies; created_at DESC, id DESC serves the ORDER BY so the LIMIT stops the scan instead of sorting the match set.';
