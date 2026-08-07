// src/app/api/zernio/connect/_shared/finalize/__tests__/import-offer-junction.test.ts
//
// T0 EVAL suite for #677 — titles 14–19 of the intake's 69, authored VERBATIM
// before implementation.
//
// Producer 1 of 4: connect finalize. This is the junction site — subscription
// activated AND a connection just written — so it both CREATES the Import offer
// and gates the enqueue on consent.
//
// Mocked, not live (plan §2): what needs proving here is the BINDINGS and the
// branch structure — that finalize calls createImportOffer, that it enqueues on
// 'accepted' only, and that it does not enqueue twice. The SQL semantics of the
// predicate itself are proven against live Postgres in
// src/lib/reviews/__tests__/import-consent.integration.test.ts.
//
// Harness: the vi.hoisted + txScenario + txCalls recorder already established in
// this directory by finalize-modules.test.ts (:18-24) — same shape, so the two
// files stay readable side by side.
//
import { describe, it } from 'vitest';

describe('finalize connection — Import offer junction', () => {
  // Title 14. The default state after migration 100 is `pending` with a NULL
  // deadline for EVERY business row, so "creates the offer" and "does not
  // import" have to be asserted together: the offer write must not be mistaken
  // for consent.
  it.todo('finalize-tx creates the import offer and enqueues no import when import consent is pending');

  // Spec §7: re-connect after declining stays declined. Derived-expired is the
  // same shape — nothing fires at the expiry moment (#670), so the read-side
  // predicate is what has to hold.
  it.todo('finalize-tx enqueues no import for declined or derived-expired consent');

  it.todo('finalize-tx enqueues the import on reconnect when import consent is already accepted and no run has completed');

  // Round-1 High (F101): accept-then-reconnect would otherwise insert a second
  // job. The completed-run predicate and the in-flight dedup are two distinct
  // guards and title 17 vs 18 keeps them distinguishable — one asserts against a
  // finished run, the other against a job still in flight.
  it.todo('finalize-tx enqueues no import when accepted consent already has a completed run');

  // Dedups against OUTBOX_IN_FLIGHT_STATUSES, imported and never re-spelled
  // (invariant #2's byte-for-byte contract).
  it.todo('finalize-tx enqueues no second import when an in-flight zernio_initial_backfill row already exists');

  // The other half of the junction. Without activation there is no junction, so
  // there is no offer — and this is the case that proves the eligibility check
  // lives inside createImportOffer's own SQL rather than in the caller.
  it.todo('finalize-tx creates no offer when subscription_activated_at is null');
});
