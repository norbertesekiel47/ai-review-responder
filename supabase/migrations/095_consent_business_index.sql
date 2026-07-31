-- 095_consent_business_index.sql
-- Business-leading index for the consent ledger's compliance deletes (#625
-- review round; Codex adversarial finding, 2026-07-30).
--
-- The offboarding/purge DELETEs (worker/jobs/account-offboarding/
-- purge-stages.ts sweeps solicitation_consent per business under the account)
-- and the contact-delete sweep (src/lib/solicitation/contacts-repo.ts, spec
-- §7.1) both filter by business_id (+ normalized_handle). 093's only
-- multi-column index — solicitation_consent_scope_uniq — leads with channel:
-- (channel, normalized_handle, business_id). PG16 has no skip scan, so
-- without a business-leading index those compliance deletes degrade to
-- full-table scans on a no-TTL table (§7.3) that only ever grows.
--
-- Index-only migration: no data change, no new relation (no retention-policy
-- row), no RLS impact. Rollback: DROP INDEX
-- idx_solicitation_consent_business_handle.

CREATE INDEX IF NOT EXISTS idx_solicitation_consent_business_handle
  ON solicitation_consent (business_id, normalized_handle);
