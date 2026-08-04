-- 098_solicitation_suppression_corrections.sql
-- The Correction path's audit sink (#645; locked spec
-- docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §8.2).
--
-- WHY A NEW TABLE RATHER THAN account_audit_log. §8.2's posture is
-- writeAccountAuditLog's — an audit record in the SAME transaction as the
-- delete — but not its table: account_audit_log.account_id is
-- NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, and the rows §8.2 exists
-- to correct carry no account. An `admin_manual` global row entered from a
-- forwarded mailbox reply has no account to attribute (the §7.3 input is an
-- address and a note), and a `provider_suppressed` mirror originating on the
-- transactional side (§3.3) has none either. Those are two of the three cases
-- §8.2 names. A CASCADE would additionally delete the compliance record along
-- with the account it merely names as provenance.
--
-- NO FOREIGN KEYS anywhere, deliberately: `suppression_id`'s referent is
-- DELETEd by the very statement that writes this row (that is the whole point),
-- and `account_id`, `created_by_user_id` and `removed_by_user_id` all follow
-- 096's `created_by_user_id` posture — plain UUIDs, because a compliance record
-- must outlive the rows it names. An FK to accounts(id) would additionally let
-- an offboarding purge CASCADE the record away with the account it names.
--
-- IT CARRIES THE CORRECTED ROW'S OWN account_id, created_by_user_id AND note.
-- That is the substance of the record, not incidental provenance (deviation
-- D-A11, superseding plan P-2). A correction DELETEs an assertion; these three
-- columns are the evidence that the assertion was legitimate when it was made.
-- For a `scope='account'` row, `account_id` is not provenance at all — it is the
-- Suppression scope key itself, non-null by construction (§1.2) — so without it
-- an account-scoped correction cannot say WHOSE do-not-contact was removed. For
-- a `global` row it is provenance and may be null. `created_by_user_id` and
-- `note` are exactly what §7.3 makes required of a manual entry: who entered the
-- opt-out, and the originating message reference proving it was real. Dropping
-- them destroyed the evidence behind the very assertion being corrected, and
-- there is nothing to backfill it from — the source row is gone.
--
-- The table is therefore account-linked, and it is CLASSIFIED rather than
-- RENAMED TO EVADE CLASSIFICATION. `original_account_id` /
-- `original_created_by_user_id` would slip past
-- accountLinkedTablesFromMigrations() in
-- src/lib/account-offboarding/__tests__/table-disposition.test.ts on a
-- word-boundary technicality: its pattern needs a word boundary before
-- `account_id`, and a leading `original_` removes it. Naming data to dodge a
-- governance check is worse than the gap it hides — the detector would go quiet
-- while the retention obligation stayed exactly as real. So the columns keep
-- their honest names and the table takes its TENANT_TABLES,
-- TABLE_DISPOSITIONS and purge-verification entries as
-- `retain_compliance_limited_pii`, the disposition `solicitation_suppressions`
-- and `solicitation_unsubscribe_tokens` already carry for this same class of
-- data (D7).
--
-- RLS deny-all with ZERO policies — the auto_approval_policies posture
-- (invariant #14), matching 096. Not decorative: a row here names a recipient's
-- Normalized handle, so a direct client read would expose that an identified
-- person's opt-out was removed.
--
-- The record is immutable: no updated_at, no soft-delete column. A correction
-- that was itself wrong is a new suppression row via §7.3, not an edit here.
--
-- Rollback: revert the app deploy FIRST (the admin routes are the only
-- writers), then DROP TABLE. Safe while empty; drops only correction history
-- when not. Nothing in the ledger, the batch build or the offboarding purge
-- reads this table.

CREATE TABLE IF NOT EXISTS solicitation_suppression_corrections (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the app (repo convention, no DB default)
  suppression_id UUID NOT NULL,        -- the removed row's id; NO FK (referent is gone by design)
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  normalized_handle TEXT NOT NULL,     -- what was removed; raw, matching §6.4's posture on the ledger
  scope TEXT NOT NULL CHECK (scope IN ('global', 'account')),
  -- Copied from the removed row. NULLABLE and NO FK: the Suppression scope key
  -- for an `account` row (non-null by construction, §1.2), plain provenance for
  -- a `global` one. Deliberately NOT re-CHECKed against `scope` the way 096
  -- does — 098 records what the ledger held, it does not re-adjudicate it.
  account_id UUID,
  source TEXT NOT NULL CHECK (source IN (
    'unsubscribe_link',
    'unsubscribe_one_click',
    'bounce_permanent',
    'complaint',
    'provider_suppressed',
    'admin_manual',
    'owner_manual'
  )),
  suppressed_at TIMESTAMPTZ NOT NULL,  -- when the REMOVED row was recorded, copied from it
  -- Who created the suppression being corrected, and the §7.3 originating
  -- message reference. Both copied from the removed row and both NULLABLE:
  -- machine sources (bounce, complaint, provider_suppressed, the unsubscribe
  -- paths) write neither. Not the same fact as `removed_by_user_id` below — one
  -- names the person who asserted the opt-out, the other the admin who undid it.
  created_by_user_id UUID,
  note TEXT,
  removed_by_user_id UUID NOT NULL,    -- the admin; plain UUID, NO FK (096's created_by_user_id posture)
  -- "why" is not optional on this path. Stated as "contains at least one
  -- non-whitespace character" rather than as `length(btrim(reason)) > 0`:
  -- one-argument btrim strips SPACES ONLY, so a tab- or newline-only reason
  -- passes it (verified against PG16 while writing this migration), which is a
  -- blank reason wearing a different character. The route's zod schema uses
  -- JS `.trim()`, which strips all whitespace — this backstop now agrees with it.
  reason TEXT NOT NULL CHECK (reason ~ '[^[:space:]]'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The admin lookup shows prior corrections for a handle alongside its live
-- rows, so a re-entry after a correction is visible rather than a surprise.
-- Handle-leading because that is the only way this table is ever queried.
CREATE INDEX IF NOT EXISTS idx_solicitation_suppression_corrections_handle
  ON solicitation_suppression_corrections (channel, normalized_handle, created_at DESC);

ALTER TABLE solicitation_suppression_corrections ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all.

COMMENT ON TABLE solicitation_suppression_corrections IS
  'Correction path audit records (#645, spec §8.2): error correction, NEVER re-subscribe. One row per admin-removed suppression, written in the same transaction as the DELETE.';
