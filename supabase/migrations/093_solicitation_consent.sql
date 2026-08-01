-- 093_solicitation_consent.sql
-- The consent ledger: one current-state row per (channel, handle, business)
-- answering "which attestation covers this handle, for this channel, at this
-- location" (#625; locked spec:
-- docs/superpowers/specs/2026-07-28-consent-ledger-design.md Part I §3).
--
-- Design notes (spec section in parentheses):
-- * Current-state rows, MONOTONE FORWARD (D3): granted, then upgraded to a
--   newer attestation version by §4.2's guarded upsert — never backward.
--   Point-in-time "what the sender relied upon" proof is stamped on
--   solicitation_outreach at dispatch, never folded from an event log.
-- * Email-only channel (DR3): no consent row is ever minted for a channel the
--   attestation text did not name. `channel` widens per channel, alongside a
--   new attestation text — never by default. Same rule for `basis` (§3.3):
--   one value, `owner_attested`, which names who asserted it and asserts
--   nothing about legal character.
-- * Business-scoped, deliberately NO account_id (§3.2): 086's warning applies
--   verbatim — businesses.account_id is the single authoritative owner of the
--   business→account pairing; a denormalized account_id here could drift from
--   it. Account-level queries (offboarding purge) join through businesses.
-- * attested_by_user_id is a PLAIN UUID with NO FK (§3.4): 086 declared
--   contact_csv_uploads.attested_by_user_id REFERENCES users(id) ON DELETE
--   CASCADE, so offboarding one staff member deletes their uploads — that
--   cascade must never reach the ledger. attestation_version / attested_at /
--   attested_by_user_id are point-in-time CAPTURES from the upload row (the
--   same pattern invariant #9a mandates for billing), and source_upload_id is
--   an audit pointer only: a vanished upload nulls it, nothing more.
-- * Revocation lives in the suppression ledger, never here (D7 — no
--   revoked_at, ever). Consent fails closed; suppression fails open (DR1):
--   losing a consent row is safe and keeping a stale one is not, so consent
--   rows hard-delete with their contact and on offboarding purge, while
--   suppression rows are retained through purge.
-- * PK is UUIDv7, worker-supplied (repo convention, no DB default).
-- * RLS enabled with ZERO policies — deny-all to the browser, the same
--   server-owned posture as auto_approval_policies (invariant #14). Owner-
--   facing consent state reaches the UI only as a withhold reason on an ask.

CREATE TABLE IF NOT EXISTS solicitation_consent (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  normalized_handle TEXT NOT NULL,     -- output of normalizeEmail (src/lib/solicitation/handles.ts)
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  basis TEXT NOT NULL CHECK (basis IN ('owner_attested')),
  attestation_version TEXT NOT NULL,   -- captured, not joined: the eligibility gate input (§2.2)
  attested_at TIMESTAMPTZ NOT NULL,    -- captured; also §4.2's monotonicity guard
  attested_by_user_id UUID,            -- captured; plain UUID, NO FK (§3.4)
  source_upload_id UUID REFERENCES contact_csv_uploads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The scope key (D4), mirroring solicitation_contacts_email_uniq's
-- (business_id, handle) identity shape. TOTAL rather than partial, so the
-- byte-for-byte ON CONFLICT/predicate gotcha does not arise for §4.2's upsert.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_consent_scope_uniq
  ON solicitation_consent (channel, normalized_handle, business_id);

-- Audit-pointer lookup (and the FK's SET NULL sweep on upload deletion).
CREATE INDEX IF NOT EXISTS idx_solicitation_consent_source_upload
  ON solicitation_consent (source_upload_id);

ALTER TABLE solicitation_consent ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all. All reads and writes come from the
-- Railway worker / server routes over the direct Postgres connection.
