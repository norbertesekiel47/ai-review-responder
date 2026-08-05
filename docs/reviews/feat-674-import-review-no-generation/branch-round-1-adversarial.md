# Adversarial Approach Review — branch round 1 (#674)

**Agent:** Codex (`codex:adversarial-review`), thread `019fd189-c3eb-7c33-85db-a410926a4a63`
**Target:** branch diff against `6bd45cfe`
**Verdict:** `needs-attention`
**Axis:** approach, design choices, assumptions — not line-level defects.

> Codex ran in a read-only sandbox and could not write this file itself; its
> output is transcribed here verbatim, with the orchestrator's verification
> appended below each finding.

## Codex summary

> Do not ship this as #675's keystone yet. Import can consume the live lane's
> drafting obligation under ordinary sequential ordering, then falsely mark the
> review handler completed.

---

## Finding 1 [high] — Import can permanently suppress live drafting without a concurrent race

`src/lib/reviews/process-review.ts:519-525`

> `importReview` inserts the canonical review but records no durable generation
> obligation. If import runs before the normal poll/webhook lane, the later
> `processReview` call finds the row and its matching content hash, returns
> `unchanged`, and never enqueues `generate_response`. This is broader than
> deviation D4's concurrent INSERT race: the spec deliberately includes reviews
> arriving between subscription and connection in the newest-100 import while
> promising that new reviews remain automatically handled. Such reviews can
> therefore remain undrafted indefinitely unless their content changes.
>
> **Recommendation:** Persist explicit import/live provenance or a
> generation-required claim, then make the live lane atomically ensure eligible
> post-activation reviews have either a response or in-flight generation. Add
> integration tests for import-before-live, live-before-import, and concurrent
> ordering.

### Orchestrator verification — CONFIRMED

Traced against the actual code, not accepted on assertion:

1. `processReview` takes `SELECT … FOR UPDATE`, finds the imported row, and
   delegates to `processExistingReview` (`process-review.ts:114`, `:125`).
2. `processExistingReview:266` — `if (existingHash === contentHash)` and status
   is not `DELETED` → `return 'unchanged'`, with **no** `enqueueGenerateResponse`
   on that path.
3. The backfill lane is not a rescue: `ZernioBackfillWorker.processUnansweredReview`
   calls the same `processReview` (`ZernioBackfillWorker.ts:237`), so it lands on
   the identical hash-match skip.

**No concurrency is required.** The general property is: *the live lane drafts
only on insert or on content change, so any review `importReview` has already
stored will never be drafted* — short of the reviewer later editing their text.
D4's concurrent INSERT race is merely the simultaneous instance of this; the
sequential case is the **common** one, not the exotic one.

### Triage: ACCEPT as a characterization defect · REJECT as a code change for #674

- **No code change here.** `importReview` is correct against its locked contract
  ("insert and stop, never mutate an existing row"), ships with zero callers, and
  the intake explicitly non-goals the fix, assigning it to #675 which owns *when*
  the import runs. Fixing it means editing `processReview`'s existing-row branch —
  the behaviour change this ticket forbids. Nothing defective ships.
- **The documentation is wrong and that matters a great deal.** D4, the plan's
  Hazards section, and the `importReview` JSDoc all describe this as a *race*. A
  #675 implementer reading that would add a narrow concurrency guard and still
  ship systematically undrafted reviews. The deferral is only defensible if the
  thing being deferred is described accurately.

**Action:** correct the hazard's scope in D4, the plan's Hazards section, and the
JSDoc; carry the corrected statement into the #675 comment at ship time. Escalated
to the owner, because the deferral decision was made against the narrow framing.

---

## Finding 2 [medium] — Import completion misrepresents unhandled inventory as a completed review handler

`src/lib/reviews/process-review.ts:527-535`

> The import creates a `review_handler` run containing only `review_ingested` and
> immediately completes it. The timeline maps terminal status directly to
> `completed`, despite no triage, draft, moderation, notification, post, or
> outcome. This also suppresses the `stalled` signal for the lost-draft scenario
> above, leaving a review with no response while the operational spine positively
> reports success. A later owner-generated response must open another run,
> fragmenting the audit trail.
>
> **Recommendation:** Represent import explicitly through the import batch record
> or a distinct run kind/state/marker rendered as *inventory imported*. Otherwise
> defer creating the `review_handler` run until actual handling begins.

### Orchestrator verification — the tension is real; the recommended fix is out of scope

This is a direct counter-argument to deviation **D3**, which completed the run
precisely to stop imported reviews reading as `stalled` after 48h
(`deriveRunDisplayState`, `src/lib/agents/read.ts:127`). Codex's point is that D3
traded a false-negative signal for a false-positive one — and that the trade is
worse than it looked, because finding 1 means the very reviews being reported as
`completed` are the ones that will never be handled.

Both cannot be satisfied with the current run vocabulary:

| Option | Cost |
|---|---|
| Leave the run `running` (pre-D3) | 100-review import shows 100 `stalled` runs after 48h |
| Complete it (shipped) | a never-drafted review reports `completed` |
| Distinct run kind / outcome | needs a new `AGENT_RUN_KINDS` (or `AGENT_OUTCOME_KINDS`) member ⇒ **a migration**, explicitly out of scope for this ticket and the stated reason D3 rejected `recordOutcome` |
| Create no run at all | loses import attribution entirely from the spine |

The intake's `observability` section already leans on the shipped signature — *"a
completed `review_handler` run carrying a `review_ingested` step, with no
`responses` row, is the signature of an imported review"* — so the fact is
derivable today, just not legible at a glance in the timeline.

**Triage:** escalated to the owner alongside finding 1. Not silently accepted:
the shipped behaviour is defensible only while finding 1's lost-draft gap is
understood and owned by #675, since the two compound.

---

## Notes

- Codex's `codebase-memory-mcp` calls failed (`search_graph`, `list_projects`);
  it fell back to direct `rg`/`git` inspection, which is what produced both
  findings. No coverage was lost.
- Codex raised **no** objection to the other three approach decisions it was
  asked to attack: the separate `importReview` entry point over a
  `skipGeneration` flag, the no-`FOR UPDATE`-probe lock policy, and the private
  `insertNewReviewRow` seam with its behaviour-neutrality claim.
