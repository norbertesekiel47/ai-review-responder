-- 092: outreach body redaction reaches every TERMINAL row, not just `sent`
-- (#636, deferred from #624 by the step-7 spec/correctness review, finding S2).
--
-- THE DEFECT, which follows by construction from two of 091's own constraints:
--
--   solicitation_outreach_body_presence               redaction ⇒ sent_at NOT NULL
--   solicitation_outreach_status_timestamp_consistency sent_at NOT NULL ⇒ status='sent'
--
-- so `body_redacted_at` is REPRESENTABLE only on a `sent` row. A `withheld`,
-- `cancelled`, `failed` or `unknown` row can never legally carry the stamp, and
-- the ArchivalPoller sweep — keyed on `sent_at < NOW() - 90 days` — never
-- selects one either. Those rows keep their `rendered_subject`/`rendered_body`
-- and their NOT NULL `interpolation_inputs` — which carries `contact_first_name`
-- and `visit_note`, third-party PII held on the contact's behalf — forever.
--
-- `unknown` is the sharp case: it pairs exclusively with `send_indeterminate`,
-- meaning the provider never confirmed the outcome. Those messages may well
-- have been DELIVERED, so this is the body of a message the recipient plausibly
-- received, retained indefinitely against a stated 90-day promise.
--
-- Exposure today is zero and only by sequencing — nothing shipped writes those
-- statuses, because #630 builds the send worker. That is why this lands before
-- it rather than after.
--
-- ── 1. Redaction means gone AND TERMINAL (was: AND sent) ───────────────────
--
-- The arm exists to stop a LIVE row being redacted into an unsendable state:
-- a bodyless `rendered`/`queued`/`sending` row can neither send nor settle, and
-- wedges its whole batch behind `solicitation_outreach_one_live_per_ask`. That
-- hazard is about liveness, not about sending — `sent` was only ever a proxy
-- for it, and a proxy that happens to exclude four terminal statuses too.
-- Naming the terminal set directly keeps the hazard closed and drops the
-- collateral.
--
-- The five members are spelled out rather than written as
-- `NOT IN ('rendered','queued','sending')`, and the direction matters. Under
-- the explicit list a future status is non-redactable until someone adds it
-- here — a retention gap, loud at test time. Under the negated list a future
-- LIVE status would be redactable the day it is added, silently reopening the
-- wedge. Fail toward the visible failure.
--
-- WIDENING, so it cannot reject a stored row — a proof, not a data check.
-- 091's status/timestamp CHECK gives `sent_at IS NOT NULL` = `status = 'sent'`,
-- and `'sent'` is a member of the new list, so the old arm implies the new one
-- for every row that satisfies both constraints. Split NOT VALID + VALIDATE
-- anyway (090's pattern): NOT VALID takes a brief ACCESS EXCLUSIVE with no
-- scan, VALIDATE scans under SHARE UPDATE EXCLUSIVE without blocking the send
-- lane. The other three arms are carried across verbatim.
--
-- ── 2. A second sweep index, keyed on rendered_at ──────────────────────────
--
-- `sent_at` cannot key the new arm: it is NULL on precisely the rows the arm is
-- for. The age column is `rendered_at` — NOT NULL since 091, and IMMUTABLE in
-- practice (no writer updates it), which is what `updated_at` is not. An
-- `updated_at` key would let any late touch of the row — a bounce signal, a
-- backfill — silently restart the retention clock on PII, and would reorder
-- rows inside the index the sweep walks. `rendered_at` is also the earliest
-- defensible clock: it is when the body and its inputs came into existence, so
-- it redacts no LATER than a terminalization-time key would.
--
-- The predicate carries `body_redacted_at IS NULL` for the same reason 091's
-- sweep index does — B-trees index NULL keys, so without it every redacted row
-- would be held forever. The status list is what keeps a live row out: a row
-- enters this index when it terminalizes without a send, and leaves it
-- permanently on redaction.
--
-- Plain CREATE INDEX, not CONCURRENTLY: `solicitation_outreach` is empty in
-- both staging and prod (091 created it days ago and no writer exists yet), so
-- the build is instantaneous and the brief SHARE lock blocks nothing.
--
-- No new table, no new column, no RLS change. The retention-policy row for
-- `solicitation_outreach` in .claude/reference/migrations-log.md is updated in
-- the same change.

SET lock_timeout = '5s';

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_body_presence;

ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_body_presence CHECK (
    (
      -- bodies are paired
      (rendered_subject IS NULL) = (rendered_body IS NULL)
      -- redaction means gone AND terminal (092 widens 091's "AND sent")
      AND (body_redacted_at IS NULL
        OR (rendered_subject IS NULL
          AND delivery_status IN ('sent', 'withheld', 'cancelled', 'failed', 'unknown')))
      -- every unredacted, non-withheld row has its bodies
      AND (body_redacted_at IS NOT NULL
        OR delivery_status = 'withheld'
        OR rendered_subject IS NOT NULL)
      -- redaction takes the SOURCE with the prose (#624 T2). interpolation_inputs
      -- carries contact_first_name and visit_note, so a redaction that leaves it
      -- behind deletes the sentence and keeps its ingredients.
      AND (body_redacted_at IS NULL OR interpolation_inputs = '{}'::jsonb)
    ) IS TRUE
  ) NOT VALID;

ALTER TABLE solicitation_outreach
  VALIDATE CONSTRAINT solicitation_outreach_body_presence;

-- ArchivalPoller's second redaction arm: terminal rows that never sent.
-- Deliberately disjoint from idx_solicitation_outreach_redaction_sweep — that
-- one is `sent_at IS NOT NULL`, which 091 makes equivalent to `status = 'sent'`,
-- and this one excludes `sent`. No row is a candidate for both arms.
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_unsent_terminal_redaction_sweep
  ON solicitation_outreach (rendered_at)
  WHERE body_redacted_at IS NULL
    AND delivery_status IN ('withheld', 'cancelled', 'failed', 'unknown');
