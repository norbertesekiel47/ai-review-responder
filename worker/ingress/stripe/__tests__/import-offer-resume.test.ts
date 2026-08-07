// worker/ingress/stripe/__tests__/import-offer-resume.test.ts
//
// T0 EVAL suite for #677 — titles 20–23 of the intake's 69, authored VERBATIM
// before implementation.
//
// Producer 2 of 4: the Stripe subscription-activation resume
// (`maybeEnqueueBackfillResume`, worker/ingress/stripe/shared.ts:92). This is
// the OTHER junction ordering — the owner connected Google BEFORE checkout, so
// activation is the second half to arrive and finalize already ran. Spec §5.2.
//
// Two structural facts this suite must not lose:
//
//  1. Round-2 F107: this path used to run on root `sql` with NO transaction, so
//     createImportOffer (which takes TransactionSql) had nothing to run in and
//     its dedup check was unserialized. It now opens sql.begin and takes the
//     businesses row lock first. The lock ORDER is pinned by the source tripwire
//     (title 69); this suite pins the behaviour.
//
//  2. Round-1 Medium (F106): offer creation sits BEFORE the
//     zernioPublishingEnabled() early return. The kill switch governs
//     *publishing*; skipping durable offer creation behind it would lose the
//     offer with no replay path.
//
import { describe, it } from 'vitest';

describe('stripe activation resume — Import offer', () => {
  it.todo('resumePrimaryBusinessBackfill enqueues the import only when import consent is accepted');

  // The §5.2 bug itself: a pre-checkout connection meeting a pending offer. The
  // offer must be created (durably, so the banner can show it) while the import
  // stays un-enqueued (consent has not been given).
  it.todo('resumePrimaryBusinessBackfill creates the offer and enqueues nothing when a pre-checkout connection meets a pending offer');

  // past_due → active is a recovery transition, not a new junction. A location
  // that already declined must not be re-imported by a billing state change —
  // this path fires on every reactivation of the subscription, so it is the most
  // likely place for a declined location to be silently overridden.
  it.todo('resumePrimaryBusinessBackfill does not re-enqueue for a declined location on past_due to active recovery');

  it.todo('resumePrimaryBusinessBackfill enqueues nothing for a derived-expired offer');
});
