-- 114_solicitation_attribution.sql
--
-- #632 — review_attributed shadow attribution (map #617, spec D16).
--
-- Additive and re-runnable. Records the Attributed review on the Outreach row
-- that earned it. Nothing writes these columns until the attribution worker
-- lands in the same PR; nothing reads them until the Requests route does.
--
-- FK is ON DELETE SET NULL, never CASCADE: deleting a review must not delete
-- the Outreach row that recorded a real send to a real person. The consistency
-- CHECK is one-directional on purpose — a review id requires a timestamp, rule
-- and detail, but a timestamp may outlive its review id, which is exactly what
-- SET NULL leaves behind.
--
-- attribution_detail carries NO PII: no reviewer name, no contact name. Both
-- live in their own tables, and the owner surface joins for them. A
-- denormalized reviewer name would survive the review's deletion — the
-- retention leak the Body redaction discipline exists to prevent.
--
-- attribution_rule is the RULE NAME, not a score (deviation D1): the locked
-- matcher is the strict two-rule boolean with no scored fallback, so a numeric
-- column would have shipped with no writer.
--
-- ONE TRANSACTION, load-bearing (110's reasoning verbatim): psql autocommits
-- each statement, so on a re-run an unwrapped DROP CONSTRAINT that succeeds
-- followed by an ADD that fails would leave solicitation_outreach with NO
-- attribution consistency constraint at all. SET LOCAL lock_timeout bounds the
-- ACCESS EXCLUSIVE acquisition so a long-lived Supavisor session cannot make
-- this migration queue behind it on the hot send table.

BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE solicitation_outreach
  ADD COLUMN IF NOT EXISTS attributed_review_id UUID
    REFERENCES reviews(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attributed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attribution_rule     TEXT,
  ADD COLUMN IF NOT EXISTS attribution_detail   JSONB;

-- The trailing `IS TRUE` is not decoration. A CHECK is SATISFIED by NULL, so
-- the bare disjunction would ADMIT the row it exists to forbid: with a review
-- id, a timestamp and a detail present but attribution_rule NULL,
-- `attribution_rule IN (…)` is NULL, the conjunction collapses to NULL, and
-- `FALSE OR NULL` is NULL. Every neighbouring constraint on this table (091,
-- 110) wraps for exactly this reason.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_attribution_consistency;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_attribution_consistency CHECK (
    (
      attributed_review_id IS NULL
      OR (
        attributed_at IS NOT NULL
        AND attribution_rule IN ('full_name', 'first_last_initial')
        AND attribution_detail IS NOT NULL
      )
    ) IS TRUE
  );

-- One review attributes to at most one Outreach row GLOBALLY. Keyed on the
-- review id ALONE, not (business_id, attributed_review_id): review ids are
-- globally unique, and the composite form would have permitted the same review
-- once per business (round-1 finding A4).
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_outreach_attributed_review_uniq
  ON solicitation_outreach (attributed_review_id)
  WHERE attributed_review_id IS NOT NULL;

-- The Attribution window scan. The partial predicate byte-matches the
-- candidate query's fixed arms in src/lib/solicitation/attribution.ts; only
-- the sent_at range is parameterized. Every arm is IMMUTABLE (constant
-- comparisons and IS NULL tests only) — an index predicate rejects STABLE.
--
-- The "not yet attributed" marker is `attributed_at IS NULL`, NEVER
-- `attributed_review_id IS NULL` (round-1 finding A3). The FK above nulls the
-- review id when a review is deleted; keying on it would make an
-- already-attributed row a candidate again and let the next match overwrite
-- retained provenance. `attributed_at` is never cleared, so it is the honest
-- "has this row ever been attributed" fact.
CREATE INDEX IF NOT EXISTS solicitation_outreach_attribution_candidates
  ON solicitation_outreach (business_id, sent_at DESC)
  WHERE delivery_status = 'sent'
    AND attributed_at IS NULL
    AND bounced_at IS NULL
    AND complained_at IS NULL;

-- The in-flight outbox dedup for the NEW topic (deviation D5). These indexes
-- are PER TOPIC, not generic — see job_outbox_solicitation_send_inflight
-- (091:541), job_outbox_generate_solicitation_asks_inflight (091:546) and
-- idx_jo_solicitation_veto_notice_inflight (113:24). Without this index the
-- helper's ON CONFLICT has no constraint to infer and the INSERT throws inside
-- the review-ingest transaction — the one place this feature promised never to
-- break. The status literal is a byte-for-byte contract owned by
-- src/lib/shared/job-outbox-status.ts, re-spelled by hand at every site
-- (ci:outbox-status checks members AND order); never parameterize it, a bind
-- parameter inside an ON CONFLICT … WHERE defeats partial-index inference.
--
-- Plain CREATE INDEX (not CONCURRENTLY, which cannot run inside a transaction):
-- the predicate names a brand-new topic with zero existing rows in every
-- environment, so the build is instant and the lock moot (112/113's precedent).
CREATE UNIQUE INDEX IF NOT EXISTS job_outbox_solicitation_attribution_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'solicitation_attribution'
    AND status IN ('pending', 'dispatching', 'dispatched');

COMMENT ON COLUMN solicitation_outreach.attributed_review_id IS
  'The Attributed review (#632). Shadow metric, never billed — May 6.4 M3 owns the billable bar.';

COMMENT ON COLUMN solicitation_outreach.attributed_at IS
  'When attribution was recorded (#632). The marker every attribution site keys on — candidate query, enqueue guard, candidate index predicate and the final CAS. NEVER attributed_review_id, which the FK nulls on a review delete and which would therefore make an already-attributed row a candidate again.';

COMMENT ON COLUMN solicitation_outreach.attribution_rule IS
  'full_name | first_last_initial (#632, deviation D1). The rule NAME, not a score: the locked matcher is a strict boolean with no scored fallback, and May §6.4 M3 slices its precision bar by rule.';

COMMENT ON COLUMN solicitation_outreach.attribution_detail IS
  'Match evidence (#632, deviation D2). Carries NO personal data — no reviewer name, no contact name. Both live in their own tables and the owner surface joins for them; a denormalized copy here would survive the review deletion the FK is ON DELETE SET NULL for, which is the retention leak Body redaction exists to prevent.';

COMMIT;
