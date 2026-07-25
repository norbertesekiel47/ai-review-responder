# Adversarial Implementation Review — Competitor Delta #539

## Scope and evidence

Reviewed `origin/main...HEAD` at `7ca380f5` against:

- `docs/superpowers/plans/feat-competitor-delta-539-intake.json`
- `docs/superpowers/plans/2026-07-24-competitor-delta-539.md`
- `CONTEXT.md` (“Competitor Delta”)
- GitHub issues #539, #532 (including its locked-semantics comment), and map #528
- The producer contract in `worker/jobs/RankingTrackingWorker.ts` and migration
  084's replace-pack semantics

This pass challenges the data-model/read-model approach, snapshot-series
correctness, degradation semantics, and production failure modes. It is not a
style review.

## Findings (confidence >=80%)

| Severity | File:line | Concrete failure scenario / violated decision |
|---|---|---|
| High | `worker/jobs/WeeklySummaryWorker.ts:320` | The read model chooses “current” and “preceding” dates exclusively from rows that still exist in `competitor_snapshots`. An empty latest local pack is persisted by `RankingTrackingWorker.ts:277-299` as a current `ranking_snapshots` row plus DELETE and zero competitor INSERTs; older competitor rows remain. After a non-empty July 6 pack and an empty July 20 run, this query therefore treats July 6 as current and emails a stale rival/gap instead of the intake's “configured location without a usable Competitor pack” teaser. The current observation must be anchored to the latest same-series ranking run (the durable empty-pack fact), then competitor rows resolved for that date; add a regression case for newer-empty-over-older-nonempty history. |

## Approach analysis

The private selector and compact discriminated rendering value are appropriate:
they keep Auto-default policy in the worker and escaped copy in the template
without creating a premature Named-rival seam. Exact keyword/search-location
scoping, coordinate NUMERIC text preservation, signed gap math, `place_id`
velocity matching, and rating normalization all follow the signed plan.

The one revision is structural rather than cosmetic. Because a zero-row child
pack cannot identify its own date, `competitor_snapshots` alone is not the
authoritative observation timeline. `ranking_snapshots` is written in the same
transaction before the pack replacement and remains present for an empty
result, so it is the existing, simpler anchor—no schema, write-path, external
call, or new interface is needed.

## Low-confidence appendix

- `Number('')` normalizes an empty string to `0`, not `null`; the NUMERIC column
  cannot emit that value in normal Postgres reads, so this is not promoted.
- A persistent Competitor Delta query error currently retries/fails the entire
  weekly digest rather than degrading only this optional line. Existing weekly
  ranking reads use the same fail/retry posture, so changing that policy is not
  justified by this ticket alone.
- The final `place_id` comparator returns `1` rather than `0` for duplicate
  identities. Exact duplicate pack identities are not an established producer
  state, and the chosen Named-rival identity would be the same, so this remains
  below threshold.

## VERDICT: REVISE

Resolve the latest-empty-pack stale-read scenario and add its regression test,
then rerun the gate before continuing to the unified review.

## Re-review after fix

Reviewed HEAD `f6bf062b`. The reader now anchors the two observation dates to
the exact `(business_id, keyword, search_location)` series in
`ranking_snapshots`, whose row is committed in the same transaction even when
the child Competitor pack is empty. It then fetches child rows only for those
dates and explicitly passes the current and preceding observation dates to the
selector. Consequently, a newer empty observation cannot promote older child
rows to “current.”

The regression test
`teases when a newer exact-series ranking observation has an empty Competitor pack`
models July 20 as the latest ranking observation with only stale July 6 child
rows and verifies teaser output. The focused worker suite passes 22/22.

| Severity | File:line | Concrete failure scenario / violated decision |
|---|---|---|
| None | — | The accepted fix closes the stale-pack scenario without introducing a new approach-level flaw. |

## FINAL VERDICT: APPROVED

## Triage

- **ACCEPT — High, `WeeklySummaryWorker.ts:320`:** `ranking_snapshots` is the
  authoritative observation timeline for an empty Competitor pack. Anchor the
  latest and preceding exact-series dates there, then read competitor rows for
  those dates so a newer empty pack degrades to the teaser instead of reviving
  stale rival data.
