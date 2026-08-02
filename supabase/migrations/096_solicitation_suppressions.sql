-- 096_solicitation_suppressions.sql
-- The Suppression ledger + Unsubscribe token table: the authoritative answer to
-- "may we send to this handle" and the durable target of a delivered ask's
-- opt-out links (#643, split from #626; locked spec:
-- docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §2.1/§2.2).
--
-- Design notes (spec section in parentheses):
-- * Keyed on the Normalized handle per channel, NEVER on contact_id (§1.1) —
--   delete-and-re-upload must not launder an opt-out (#535 §6).
-- * Two Suppression scopes (§1.2). `global` is authored by the recipient or the
--   mail ecosystem on their behalf and keys on (channel, normalized_handle) —
--   global because every account sends from one shared identity, so from the
--   recipient's inbox there is exactly one sender. `account` is the owner's own
--   do-not-contact and keys on (channel, normalized_handle, account_id).
-- * TWO PARTIAL unique indexes, so every ON CONFLICT must re-spell its
--   predicate BYTE-FOR-BYTE or Postgres will not infer the constraint
--   (CLAUDE.md gotcha; 086 is the in-repo pattern). Writers are
--   ON CONFLICT ... DO NOTHING: FIRST WRITE WINS (§2.1).
-- * account_id is the SCOPE, not a denormalization (§1.2): the row does not
--   hang off a business, so there is nothing for it to drift from. 086's
--   warning does not apply. The CHECK pairing is ONE-DIRECTIONAL: an `account`
--   row REQUIRES account_id; a `global` row MAY carry it as provenance.
-- * NO ON DELETE SET NULL on account_id (§6.3): global rows are retained
--   through offboarding purge with account_id INTACT, pointing at the
--   already-tombstoned accounts row. The purge is an explicit, verified
--   operation, never a cascade side effect.
-- * Raw normalized handle, NOT a peppered hash (§6.4). A bare SHA-256 of an
--   email is dictionary-attackable; a real HMAC pepper is a catastrophic SPOF
--   on a compliance record — lose or rotate it and every opt-out is silently
--   un-suppressed with no way to detect or rebuild it.
-- * No time-window comparison is ever made against suppressed_at (§2.1) — both
--   evaluation points are existence checks, which deliberately sidesteps the
--   postgres.js microsecond-truncation class.
-- * outreach_id on the token table is ON DELETE SET NULL (#643 grilling G1,
--   revised in review round 1). solicitation_outreach cascades from
--   solicitation_batches from contact_csv_uploads, so a CASCADE FK would delete
--   the retained token rows that §5.2 exists to guarantee. SET NULL keeps the
--   token, nulls the provenance in the DB, and satisfies B9's referential
--   requirement as literally written. ask_id keeps §2.2's NO-FK posture because
--   solicitation_asks has no column we could hang a SET NULL on without the
--   same cascade problem.
-- * account_id-leading indexes on BOTH tables (G4): the partial uniques lead
--   with (channel, normalized_handle), but the purge delete, the retained-row
--   count and the token scrub all filter account-first, and PG16 has no skip
--   scan. This is migration 095's lesson applied up front.
-- * PK is UUIDv7, worker-supplied (repo convention, no DB default).
-- * RLS enabled with ZERO policies — deny-all, the auto_approval_policies
--   posture (invariant #14). Not decorative: a direct client read of a global
--   row would expose account_id provenance, which §7.4 forbids surfacing.
-- Rollback: safe to DROP BOTH TABLES only while empty, i.e. before the first
-- writer merges (#644/#645/#627). Revert the app deploy FIRST — batch-builder,
-- purge-verification and purge-stages all reference these tables.

CREATE TABLE IF NOT EXISTS solicitation_suppressions (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  normalized_handle TEXT NOT NULL,     -- output of normalizeEmail (src/lib/solicitation/handles.ts)
  scope TEXT NOT NULL CHECK (scope IN ('global', 'account')),
  account_id UUID REFERENCES accounts(id),   -- NO ON DELETE action (§6.3)
  source TEXT NOT NULL CHECK (source IN (
    'unsubscribe_link',
    'unsubscribe_one_click',
    'bounce_permanent',
    'complaint',
    'provider_suppressed',
    'admin_manual',
    'owner_manual'
  )),
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID,             -- admin_manual / owner_manual only; plain UUID, NO FK
  note TEXT,                           -- manual entries; the §7.5 originating message reference
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitation_suppressions_account_scope_pairing
    CHECK (scope <> 'account' OR account_id IS NOT NULL),
  -- G11: §3.1's source->scope mapping is TOTAL, so enforce it in the DB.
  -- Without this, `owner_manual` + `global` inserts cleanly and one owner can
  -- suppress a recipient across EVERY tenant with no recipient having spoken —
  -- the precise cross-tenant write §1.2 exists to prevent. `owner_manual` is
  -- the only account-scoped source; every other source is recipient- or
  -- ecosystem-authored and therefore global.
  CONSTRAINT solicitation_suppressions_source_scope_pairing
    CHECK (
      (scope = 'account' AND source = 'owner_manual')
      OR (scope = 'global' AND source <> 'owner_manual')
    )
);

-- §1.2's two key shapes. PARTIAL — every ON CONFLICT re-spells the predicate
-- byte-for-byte or the constraint is not inferred.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_suppressions_global_uniq
  ON solicitation_suppressions (channel, normalized_handle)
  WHERE scope = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS solicitation_suppressions_account_uniq
  ON solicitation_suppressions (channel, normalized_handle, account_id)
  WHERE scope = 'account';

-- G4: account-leading, for the offboarding purge delete (scope='account'),
-- the retained-row count (scope='global') and purge verification.
CREATE INDEX IF NOT EXISTS idx_solicitation_suppressions_account
  ON solicitation_suppressions (account_id, scope)
  WHERE account_id IS NOT NULL;

ALTER TABLE solicitation_suppressions ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all.

CREATE TABLE IF NOT EXISTS solicitation_unsubscribe_tokens (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  token_hash TEXT NOT NULL UNIQUE,     -- SHA-256, node:crypto (invariant #10); raw token NEVER stored (invariant #5)
  normalized_handle TEXT NOT NULL,     -- the redemption target
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  account_id UUID,                     -- provenance; scrubbed to NULL on purge (§6.3). Plain UUID, NO FK.
  business_id UUID,                    -- provenance; scrubbed on purge. Plain UUID, NO FK.
  ask_id UUID,                         -- provenance; scrubbed on purge. NO FK — referent is hard-deleted (§2.2).
  outreach_id UUID REFERENCES solicitation_outreach(id) ON DELETE SET NULL,  -- provenance + idempotent mint key (B4); G1
  sent_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,             -- first redemption; a second is a no-op success
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- G12: a partially-scrubbed row must be impossible, so the purge verifier can
  -- prove scrub completeness from ANY ONE column. Deliberately EXCLUDES
  -- outreach_id: SET NULL may null it independently, while the account is still
  -- live, the moment its outreach row is deleted for unrelated reasons.
  -- Stated as an IMPLICATION, not a symmetric all-or-none (review round 2,
  -- finding 14): the earlier `(all null) OR (account_id AND business_id set)`
  -- form left `ask_id` unconstrained on the live arm, so
  -- (account set, business set, ask NULL) passed and the constraint did not
  -- mean what its name claimed. A symmetric form would ALSO be wrong here — it
  -- would force ask_id NOT NULL on every live row, which over-constrains a
  -- provenance column the spec lists as optional. What purge verification
  -- actually needs is the one-way guarantee below: scrubbing account_id
  -- implies the rest are scrubbed, so checking account_id/business_id is
  -- sufficient to prove ask_id was scrubbed too.
  CONSTRAINT solicitation_unsubscribe_tokens_provenance_scrub_implication
    CHECK (account_id IS NOT NULL OR (business_id IS NULL AND ask_id IS NULL))
);

-- B4's idempotent mint key: a #630 dispatch retry re-uses the existing token
-- row for the same outreach. PARTIAL so purge-scrubbed NULLs never collide.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_unsubscribe_tokens_outreach_uniq
  ON solicitation_unsubscribe_tokens (outreach_id)
  WHERE outreach_id IS NOT NULL;

-- G4: account-leading, for the offboarding purge scrub.
CREATE INDEX IF NOT EXISTS idx_solicitation_unsubscribe_tokens_account
  ON solicitation_unsubscribe_tokens (account_id)
  WHERE account_id IS NOT NULL;

ALTER TABLE solicitation_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all.
