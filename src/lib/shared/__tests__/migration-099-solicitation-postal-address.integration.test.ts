import { describe, it } from 'vitest';

// Shape suite for migration 099 — the Attested postal address on `businesses`
// (#656; locked spec docs/superpowers/specs/2026-07-28-sender-deliverability-design.md
// §7.5). Written as pending placeholders by T1 (the eval task) and filled in by
// T2, once 099 exists and `pnpm test:db:setup` has provisioned it.
//
// The subject is TWO constraints, and only the second is load-bearing:
//
//  1. All-or-nothing over the five columns, so no reader ever branches on "is
//     this attested" — a stored address always carries its attestation.
//
//  2. The attested-bytes digest. Completeness is NOT coverage: an address-only
//     UPDATE by any writer keeps all four attestation columns non-NULL, passes
//     constraint 1, and leaves an attestation dated before bytes it never saw —
//     the precise defect this feature exists to prevent. Only the digest CHECK
//     catches it, and it must fail closed for EVERY writer, not just for
//     `attestPostalAddress`.
//
// Asserting that either CHECK merely EXISTS would be worth nothing: a malformed
// predicate is present and wrong. Case 1 is therefore an EXHAUSTIVE generated
// matrix over the five columns' 2^5 = 32 nullability combinations — exactly two
// legal (all-NULL, and all-present with a MATCHING digest), the other 30
// rejected. Follow migration-096-solicitation-suppressions.integration.test.ts:
// its import block and its rolled-back-probe discipline are the template, and
// it holds the cross-process live-DB lock because a migration-shape suite is
// the sanctioned exception to the no-run-time-DDL rule (#573).
//
// The no-FK case is asserted twice — by introspection (no `pg_constraint` row
// of contype 'f' referencing the attested-by column) and behaviourally (an
// arbitrary UUID inserts fine, and the tuple survives the attesting user's
// deletion). Migration 093's written lesson is why: 086's ON DELETE CASCADE
// meant deleting a staff member deleted their uploads.

describe('migration 099 solicitation postal address', () => {
  it.todo('migration 099 rejects every partially populated postal-address attestation tuple');
  it.todo('migration 099 rejects replacing an attested address without replacing its attestation');
  it.todo('migration 099 adds no foreign key on solicitation_postal_address_attested_by_user_id');
  it.todo('migration 099 keeps the complete attestation tuple after the attesting user is deleted');
});
