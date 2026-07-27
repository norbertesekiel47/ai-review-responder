-- 090: solicitation_asks.evidence — enforce the decision discriminant at WRITE
-- time (#593, from the 2026-07-27 architecture review).
--
-- 088 created `evidence JSONB NOT NULL` with no CHECK. The discriminant was
-- enforced only by a throw at read time — src/lib/solicitation/batch-view.ts's
-- `parseEvidence` — and that read builds the whole Requests view from one
-- statement, so a SINGLE malformed row failed the entire view for the account,
-- not just its own line. Enforcement at read time also arrives too late to say
-- which write produced the row.
--
-- The constraint goes further than "has a discriminant", because the column is
-- not independent of its neighbours. `batch-builder.ts` stores the entire
-- decision object as `evidence` and DERIVES both columns from it:
--
--     status:          decision.decision
--     withheld_reason: decision.decision === 'withhold' ? decision.reason : null
--
-- so evidence and the columns are three views of one fact with one writer.
-- 088's `solicitation_asks_status_reason_consistency` already constrains the
-- column pair; this pins the JSONB to that same pair, which makes the
-- discriminant check fall out rather than being asserted separately.
--
-- BOTH comparisons are IS NOT DISTINCT FROM, and that is load-bearing rather
-- than stylistic. A CHECK rejects only FALSE; it PASSES on NULL. Written as
-- `evidence->>'decision' = status`, an evidence object with no `decision` key
-- yields `NULL = 'send'` → NULL → the row is accepted — i.e. the exact row
-- #593 is about would still get in. IS NOT DISTINCT FROM returns FALSE there.
-- (Caught by migration-090-solicitation-ask-evidence.integration.test.ts
-- before this migration was applied anywhere; the first draft had the hole.)
--
-- The same operator on `reason` handles the send case without a branch: the
-- key is absent for a send, so both sides are NULL and the row passes.
--
-- The other two NULL routes are already closed: `evidence` is NOT NULL from
-- 088, so `jsonb_typeof(NULL)` → NULL can't arise, and a JSON `null` VALUE
-- yields jsonb_typeof = 'null' ≠ 'object' → FALSE.
--
-- PREFLIGHT (run on staging, then prod, before applying — expect 0):
--
--   SELECT count(*) FROM solicitation_asks
--   WHERE jsonb_typeof(evidence) IS DISTINCT FROM 'object'
--      OR evidence->>'decision' IS DISTINCT FROM status
--      OR evidence->>'reason' IS DISTINCT FROM withheld_reason;
--
-- A non-zero count means a real malformed row: fix or delete it before
-- VALIDATE, do NOT weaken the constraint.
--
-- Additive-only in effect, but not lock-free: ADD CONSTRAINT is split into
-- NOT VALID (brief ACCESS EXCLUSIVE, no scan) + VALIDATE (SHARE UPDATE
-- EXCLUSIVE, scans but does not block reads or writes), so a populated table
-- never blocks the solicitation lane mid-build. No RLS change and no retention
-- change — no new table, no new column.

SET lock_timeout = '5s';

-- Idempotent on re-run against a local test DB already carrying the constraint.
ALTER TABLE solicitation_asks
  DROP CONSTRAINT IF EXISTS solicitation_asks_evidence_matches_columns;

ALTER TABLE solicitation_asks
  ADD CONSTRAINT solicitation_asks_evidence_matches_columns CHECK (
    jsonb_typeof(evidence) = 'object'
    AND evidence->>'decision' IS NOT DISTINCT FROM status
    AND evidence->>'reason' IS NOT DISTINCT FROM withheld_reason
  ) NOT VALID;

ALTER TABLE solicitation_asks
  VALIDATE CONSTRAINT solicitation_asks_evidence_matches_columns;
