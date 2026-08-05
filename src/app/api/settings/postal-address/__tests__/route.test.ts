import { describe, it } from 'vitest';

// PUT /api/settings/postal-address — the attestation route (#656 T4). Written
// as pending placeholders by T1 (the eval task); T4 fills them in.
//
// Auth precedent is `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts`,
// NOT `requireSettingsOwner`: that helper resolves no location and, per its own
// doc comment, deliberately skips the writable-subscription gate. This route
// needs a cookie-resolved active location, a non-writable-subscription refusal,
// and `users.id` for the attester — `resolveOwnerScope` supplies all three, and
// `withSameOrigin()` still wraps the handler because that helper does no CSRF.
//
// Two behaviours the subscription gate does NOT cover, and the tests that pin
// them:
//
//  - Offboarding. `isFullBlockState` is true for `delete_data` at ANY status,
//    and confirming offboarding does not itself cancel the subscription — so a
//    `delete_data/pending` account is still `active`, sails through the
//    subscription gate, and would be able to mutate its sender address
//    mid-teardown. The route re-applies `getOffboardingState` +
//    `isOperationalUIBlocked` itself, BEFORE the body parse.
//
//  - Version assent. An unknown or stale `attestationVersion` is a 400 before
//    any write: a client must never assent to one text while the server records
//    another. `z.strictObject` is equally load-bearing — a body naming
//    `businessId` or `userId` is a tenant-selection knob and must be a 400, not
//    a silently ignored field.
//
// EVERY rejection asserts ZERO WRITES — `expect(mockAttest).not.toHaveBeenCalled()`
// — not merely a status code. The last two cases are the load-bearing ones:
// mock `resolveOwnerScope` to return a `locationId` that is NOT the account's
// primary location and a `userId` that is the `users.id`, then assert those
// exact values reach `attestPostalAddress`. In a multi-location account those
// two facts are the difference between attesting the location the owner is
// looking at and attesting a different one.

describe('PUT /api/settings/postal-address', () => {
  it.todo('PUT /api/settings/postal-address rejects unauthenticated and non-owner callers before writing');
  it.todo('PUT /api/settings/postal-address rejects cross-origin mutation requests');
  it.todo('PUT /api/settings/postal-address refuses writes for a non-writable subscription');
  it.todo('PUT /api/settings/postal-address refuses writes while the account is offboarding');
  it.todo('PUT /api/settings/postal-address rejects a request that omits the attestation');
  it.todo('PUT /api/settings/postal-address rejects an unknown attestation version without writing');
  it.todo('PUT /api/settings/postal-address rejects an address that fails the lint');
  it.todo('PUT /api/settings/postal-address records the authenticated app user as the attester');
  it.todo('PUT /api/settings/postal-address writes the cookie-resolved active location');
});
