// src/components/dashboard/account-state/__tests__/ImportOfferBanner.test.tsx
//
// T0 EVAL suite for #677 — titles 49–54 and 68 of the intake's 69, authored
// VERBATIM before implementation.
//
// RTL, following the harness already used by
// src/components/dashboard/__tests__/ConnectGoogleBanner.test.tsx — the banner
// this one sits beside in the same dashboard slot.
//
// THE EVAL BAR FOR A UI SLICE (plan §3 T0, bar item 4): a banner test that only
// asserts rendered copy passes against a DEAD component. So these titles drive
// the buttons and assert the POST body and the POST-RESPONSE state, not the
// markup. Title 51 is the specific trap: an optimistic flip to `importing` before
// the request succeeds would satisfy a naive "shows importing after click"
// assertion while silently telling the owner an import started that never did.
//
// Copy is LOCKED verbatim (owner decision 6, plan T5), including the 7-day
// disclosure and the mandatory reassurance line — title 49 pins both. The
// reassurance line exists so declining does not read as "reviews stop being
// handled": new reviews are still handled automatically either way.
//
import { describe, it } from 'vitest';

describe('ImportOfferBanner', () => {
  it.todo('ImportOfferBanner renders the one-time import wording and the automatic-handling reassurance');

  // Self-nulls, exactly like ConnectGoogleBanner — the banner seam already has an
  // adapter that returns null, so this is a new adapter at an existing seam and
  // not a new seam (plan §1).
  it.todo('ImportOfferBanner renders nothing when no import offer is pending');

  // The optimistic-flip trap. State advances ONLY on a successful response.
  it.todo('ImportOfferBanner posts the accept decision and only shows importing after the request succeeds');

  it.todo('ImportOfferBanner posts the decline decision and stops rendering');

  // The zero-review case is a distinct OUTCOME, not a count of zero: "No recent
  // reviews found — nothing to import." Rendering "Imported 0 reviews" is the
  // failure this title catches (owner decision 4).
  it.todo('ImportOfferBanner renders the empty outcome copy rather than an imported count of zero');

  // `refetchInterval` is active ONLY while state === 'importing'. The failed state
  // carries a neutral message and support contact and deliberately has NO retry
  // button — retry belongs to the worker via the `completed_at IS NULL` sentinel,
  // and an owner-facing retry would enqueue a second job.
  it.todo('ImportOfferBanner stops polling and renders the failed state when the import terminates');

  // Title 68 (round-2): the `imported` happy path had no rendering assertion at
  // all, and the accessibility announcement was folded into the polling title
  // where it was invisible. Round 2 withdrew that merge; keep them named.
  it.todo('ImportOfferBanner renders the imported count and announces the terminal transition through LiveRegion');
});
