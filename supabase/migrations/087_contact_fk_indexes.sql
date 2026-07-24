-- 087_contact_fk_indexes.sql
-- Covering indexes for the three un-indexed FK columns added by 086 (#541,
-- PR #564 review): the ON DELETE CASCADE triggers behind
-- contact_csv_uploads → solicitation_contacts.created_by_upload_id /
-- solicitation_visits.upload_id, and users → contact_csv_uploads.attested_by_user_id,
-- seq-scan the referencing table per deleted parent row during the
-- offboarding purge sweep. Purely additive — no RLS or retention change.
-- Apply staging first, then prod, in lockstep (CLAUDE.md migration rule).

CREATE INDEX IF NOT EXISTS idx_solicitation_contacts_created_by_upload
  ON solicitation_contacts (created_by_upload_id);

CREATE INDEX IF NOT EXISTS idx_solicitation_visits_upload
  ON solicitation_visits (upload_id);

CREATE INDEX IF NOT EXISTS idx_contact_csv_uploads_attested_by_user
  ON contact_csv_uploads (attested_by_user_id);
