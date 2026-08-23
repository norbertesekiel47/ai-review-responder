-- 111_platform_halt_reason.sql
--
-- A third SYSTEM halt reason — `platform_halt` (#917; amendment B14's gap,
-- deferred from #900 because both candidate fixes needed this CHECK widening).
-- TWO ADDITIVE CHANGES, NO DATA CHANGE.
--
--   (a) solicitation_batches_halt_consistency — 091's text with 'platform_halt'
--       appended to the reason list. The ACTOR arm is untouched, which is the
--       point: `platform_halt` joins `send_window_elapsed` and `batch_expired`
--       on the `halted_by IS NULL` side, so it needs no new actor semantics and
--       `latchSystemHalt` keeps passing `actorUserId: null` unchanged.
--   (b) solicitation_outreach_status_reason_consistency — 110's text with
--       'platform_halt' appended to the CANCELLED arm only. Every other arm,
--       the member order within it, and the outer IS TRUE wrapper are
--       byte-for-byte 110's.
--
-- WHY. The Send breaker and the send window run on different clocks and nothing
-- reconciled them. `BATCH_SEND_WINDOW_HOURS = 72` is anchored on `approved_at`
-- and keeps running while the breaker is open; a real trip stays open for days.
-- So one trip took every batch approved in the preceding 72 hours, across every
-- account, to `cancelled / send_window_elapsed`, and told each owner their send
-- window elapsed — for a platform-wide cause that had nothing to do with their
-- list. Amendment B14 accepted that trade because SUPPRESSING the expiry sweep
-- is worse: those batches then blow past the "<=10 days by construction" bound
-- that STALLED_THRESHOLD_SEND_BATCH_DAYS = 11 derives from, and
-- `solicitation_send_batch_stalled` fires for every one of them. This migration
-- takes the OTHER horn — the sweep still runs, on the same clock, but a batch it
-- terminalizes while sending is halted platform-wide is cancelled with a reason
-- that is true.
--
-- NO BACKFILL, and that is a proof rather than an observation: `platform_halt`
-- has no writer until this branch's `release.ts` change ships, so every existing
-- row satisfies the wider CHECK (both are strict supersets). Historical
-- `send_window_elapsed` rows are NOT re-attributed — a terminal receipt is not
-- rewritten after the fact, and no environment has sent a solicitation yet.
--
-- ONE TRANSACTION, load-bearing (110's reasoning verbatim): psql autocommits
-- each statement, so an unwrapped DROP that succeeds followed by an ADD that
-- fails would leave the table with NO status/reason constraint at all.
-- lock_timeout bounds the ACCESS EXCLUSIVE acquisition so a long Supavisor
-- session cannot make this migration queue behind it.
--
-- Re-runnable: every statement is DROP … IF EXISTS then ADD, and the
-- DROP-then-ADD REPAIRS a stale constraint definition.
--
-- Issue:  #917 · Spec: docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md B14
-- Runbook: docs/runbooks/solicitation-sending-domain.md §8.5

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── (a) batch halt reason ───────────────────────────────────────────────────
-- Strict superset of 091's text. The IS TRUE wrapper is 091's NULL-safety idiom
-- (a bare multi-arm CHECK passes NULL) and must not be dropped.
--
-- THE ACTOR ARM IS DELIBERATELY UNCHANGED. `platform_halt` is system-derived
-- like the two reasons beside it, so it must carry `halted_by IS NULL`. Adding
-- it to the actor list would make the database accept a clock filed as a person.
ALTER TABLE solicitation_batches
  DROP CONSTRAINT IF EXISTS solicitation_batches_halt_consistency;
ALTER TABLE solicitation_batches
  ADD CONSTRAINT solicitation_batches_halt_consistency CHECK (
    (
      (halted_at IS NULL) = (halt_reason IS NULL)
      AND (
        halt_reason IS NULL OR halt_reason IN (
          'owner_veto', 'owner_halt', 'admin_halt',
          'send_window_elapsed', 'batch_expired', 'platform_halt'
        )
      )
      AND (halted_by IS NOT NULL)
          = ((halt_reason IN ('owner_veto', 'owner_halt', 'admin_halt')) IS TRUE)
    ) IS TRUE
  );

COMMENT ON CONSTRAINT solicitation_batches_halt_consistency ON solicitation_batches IS
  'Halt actor <-> reason totality. 111 added platform_halt to the reason list and NOT to the actor list (#917): it is the third system-derived reason, so halted_by stays NULL for it exactly as for send_window_elapsed and batch_expired. Every other clause is 091 verbatim.';

-- ── (b) outreach disposition reason ─────────────────────────────────────────
-- Strict superset of 110's text. `latchHalt` writes the batch's halt reason
-- through to every cancelled Outreach row as its disposition_reason, so the two
-- vocabularies move together or the latch raises a 23514 mid-transaction.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_status_reason_consistency;

ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_status_reason_consistency CHECK (
    (
      (delivery_status IN ('rendered', 'queued', 'sending', 'sent')
        AND disposition_reason IS NULL) OR
      (delivery_status = 'withheld' AND disposition_reason IN (
        'moderation_high', 'render_failed', 'lint_failed',
        'no_consent', 'suppressed', 'unsubscribed',
        'no_postal_address', 'postal_address_mismatch'
      )) OR
      (delivery_status = 'cancelled' AND disposition_reason IN (
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded', 'owner_withdrawn',
        'batch_expired', 'send_window_elapsed', 'superseded', 'platform_halt'
      )) OR
      (delivery_status = 'failed' AND disposition_reason IN (
        'send_failed', 'send_exhausted'
      )) OR
      (delivery_status = 'unknown' AND disposition_reason = 'send_indeterminate')
    ) IS TRUE
  );

COMMENT ON CONSTRAINT solicitation_outreach_status_reason_consistency ON solicitation_outreach IS
  'Status <-> reason totality. 111 added platform_halt to the CANCELLED arm (#917) — latchHalt writes the batch halt reason through to every cancelled row, so this arm and solicitation_batches_halt_consistency must widen together. 110 added no_postal_address and postal_address_mismatch to the withheld arm; 109 added owner_withdrawn; 108 added owner_excluded; every other arm is 091 verbatim.';

COMMIT;
