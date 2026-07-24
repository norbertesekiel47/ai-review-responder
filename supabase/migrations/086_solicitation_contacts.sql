-- 086_solicitation_contacts.sql
-- Contacts/visits CSV ingestion + consent attestation (#541, map #528;
-- contract locked in #535: docs/superpowers/specs/2026-07-23-contacts-csv-contract-design.md).
--
-- Contact = deduped identity of one person at one location, keyed
-- (business_id, normalized handle) — enforced as TWO partial unique indexes
-- (email, phone) because either handle identifies the contact (§1.2).
-- Visit = append-only ledger row unique on (contact_id, visit_date) (§1.3):
-- re-uploads are idempotent by construction.
-- contact_csv_uploads.raw_csv exists only for transport: the worker NULLs it
-- in the SAME transaction that writes the terminal report (§3). Metadata
-- (filename, byte_size, content_sha256, counts, report, attestation) is kept.
-- Consent attestation is per-upload (§4): attesting user + timestamp +
-- versioned attestation-text constant. NO per-row consent columns (counsel).
-- All deletes are hard deletes with CASCADE (§5); offboarding purge sweeps
-- all three tables (table-disposition entries ride this PR).
-- RLS: owner read-only, mirroring competitor_snapshots (084). All writes come
-- from the Railway worker / server routes over the direct Postgres connection.

CREATE TABLE IF NOT EXISTS contact_csv_uploads (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the route
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  raw_csv TEXT,                        -- NULLed at terminal state (§3)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  report JSONB,                        -- terminal ingest report (§3)
  attested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attested_at TIMESTAMPTZ NOT NULL,
  attestation_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  -- Terminal state carries a report and no raw CSV; pending carries the raw
  -- CSV and no report. A pending row without raw_csv is unprocessable and
  -- unrepresentable.
  CONSTRAINT contact_csv_uploads_terminal_consistency CHECK (
    (status = 'pending' AND report IS NULL AND completed_at IS NULL
     AND raw_csv IS NOT NULL)
    OR (status IN ('completed', 'failed') AND report IS NOT NULL
        AND completed_at IS NOT NULL AND raw_csv IS NULL)
  )
);
-- NOTE: contact/visit FKs below CASCADE from this table. There is NO
-- individual-upload delete path anywhere in the app (upload-undo is
-- contractually impossible, #535 §1.3) — the CASCADE exists solely so
-- account/business offboarding deletion sweeps cleanly.

CREATE INDEX IF NOT EXISTS idx_contact_csv_uploads_business
  ON contact_csv_uploads (business_id, created_at DESC);

-- Contacts are BUSINESS-scoped only: businesses.account_id is the single
-- authoritative owner of the business→account pairing (a denormalized
-- account_id here could drift from it). Account-level queries (RLS,
-- offboarding purge) join through businesses.
CREATE TABLE IF NOT EXISTS solicitation_contacts (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,                          -- Normalized handle: lowercased/trimmed
  phone TEXT,                          -- Normalized handle: E.164
  created_by_upload_id UUID NOT NULL REFERENCES contact_csv_uploads(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitation_contacts_handle_present CHECK (email IS NOT NULL OR phone IS NOT NULL),
  -- Composite-FK target so visits are provably same-location as their contact.
  CONSTRAINT solicitation_contacts_id_business_uniq UNIQUE (id, business_id)
);

-- Partial unique indexes enforce (business_id, normalized handle) identity
-- (§1.1). Ingest NEVER writes ON CONFLICT against these (a per-business
-- advisory lock serializes read-then-write instead), so the byte-for-byte
-- ON CONFLICT/predicate gotcha does not apply here.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_contacts_email_uniq
  ON solicitation_contacts (business_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_contacts_phone_uniq
  ON solicitation_contacts (business_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS solicitation_visits (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  contact_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  visit_date DATE NOT NULL,
  note TEXT,
  upload_id UUID NOT NULL REFERENCES contact_csv_uploads(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitation_visits_contact_date_uniq UNIQUE (contact_id, visit_date),
  -- Composite FK: a visit can only reference a contact at the SAME location
  -- (DB-enforced tenant integrity, not just app-enforced).
  CONSTRAINT solicitation_visits_contact_business_fk
    FOREIGN KEY (contact_id, business_id)
    REFERENCES solicitation_contacts (id, business_id) ON DELETE CASCADE
);

ALTER TABLE contact_csv_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitation_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitation_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_csv_uploads_owner_select ON contact_csv_uploads;
CREATE POLICY contact_csv_uploads_owner_select ON contact_csv_uploads
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

DROP POLICY IF EXISTS solicitation_contacts_owner_select ON solicitation_contacts;
CREATE POLICY solicitation_contacts_owner_select ON solicitation_contacts
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

DROP POLICY IF EXISTS solicitation_visits_owner_select ON solicitation_visits;
CREATE POLICY solicitation_visits_owner_select ON solicitation_visits
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));
