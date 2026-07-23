# Zernio automated-posting limits — go-live gate record

**Gate:** design doc 2026-07-01 §4 launch-track item 1; referenced by
`agentic-staging-copilot-autopilot-e2e.md` §7 and the Phase D runbook §5.

## Zernio's answer (2026-07-22, via owner)

- **Automated (machine-initiated) reply posting: permitted.** (Confirmed
  earlier, ~2026-07-01.)
- **Rate/volume limits: none.** Pricing is **pay-per-use, per account**.
- **Recorded where:** _<link or paste the written confirmation (email/support
  thread) here — the gate closes fully when this is filled>_
- **Pricing unit:** _<per API call / per posted reply / per location / per
  month — TBD, see open question 2>_

## What this means for us (the part that matters)

1. **All pacing responsibility is now ours.** "No limit at Zernio" does NOT
   mean Google tolerates unlimited machine-cadence replies on a business
   profile — the pattern-flagging risk to *customers' profiles* was always the
   deeper concern, and with no provider throttle in front of us, our
   self-imposed pacing is the only pacing. The mitigations already built are
   therefore **mandatory, not optional**: per-location daily auto-post caps
   (default 10, ceiling 50 — migration 074), the 15/30-min veto window (which
   inherently spaces posts), and posting-cadence jitter. Never remove these on
   the grounds that "Zernio has no limit."
2. **Pay-per-use makes API-call volume a COGS line, not just a reliability
   concern.** Our per-post cost is not one call: `postReply` + the post-publish
   verification re-read (`verify-posted.ts` walks `listAllReviews`), plus the
   5-min `ZernioRecentReviewPoller` per connection and paged backfills
   (≤200 reviews/walk). Depending on the pricing unit, the *reads* may dominate
   the *writes*. Zernio usage is not currently metered in `api_costs`
   (LLM-only today).

## Open items to fully close the gate

1. **File the written confirmation** (paste/link above). If the "no limits /
   pay-per-use" answer was verbal or in-app chat, ask for a one-line email echo.
2. **Pin down the pricing unit** and rough per-unit cost → then decide whether
   Zernio usage needs metering in the margin model (`api_costs` /
   `margin-service`) before scale, or whether a monthly invoice sanity-check
   suffices at launch volume.

## Gate status: **CLOSED for launch** (conditional)

Permission + no-limits are answered; the two open items above are
record-keeping and margin hygiene, not launch blockers. Production go-live no
longer waits on Zernio.
