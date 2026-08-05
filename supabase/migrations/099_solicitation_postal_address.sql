-- 099_solicitation_postal_address.sql
-- The Attested postal address on `businesses`: the CAN-SPAM §7704(a)(5) sender
-- address baked verbatim into every ask footer, and a send precondition (#656;
-- locked spec docs/superpowers/specs/2026-07-28-sender-deliverability-design.md
-- §7.5/§7.6, amended by
-- docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md).
--
-- Design notes (spec section in parentheses):
-- * Five additive nullable columns on `businesses`, following 089's precedent
--   that per-location config lives here rather than in a side table: a location
--   has at most one sender address, so a 1:1 column set beats a join, and the
--   batch builder's existing businesses SELECT picks the precondition up for
--   free.
-- * Deliberately NOT `google_place_address` (§7.5). That column is Google's
--   `formattedAddress`: it can be a service-area value like "Austin, TX, USA"
--   for a mobile business, it is not owner-attested, it cannot express a
--   USPS-registered PO box, and the offboarding purge NULLs it. It is offered
--   to the owner as an editable SUGGESTION and never silently promoted.
-- * `solicitation_postal_address_attested_by_user_id` is a PLAIN UUID with NO
--   FOREIGN KEY — migration 093's written lesson: 086 declared
--   contact_csv_uploads.attested_by_user_id REFERENCES users(id) ON DELETE
--   CASCADE, so offboarding one staff member deleted their uploads. The
--   attestation quartet is a point-in-time CAPTURE (the same pattern invariant
--   #9a mandates for billing) and must outlive the user it names. Because there
--   is no FK, the WRITER verifies the actor: `attestPostalAddress`
--   (src/lib/solicitation/postal-address.ts) carries the account-membership
--   predicate on the same scoped UPDATE.
-- * CHECK #1 is all-or-nothing over the five columns, so no reader ever
--   branches on "is this attested": a stored address always carries its
--   attestation, and a single non-NULL `_attested_at` is the whole test.
-- * CHECK #2 IS THE ONE THAT MATTERS. Completeness is not coverage — see the
--   comment above the constraint itself.
-- * No index: every read is already scoped by `businesses.id` (PK) or
--   `account_id` (existing index), and the precondition is read as part of a
--   row the builder already loads.
-- * RLS: `businesses`' existing policies cover these columns unchanged. All
--   writes come from the owner-scoped Next.js route over the direct Postgres
--   connection, and the offboarding purge clears all five in the same statement
--   that NULLs `google_place_address`.
-- * Additive-only: no backfill, no DEFAULT, no CONCURRENTLY. Existing rows keep
--   NULL and behave exactly as today (no attested address -> the Send handoff is
--   withheld, while watch-mode batch construction is untouched). The whole file
--   applies in one transaction.
-- Rollback: revert the app deploy FIRST (the route, the domain module, the
-- batch builder's precondition read and the purge stage are the only code that
-- touches these columns), then DROP the columns if desired — they are inert
-- with the code reverted, so no down migration is required.

SET lock_timeout = '5s';

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS solicitation_postal_address                      TEXT,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attested_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attested_by_user_id  UUID,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attestation_version  TEXT,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attested_digest      TEXT;

COMMENT ON COLUMN businesses.solicitation_postal_address IS
  'Owner-attested CAN-SPAM sender address for this location, baked VERBATIM into every ask footer (#656 §7.5). NULL = the Send handoff is withheld. Never google_place_address.';
COMMENT ON COLUMN businesses.solicitation_postal_address_attested_at IS
  'Writer-recorded moment of attestation, and the single "may this location send" test. NOT schema-proven to cover the currently stored bytes — see the digest CHECK caveat below for exactly what is and is not guaranteed.';
COMMENT ON COLUMN businesses.solicitation_postal_address_attested_by_user_id IS
  'users.id of the attesting owner, captured point-in-time. PLAIN UUID, NO FK (093 lesson) — the writer verifies account membership instead.';
COMMENT ON COLUMN businesses.solicitation_postal_address_attestation_version IS
  'POSTAL_ADDRESS_ATTESTATION_VERSION of the text the owner assented to. Changing the wording bumps the version.';
COMMENT ON COLUMN businesses.solicitation_postal_address_attested_digest IS
  'sha256 hex of the CURRENTLY STORED address. CHECKed against that address, so an address-only UPDATE by ANY writer fails closed. It binds the digest to the bytes — it does not prove the attestation metadata ever covered them.';

-- All-or-nothing over the tuple: a stored address always carries a complete
-- attestation, so no reader ever branches on "is this attested".
ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_solicitation_postal_address_attested;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_solicitation_postal_address_attested
  CHECK (
    (solicitation_postal_address                        IS NULL
     AND solicitation_postal_address_attested_at        IS NULL
     AND solicitation_postal_address_attested_by_user_id IS NULL
     AND solicitation_postal_address_attestation_version IS NULL
     AND solicitation_postal_address_attested_digest    IS NULL)
    OR
    (solicitation_postal_address                        IS NOT NULL
     AND solicitation_postal_address_attested_at        IS NOT NULL
     AND solicitation_postal_address_attested_by_user_id IS NOT NULL
     AND solicitation_postal_address_attestation_version IS NOT NULL
     AND solicitation_postal_address_attested_digest    IS NOT NULL)
  );

-- Binds the stored digest to the stored bytes. Completeness is not coverage: an
-- address-only UPDATE keeps the quartet non-NULL and passes the constraint
-- above, leaving an attestation over bytes it never saw. This CHECK makes that
-- update fail closed.
--
-- What it does NOT do, stated so no future reader over-reads it: it proves the
-- digest matches the CURRENT address, not that the preserved _attested_at /
-- _attested_by_user_id / _attestation_version ever covered those bytes. A
-- writer that changes the address AND recomputes the digest while keeping the
-- old metadata still passes. Closing that needs OLD vs NEW — a trigger — and
-- was deliberately declined (owner decision, 2026-08-04; plan "Design
-- decisions" #1). The accidental path is closed; the residual is forgery.
--
-- Volatility, precisely: sha256() and encode() are IMMUTABLE, but convert_to()
-- is STABLE (provolatile 's') because its result depends on server_encoding.
-- Postgres does NOT reject a STABLE function in a CHECK the way it rejects one
-- in an index predicate, and this database is UTF8 — an encoding that cannot
-- change under a live table — so the expression is deterministic in practice.
-- Verified empirically: both constraints create, and an address-only UPDATE is
-- rejected. Do NOT copy this expression into an index.
ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_solicitation_postal_address_digest;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_solicitation_postal_address_digest
  CHECK (
    solicitation_postal_address IS NULL
    OR solicitation_postal_address_attested_digest
       = encode(sha256(convert_to(solicitation_postal_address, 'UTF8')), 'hex')
  );
