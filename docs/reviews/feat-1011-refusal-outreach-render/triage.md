# Triage — #1011, the `outreach_withheld` render lane

Review wave, round 1, dispatched in one parallel message against the pinned fork
`06a163f0` and head `535e0763`, with the review gate green (29 rows, 0 FAIL, 0
WARN, first round) behind it.

| Axis | Report | Findings |
|---|---|---|
| Spec & correctness | `spec-correctness.md` | 1 LOW |
| Standards & maintainability (cross-branch) | `standards-cross-branch.md` | 2 touching this branch |
| Red team | `docs/reviews/red-team/feat-1011-refusal-outreach-render-c5a429/` | **1 P0**, 2 P2 · 21 planted / 18 killed / 2 survived |

**Nothing was rejected.** One P0 fixed on this branch; the rest carried to a
named follow-up with their reasons.

---

## RT-1 — P0 — the branch's central property was pinned for ONE writer of four

Recorded in full as **D0** in the deviations file. Summary, because it is the
finding of the whole run:

This branch exists to move the render clock ahead of the transaction and the
advisory-lock wait. Red team moved `regenerateAsk`'s and
`settleGenerationExhaustion`'s clock reads back INSIDE their transactions — the
design the owner explicitly rejected — and **all 23 titles stayed green.**

Two reasons the eval was blind, and the second is the one worth remembering:

1. The single position-measuring case drives `generateAsksForBatch`, which
   reaches `persistChildRender` and `settleBudgetStop` only. The other two are
   separate exported entry points.
2. **The column-equality titles cannot substitute, structurally.** When the clock
   moves, `rendered_at` and `occurred_at` move TOGETHER, so their equality stays
   true. The branch's most-repeated assertion is incapable of catching the
   branch's own central regression.

**Verdict: ACCEPT. Fixed and re-proved.** Two titles added, driving the two
uncovered writers directly on the existing `holdBatchAdvisoryLock` precedent.
The mutation was re-planted for each: clean 21/21 → move `regenerateAsk`'s read
after the lock → RED, exactly one failure, the new title, ~303 ms over bound,
**with the other 20 including every column-equality title still green** —
reproducing the original blindness exactly → restored → 21/21. Same for
`settleGenerationExhaustion`.

No production change: `ask-generation.ts` is byte-identical to HEAD. The clock
positions were always right; only the eval could not tell.

**Tuning detail kept because it is not obvious:** the discriminator binds to the
MIDPOINT of the lock hold, not its end. At the end bound both mutations failed by
~4 ms — real, but too thin for a loaded runner.

## SC-1 — LOW — `release.ts`'s ordering rests on a convention, not on the query

**Claim.** `selectRenderedOutreach` orders on `rendered_at ASC` with no tiebreak.
This change makes shared instants a real shape in the table, so the ordering's
correctness now depends on the unenforced fact that only `withheld` rows tie.
`, o.id` would make it structural.

**Verdict: ACCEPT the analysis. DEFER the fix, deliberately.**

Two reasons, and the second decides it:

1. It costs this branch its second surface amendment — an abort criterion — for
   a LOW finding.
2. **Red team verified the hazard is unreachable, independently and by tracing
   the code**: it followed `renderFailedOutcome → toInsertInput` and confirmed
   every shared-instant row is `withheld`, which the query's own
   `delivery_status = 'rendered'` filter excludes. The defect is latent, not
   live.

Carried to the follow-up as one line of SQL. **The standing consequence is
recorded in D1's verdict**: a future writer that gives several `rendered` rows
one instant breaks that ordering silently, and the protection is the filter, not
the clock.

## RT-2 — P2 — two guard-deletion mutants die by mock exhaustion, not by assertion

**Claim.** M5/M6 go red through mock-SQL FIFO exhaustion rather than the
assertion under test.

**Verdict: ACCEPT as recorded, no action.** Red team itself established the
property is not hollow: M7/M10 kill the same property ON the assertion. This is a
coarse regression pin sitting beside a sharp one, which is acceptable; rewriting
it would buy precision the sharp case already provides.

## RT-3 — P2 — the matrix test pairs the Nth ledger call to the Nth insert positionally

**Verdict: ACCEPT as recorded, no action.** Sound today — the writes are
sequential and synchronous — and red team said so. The coupling is implicit
rather than wrong. Noted here so that whoever makes those writes concurrent finds
this line first.

---

## Standards findings touching this branch

**S-A — MEDIUM — `outreach_withheld` is written by two branches keyed on the same
subject.** #1010's dispatch lane and this branch's render lane both write
`refusal_source = 'outreach_withheld'` on `solicitation_outreach.id`, and the
partial unique index is `(refusal_source, subject_id)`. If one outreach were ever
withheld at both render and dispatch, `ON CONFLICT DO NOTHING` would drop the
second **silently**.

**Verdict: ACCEPT the finding, no code change, and record it loudly.** It cannot
happen today: a render-withheld row carries `delivery_status = 'withheld'` and
the dispatch lane only handles `queued`. But the protection is a status filter
one layer away, **neither call site names the other**, and this is the finding
that justified reviewing the three branches together — three isolated reviewers
each saw a correct branch. Carried to the follow-up as a cross-reference comment
at both sites.

**S-B — LOW — `persistChildRender` now takes eight positional parameters with the
decision clock trailing.** **Verdict: ACCEPT, DEFER.** The weakest place to keep
the field this lane most depends on. The fix is an options object, which is a
signature change touching every caller — worth doing, not worth a second
amendment inside a review round.
