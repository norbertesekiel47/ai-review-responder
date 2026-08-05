import { describe, it } from 'vitest';

// The Attested postal address WRITE path against the real schema (#656 T3).
// Written as pending placeholders by T1 (the eval task); T3 fills them in once
// `src/lib/solicitation/postal-address.ts` exists.
//
// Applies NO migration SQL (#573): `pnpm test:db:setup` provisions to head and
// this suite asserts MIGRATION_099_SOLICITATION_POSTAL_ADDRESS with
// assertSchemaReady, so a behind-head DB fails with the actionable setup
// message rather than an undefined-column error.
//
// What decides whether these tests are real, rather than restatements of the
// implementation:
//
//  - "one account-scoped UPDATE" is a STATEMENT-COUNT claim. Capture the issued
//    SQL and assert exactly one `UPDATE businesses` carrying both the `id` and
//    the `account_id` predicate. An outcome-only assertion would pass against a
//    read-then-write that races.
//
//  - "never covers stale bytes" needs three facts after a second attestation
//    with different bytes: `_attested_at` ADVANCED, the stored address equals
//    the new bytes, and `_attested_digest` equals sha256 of the new bytes
//    (node:crypto — invariant #10, never crypto-js).
//
//  - "preserves the previous tuple byte-for-byte" must be driven by BOTH
//    failure modes — a lint-invalid address and an actor outside the account —
//    with all five columns snapshotted before and after and compared with
//    toEqual.
//
//  - the two rejections must stay DISTINGUISHABLE: `actor_not_in_account` vs
//    `business_not_found`. `_attested_by_user_id` carries no FK, so the actor
//    membership predicate on the UPDATE is the only thing stopping a
//    cross-tenant UUID being stamped as legal provenance — collapsing the two
//    statuses would hide which guard fired.

describe('postal address attestation writes', () => {
  it.todo('attestPostalAddress writes the whole attestation tuple in one account-scoped UPDATE');
  it.todo('attestPostalAddress re-attests on edit so the attestation never covers stale bytes');
  it.todo('attestPostalAddress records the new actor on re-attestation');
  it.todo('a failed re-attestation preserves the previous attestation tuple byte-for-byte');
  it.todo("attestPostalAddress rejects an attesting user outside the caller's account");
  it.todo("attestPostalAddress refuses to write for a business outside the caller's account");
  it.todo('readPostalAddressState returns no data for a business outside the supplied account');
});
