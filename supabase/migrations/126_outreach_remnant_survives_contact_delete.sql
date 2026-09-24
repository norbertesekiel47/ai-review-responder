-- 126_outreach_remnant_survives_contact_delete.sql
--
-- #1350, the build ticket for ADR 0033 (docs/adr/0033-outreach-remnant-
-- survives-contact-erasure.md). A per-contact hard delete stops destroying the
-- Outreach row and turns it into an Outreach remnant: the person is erased, the
-- anonymous send signal the Send breaker reads survives.
--
-- WHAT CHANGES — three foreign keys and three NOT NULLs, nothing else:
--
--   solicitation_asks_contact_business_fk      CASCADE -> SET NULL (contact_id)
--   solicitation_outreach_contact_business_fk  CASCADE -> SET NULL (contact_id)
--   solicitation_outreach_ask_tenant_fk        CASCADE -> SET NULL (ask_id)
--   solicitation_asks.contact_id, solicitation_outreach.contact_id,
--   solicitation_outreach.ask_id               NOT NULL dropped
--
-- BOTH CASCADE EDGES, NOT ONE (ADR decision 6). Changing only the outreach →
-- contacts edge saves nothing: the ask still cascades from the contact (088)
-- and the outreach row cascades from the ask (091), so the row dies a second
-- time by the other path. All three edges move together here.
--
-- COLUMN-SCOPED SET NULL, NEVER BARE (ADR decision 7). Every one of these FKs
-- is composite and shares business_id (and, for the ask edge, account_id) with
-- the tenant FKs beside it. A bare ON DELETE SET NULL would null business_id
-- and account_id too, destroying tenant scope — and they are NOT NULL, so the
-- delete would fail outright. The PG15 column list names only the column the
-- delete should clear; 091:211-214 already uses this form for agent_run_id.
--
-- solicitation_asks_batch_contact_uniq UNIQUE (batch_id, contact_id) (088) is
-- DELIBERATELY UNTOUCHED. It admits many remnant asks per batch only because
-- Postgres treats NULLs as distinct by default. Moving it to NULLS NOT DISTINCT
-- would make the second contact delete in any batch fail with 23505.
--
-- The redaction itself is NOT here — it is a write, done by deleteContact
-- (src/lib/solicitation/contacts-repo.ts) in the same transaction as the
-- contact DELETE, BEFORE the row goes. interpolation_inputs stays JSONB NOT
-- NULL: a remnant carries '{}'::jsonb, which is exactly what 091/092's
-- solicitation_outreach_body_presence CHECK already demands of any row that
-- carries body_redacted_at.
--
-- Account purge is unaffected: runContentPurgeStage deletes contact_csv_uploads,
-- which cascades to solicitation_batches and from there, via each child's
-- batch FK (still ON DELETE CASCADE), to every ask and outreach row of the
-- account — remnants included. A remnant outlives one contact, never the
-- account.
--
-- ONE TRANSACTION, load-bearing (110/114's reasoning): psql autocommits each
-- statement, so an unwrapped DROP CONSTRAINT that succeeds followed by an ADD
-- that fails would leave the table with no FK on that edge at all. SET LOCAL
-- lock_timeout bounds the ACCESS EXCLUSIVE acquisition so a long-lived
-- Supavisor session cannot queue this behind it on the send tables.
--
-- NOT VALID + VALIDATE: the column pairs are unchanged, so every stored row
-- already satisfies the new constraint; VALIDATE re-proves it rather than
-- trusting that argument.
--
-- Apply order: staging first, then production. In EACH environment the code
-- that redacts (#1350's deleteContact) must be deployed BEFORE this runs: the
-- new code is safe on the old schema (it redacts, then CASCADE deletes), but
-- the OLD code on this schema would leave unredacted remnants — the body and
-- interpolation_inputs of an erased person. Verify by introspection
-- (pg_get_constraintdef + information_schema.columns), never the ledger. Rollback = restore the three CASCADE FKs (after deleting
-- any remnant rows, which the old NOT NULL would reject) and SET NOT NULL.

BEGIN;

SET LOCAL lock_timeout = '10s';

-- Nullability first: ON DELETE SET NULL onto a NOT NULL column would pass DDL
-- and then fail every contact delete at run time.
ALTER TABLE solicitation_asks
  ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE solicitation_outreach
  ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE solicitation_outreach
  ALTER COLUMN ask_id DROP NOT NULL;

ALTER TABLE solicitation_asks
  DROP CONSTRAINT IF EXISTS solicitation_asks_contact_business_fk;
ALTER TABLE solicitation_asks
  ADD CONSTRAINT solicitation_asks_contact_business_fk
  FOREIGN KEY (contact_id, business_id)
  REFERENCES solicitation_contacts (id, business_id)
  ON DELETE SET NULL (contact_id)
  NOT VALID;

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_contact_business_fk;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_contact_business_fk
  FOREIGN KEY (contact_id, business_id)
  REFERENCES solicitation_contacts (id, business_id)
  ON DELETE SET NULL (contact_id)
  NOT VALID;

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_ask_tenant_fk;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_ask_tenant_fk
  FOREIGN KEY (ask_id, account_id, business_id)
  REFERENCES solicitation_asks (id, account_id, business_id)
  ON DELETE SET NULL (ask_id)
  NOT VALID;

ALTER TABLE solicitation_asks
  VALIDATE CONSTRAINT solicitation_asks_contact_business_fk;
ALTER TABLE solicitation_outreach
  VALIDATE CONSTRAINT solicitation_outreach_contact_business_fk;
ALTER TABLE solicitation_outreach
  VALIDATE CONSTRAINT solicitation_outreach_ask_tenant_fk;

COMMENT ON COLUMN solicitation_outreach.contact_id IS
  'NULL on an Outreach remnant (ADR 0033, #1350): the contact was deleted and every person-bearing column redacted by deleteContact. Never NULL on a live row.';
COMMENT ON COLUMN solicitation_outreach.ask_id IS
  'NULL only when the ask was deleted with its contact because it was still in flight (ADR 0033, #1350). A settled ask survives as a remnant and keeps this link.';
COMMENT ON COLUMN solicitation_asks.contact_id IS
  'NULL on a remnant ask (ADR 0033, #1350): the contact was deleted and evidence reduced to its decision/reason discriminant. Keep solicitation_asks_batch_contact_uniq NULLS DISTINCT.';

COMMIT;
