-- 116_refusal_events.sql
--
-- #1008 — the Refusal ledger's table (map #994, schema locked in #1001).
-- Slice 1 of 7. Additive and re-runnable.
--
-- WHAT A ROW IS
-- One row is one DECISION: something RepWorth decided not to do and recorded
-- at the moment it decided. Not a re-derivation, not a projection over other
-- tables — the parent effort proved a projection cannot be ordered, because
-- two of the seven lanes have no immutable timestamp of their own. That is the
-- whole reason `occurred_at` exists.
--
-- NOTHING WRITES THIS TABLE YET. The insert helper, its kill switch, the
-- ArchivalPoller sweep arm and the FIRST of the eleven write sites land in
-- #1009; the other ten in #1010-#1013; the Restraint tab in #1014. (The
-- intake's non_goals attaches all eleven to #1010-#1013; that phrasing is
-- superseded — see deviations D16. The total is eleven either way.) The only
-- code naming this table in the same change is the account-offboarding purge,
-- which must be able to honour the `hard_delete` disposition it forces.
--
-- ORDERING IS LOAD-BEARING — 116 MUST REACH A DATABASE BEFORE THE CODE THAT
-- NAMES IT. This is the 105/114 class. `runContentPurgeStage` issues
-- `DELETE FROM refusal_events`, which raises `42P01` at PLAN time against a
-- database without this migration. That aborts the purge transaction, and
-- `PurgeWorker` terminalizes the offboarding after bounded retries
-- (`markPurgeTerminalFailure` + `markOutboxFailed`) — promoting 116 afterwards
-- does NOT reopen it. A feature flag would not save you either: a flag
-- protects ROWS, a missing relation fails the PARSE. The mitigation is
-- ordering and nothing else. The full sequence, which also keeps unreviewed
-- SQL off production, is in this branch's plan under "Step 8 — the ship
-- order": CI green -> staging DDL -> staging ride -> owner approval ->
-- production DDL -> merge.
--
-- ONE TRANSACTION, load-bearing (110's and 114's reasoning verbatim): psql
-- autocommits each statement, so on a partial re-run an unwrapped CREATE TABLE
-- that succeeded followed by a failing index or ALTER would leave
-- `refusal_events` without its indexes or its RLS posture. `SET LOCAL
-- lock_timeout` bounds the lock acquisition so a long-lived Supavisor session
-- cannot make this migration queue behind it.
--
-- WHY TWO TIMESTAMPS. `occurred_at` is the DECISION time, supplied by the
-- writer, and it is the ONE retention clock (#996). `created_at` is the INSERT
-- stamp and is never swept. The skew between them is the only measurement that
-- would catch a writer stamping `occurred_at` with insert time — otherwise
-- unmeasurable, which is why dropping `created_at` was rejected. No writer may
-- pass `NOW()` for `occurred_at`: `NOW()` is a write timestamp wearing a
-- decision timestamp's name, and the two diverge exactly where it matters — a
-- retried job, a long transaction.
--
-- WHY `subject_id` CARRIES NO FOREIGN KEY. `NULL` means "this lane points at
-- nothing"; a non-null id that no longer resolves means "the subject aged
-- away". `ON DELETE SET NULL` collapses the second into the first and the
-- owner cannot tell them apart. The two real FKs carry no referential action
-- either: both parents are `retain_deidentified` (tombstoned, never deleted),
-- so neither can take a Refusal away on another table's clock (#996 §3).
--
-- LOCAL-ONLY at merge. Applied and verified only against the rebuildable local
-- test container (`pnpm test:db:setup`). Promotion is staging first, then
-- production, both Supabase projects in lockstep, verified by schema
-- introspection (`information_schema.columns` / `pg_constraint` / `pg_indexes`)
-- and NEVER via `list_migrations`, which does not track this repo's 0xx
-- migrations. Removing the LOCAL-ONLY marker from the migrations log is the
-- promotion change and is what re-arms `migration-immutability-guard.sh`.

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS refusal_events (
  id UUID PRIMARY KEY,

  account_id  UUID NOT NULL REFERENCES accounts(id),
  business_id UUID          REFERENCES businesses(id),

  refusal_source TEXT NOT NULL CHECK (refusal_source IN (
    'held_draft', 'auto_post_revoked', 'autonomy_suspended', 'ask_withheld',
    'outreach_withheld', 'batch_halted', 'policy_gate_held')),
  refusal_code      TEXT,
  all_refusal_codes TEXT[],

  refusal_category TEXT NOT NULL CHECK (refusal_category IN (
    'unsafe_content', 'watchdog_unavailable', 'below_our_bar', 'no_permission',
    'wrong_moment', 'autonomy_paused', 'missing_information',
    'owner_review_required')),
  vocabulary_version TEXT NOT NULL,

  subject_type TEXT CHECK (subject_type IN (
    'response', 'solicitation_ask', 'solicitation_outreach',
    'solicitation_batch')),
  subject_id   UUID,

  occurred_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- C1 — the lane determines the subject type, TOTALLY.
  --
  -- The trailing `IS TRUE` is not decoration, and there is deliberately no
  -- `ELSE`. A CHECK is SATISFIED by NULL, and a `CASE` that falls through
  -- returns NULL — so without the wrapper, an eighth lane added to the
  -- `refusal_source` CHECK above and forgotten here would accept ANY
  -- subject_type, silently. 114's lesson, 111's idiom. The wrapper is also
  -- why this constraint cannot be proven by inserting a row: the column CHECK
  -- rejects an unmapped lane first, so the eval asserts this DEFINITION.
  CONSTRAINT refusal_events_source_subject_pairing CHECK (
    (CASE refusal_source
       WHEN 'held_draft'         THEN subject_type = 'response'
       WHEN 'policy_gate_held'   THEN subject_type = 'response'
       WHEN 'auto_post_revoked'  THEN subject_type = 'response'
       WHEN 'ask_withheld'       THEN subject_type = 'solicitation_ask'
       WHEN 'outreach_withheld'  THEN subject_type = 'solicitation_outreach'
       WHEN 'batch_halted'       THEN subject_type = 'solicitation_batch'
       WHEN 'autonomy_suspended' THEN subject_type IS NULL
     END) IS TRUE
  ),

  -- C2 — a subject is whole or absent. A typed subject with no id would slip
  -- past the partial unique index below; an id with no type is unresolvable
  -- at read.
  CONSTRAINT refusal_events_subject_completeness CHECK (
    (subject_type IS NULL) = (subject_id IS NULL)
  ),

  -- C3 — account-wide means suspended, and suspended means account-wide.
  -- Biconditional on purpose: it renders two bugs unrepresentable at once —
  -- an account-wide row that is not a suspension, and a suspension pinned to
  -- one location. The second is the precise defect the parent effort hit when
  -- it joined the audit log through `businesses` and multiplied one event per
  -- location.
  CONSTRAINT refusal_events_business_pairing CHECK (
    (business_id IS NOT NULL) = (refusal_source <> 'autonomy_suspended')
  ),

  -- C4 — only `held_draft` has no code. That lane has no code axis at all:
  -- `flagged_responses.reason` is moderation prose that may never leave the
  -- server, and the row exists only for a `high`-severity flag, so the lane
  -- itself is the whole fact.
  CONSTRAINT refusal_events_code_pairing CHECK (
    (refusal_code IS NULL) = (refusal_source = 'held_draft')
  ),

  -- C5 — the code array belongs to one lane, and the winner is a member of
  -- the set it won.
  --
  -- TWO CLAUSES HERE ARE A CORRECTION TO THE SHAPE #1001 LOCKED, AND BOTH ARE
  -- LOAD-BEARING. Without them this CHECK ADMITS the exact row it exists to
  -- forbid. Take refusal_code = 'winner' against
  -- all_refusal_codes = ARRAY['different', NULL]: `= ANY(...)` finds no TRUE
  -- and at least one NULL, so it returns NULL; the first arm collapses to
  -- NULL; `NULL OR FALSE` is NULL; and a CHECK passes on NULL. Postgres
  -- accepts a row that is lying about its own precedence. Reproduced against
  -- a live database before this was written.
  --   * `array_position(..., NULL) IS NULL` forbids a NULL member outright —
  --     a writer bug, and #1001's own standard is to make an invalid
  --     combination unrepresentable rather than merely unlikely.
  --   * the outer `IS TRUE` is C1's wrapper applied to the same NULL class.
  -- The MEMBERS of the array are deliberately NOT checked against the 22
  -- `AutoApprovalBlockReason` values: that enum lives in TypeScript and has no
  -- migration owner, so spelling it here would create a second authority that
  -- drifts.
  CONSTRAINT refusal_events_all_codes_pairing CHECK (
    ((refusal_source =  'policy_gate_held'
        AND all_refusal_codes IS NOT NULL
        AND cardinality(all_refusal_codes) > 0
        AND array_position(all_refusal_codes, NULL) IS NULL
        AND refusal_code = ANY(all_refusal_codes))
     OR
     (refusal_source <> 'policy_gate_held'
        AND all_refusal_codes IS NULL)) IS TRUE
  )
);

COMMENT ON TABLE refusal_events IS
  'The Refusal ledger (#1008, schema locked in #1001). One row is one decision RepWorth made not to act, recorded when it was decided rather than re-derived later. Seven lanes, eight owner-facing categories. Deny-all RLS: the owner reads it through a server route, never directly.';

COMMENT ON COLUMN refusal_events.id IS
  'Worker-supplied UUIDv7 (repo convention). No DB default, deliberately: the writer mints the id inside the deciding transaction.';
COMMENT ON COLUMN refusal_events.account_id IS
  'Billing parent. No ON DELETE action: accounts are retain_deidentified and never deleted, so nothing may take a Refusal away on another table clock.';
COMMENT ON COLUMN refusal_events.business_id IS
  'The location, NULL for the account-wide autonomy_suspended lane and only for it (C3). A read scoped to one location is account_id = $1 AND (business_id = $2 OR business_id IS NULL); it must never fan an account-wide row out across locations.';
COMMENT ON COLUMN refusal_events.refusal_source IS
  'The lane. Per-lane and never global: admin_halt means opposite things in batch_halted and in the outreach copies latchHalt writes.';
COMMENT ON COLUMN refusal_events.refusal_code IS
  'The verbatim code inside the lane, never normalised — it is the input that keeps skew re-derivable. NULL exactly for held_draft (C4).';
COMMENT ON COLUMN refusal_events.all_refusal_codes IS
  'The co-occurring block reasons for policy_gate_held only (C5), kept as non-owner-facing evidence for support and trust-dial tuning (ADR 0023). NULL means this lane has no code axis and never collides with an empty array. Members are owned by TypeScript, not by a CHECK.';
COMMENT ON COLUMN refusal_events.refusal_category IS
  'The owner-facing category, FROZEN at write. The closed set is migration-bearing on ADD and on nothing else: retiring softly needs no migration, renaming is forbidden, reordering is presentation.';
COMMENT ON COLUMN refusal_events.vocabulary_version IS
  'Which map froze this row category (RESTRAINT_POLICY_VERSION model). Its only purpose: #1002 decided there is never a backfill, so it identifies no derived row.';
COMMENT ON COLUMN refusal_events.subject_type IS
  'One of four, or NULL for autonomy_suspended, which points at nothing by design.';
COMMENT ON COLUMN refusal_events.subject_id IS
  'A bare uuid with NO foreign key: NULL (this lane points at nothing) must stay distinguishable from non-null-but-unresolvable (the subject aged away). The Restraint tab drops the LINK, never the row.';
COMMENT ON COLUMN refusal_events.occurred_at IS
  'The DECISION time, supplied by the writer, and the ONE retention clock: the ArchivalPoller sweep (arm lands in #1009) deletes on occurred_at and on nothing else. Never NOW() inside the insert — that is a write timestamp wearing a decision timestamp name.';
COMMENT ON COLUMN refusal_events.created_at IS
  'The INSERT stamp, and NOT a retention candidate — retention is occurred_at alone. The skew between the two is the diagnostic that would prove a writer is stamping occurred_at wrong, which is otherwise unmeasurable.';

-- Retention. The sweep ORDER BY must match an index or the sweep is unbounded
-- (ArchivalPoller arms 9/10's lesson: one ORDER BY, one index). The arm itself
-- lands in #1009; the index ships here because the migration owns it.
CREATE INDEX IF NOT EXISTS idx_refusal_events_archival
  ON refusal_events (occurred_at, id);

-- The owner read AND the offboarding purge delete. account_id LEADS (096 G4):
-- PG16 has no skip scan and the purge filters account-first. This also covers
-- account-wide rows (business_id IS NULL) without a second index. No
-- business_id index: a per-location read narrows by account and window first,
-- and an account's location count is small. Revisit if one account's window
-- ever holds enough rows that filtering locations in memory shows up in the
-- tab's latency.
CREATE INDEX IF NOT EXISTS idx_refusal_events_account_window
  ON refusal_events (account_id, occurred_at DESC);

-- Idempotency. PARTIAL, so autonomy_suspended's NULL subject is never
-- deduplicated and two suspensions of one account stay two distinct Refusals.
-- #1009's insert helper re-spells this predicate BYTE-FOR-BYTE in its
-- `ON CONFLICT ... DO NOTHING` — Postgres cannot infer a partial index
-- otherwise. DO NOTHING is required, not optional: a bare unique index raises
-- on a duplicate and aborts the transaction it sits in, and that transaction
-- is the decision. The ledger must never break the thing it records.
CREATE UNIQUE INDEX IF NOT EXISTS refusal_events_subject_uniq
  ON refusal_events (refusal_source, subject_id)
  WHERE subject_id IS NOT NULL;

ALTER TABLE refusal_events ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all. This is load-bearing, not a default.
-- all_refusal_codes is explicitly non-owner-facing under ADR 0023, and RLS
-- filters ROWS, not COLUMNS — an owner-readable policy would need a view or a
-- column GRANT to withhold it, and that guarantee would stop being one line.

COMMIT;
