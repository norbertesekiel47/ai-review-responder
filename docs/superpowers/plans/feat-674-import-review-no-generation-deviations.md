# Deviations — feat-674-import-review-no-generation

Entries are things the plan did not anticipate. Each gets a triage verdict at
step 6 (ACCEPT / RE-PLAN) before review agents see this file.

---

## D1 — `allowed_edit_surface` AMENDMENT #1: the design of record was untracked

**When:** plan review round 1 (codex, session `019fd129-092f-7e93-8409-854489caac01`).

**What:** The plan and intake both cite
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md` as the
binding design of record, and map #667 links to it at `../blob/main/…`. The file
does not exist on `main`, in this worktree, or anywhere in git — it was untracked
in the parent working tree only. An older, materially narrower version exists on
the unrelated local branch `docs/668-consented-import-rollout-posture` @
`bcde4da9`; that version does not describe `importReview`, the run spine, the
analytics event, or the lock policy this ticket implements.

**Resolution:** owner-approved surface amendment (2026-08-05). Added
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md` to
`allowed_edit_surface` in BOTH intake copies and committed the current version of
the spec on this branch, so the keystone does not merge citing a document absent
from the repo.

**Amendment budget:** this is amendment **1 of 2**. A second amendment of
`allowed_edit_surface` triggers the step 5 abort criteria.

**Verdict:** _(pending step 6)_

---

## D2 — Intake field corrections (not amendments)

Owner-approved corrections to non-surface intake fields, recorded here rather
than counted against the amendment budget.

1. **`db_touching`: `false` → `true`.** Not because a migration was added — there
   is none — but so the gate provisions the test DB for
   `worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts`, added to
   `verification_commands`. That suite exercises the INSERT this ticket
   refactors, and running it is real evidence rather than an assumption.
2. **`tests_to_add` retitles.** Dropped *"importReview skips the run-spine write
   when the business row is missing"* — it asserted a state Postgres cannot
   produce (`reviews.business_id` is a non-null FK, so a successful review INSERT
   proves the business row exists). Testing a defensive branch around an
   impossible state is exactly what the anti-slop rule forbids;
   `startReviewRun`'s existing defensive skip is inherited, not newly asserted.
   Added in its place:
   - *"importReview binds the review INSERT parameters in the canonical order"*
   - *"importReview does all of its work in exactly one transaction"*
   And retitled *"…records the review_ingested run-spine step"* →
   *"…records the review_ingested run-spine step and completes the run"* (see D3).
3. **Estimates raised** 80→95 prod / 240→280 test lines to cover the run
   completion and the two added tests.

**Verdict:** _(pending step 6)_

---

## D3 — Imported reviews would have shown as `stalled` runs

**When:** plan review round 1.

**What:** The locked intake said the import writes a run-spine row "same as live
ingest" — i.e. `startOrGetActiveRun` + `recordStep('review_ingested')`, left
`running`. `deriveRunDisplayState` (`src/lib/agents/read.ts:119-131`) marks any
`review_handler` run still `running` after 48h as `stalled`. The live lane never
trips this because its review has a response in
`OWNER_WAITING_RESPONSE_STATUSES`, which short-circuits to `waiting_on_owner`
first. An imported review has **no response by design**, so it falls through to
the 48h check: a 100-review import would produce 100 runs that all read `stalled`
two days later, and a later live update would join the still-open run via
`startOrGetActiveRun`.

**Resolution:** owner decision (2026-08-05) — `importReview` completes its own
run in the same transaction: `startOrGetActiveRun` → `recordStep` →
`completeRun(tx, runId, 'completed')`. The import's work genuinely is finished
when the row lands, so the run is honestly terminal, and #678's on-demand
Generate opens a fresh `review_handler` run per owner action instead of joining a
stale one. No `recordOutcome` — that would need a new `AGENT_OUTCOME_KINDS`
member and therefore a migration, which is out of scope.

**Verdict:** _(pending step 6)_

---

## D4 — HAZARD (deliberately not fixed here): cross-lane lost draft

**When:** plan review round 1.

**What:** If `importReview` wins the identity race against a concurrent
live-ingest `processReview` for the same review:

```
importReview   : INSERT … ON CONFLICT DO NOTHING  → wins, no generate_response
processReview  : SELECT FOR UPDATE                → no row (import not yet committed)
                 INSERT … ON CONFLICT DO NOTHING  → 0 rows (import committed)
                 re-read winner FOR UPDATE        → import's row
                 processExistingReview            → hash matches → 'unchanged'
                                                  → NO generate_response enqueued
```

That review is stored and **never drafted**, which breaks the live lane's promise
(and the import prompt's mandatory reassurance that "new reviews will still be
handled automatically"). The pattern is safe today only because every winner of
that race enqueues; `importReview` is the first winner that does not.

**Why not fixed here:** the fix lives in `processReview`'s race-loss branch —
detect "winner has no response and no in-flight generate job, enqueue one" — in
the module's most concurrency-sensitive code, to guard a hazard that has no
caller on this branch. That is precisely the behaviour change the ticket forbids.
The race only becomes reachable when #675 wires the import, and #675 owns *when*
the import runs.

**Resolution:** owner decision (2026-08-05) — document here, in the plan's
Hazards section, and as a comment on #675 at ship time. Do **not** fix in #674.

**Verdict:** _(pending step 6)_

---

## D5 — Rejected round-1 findings

- **"`CONTEXT.md` is not a flat `- **Term**: definition` glossary."** Rejected on
  inspection: it is exactly that bullet style (`CONTEXT.md:3-14`), with later
  entries adding an `_Avoid_:` clause and a provenance parenthetical, which the
  proposed entry matches. The plan's wording was tightened to name the insertion
  point (the main bullet list, above the first `##` section) rather than implying
  the whole file is bullets.
- **"`expect(allSql).not.toContain('job_outbox')` is not a real guarantee because
  `enqueueAnalyticsEvent` is mocked."** Rejected: `enqueueAnalyticsEvent` writes
  `analytics_events`, not `job_outbox` (`src/lib/analytics/enqueue.ts:30`), so
  mocking it hides nothing from that assertion. `enqueueGenerateResponse` — the
  only helper that would write a `job_outbox` row here — is deliberately **not**
  mocked in this suite, so a stray enqueue would surface.
- **"A later live update reuses the import's still-open run."** Real, but wholly
  subsumed by D3's fix: a completed run is not an active run, so
  `startOrGetActiveRun` opens a fresh one.

**Verdict:** _(pending step 6)_

---

## D7 — Round 2: the designated "verification" suite proved nothing

**When:** plan review round 2 (same codex session `019fd129-…`).

**What:** D2 added
`worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts` to
`verification_commands` and flipped `db_touching` to `true` on the claim that
the suite "exercises the INSERT this ticket refactors". **Both claims were
false.** That file's own header says it is not a real-Postgres harness; it mocks
`sql`, `sql.begin`, *and* the entire `process-review` module
(`vi.mock('…/src/lib/reviews/process-review', …)`), so its ingest assertions only
prove a mock was called. It ran green in the docs-only gate at `c0cd0ad8` and
that pass carried no information about this change.

Worse, the search it prompted found that **no** live-DB suite executes
`processReview`'s INSERT — the other `*.integration.test.ts` files that mention
`reviews` insert fixture rows directly. Since `importReview` also ships with no
callers, nothing in the repository would ever have executed its SQL: a wrong
column name or constraint violation would have passed every gate and been
inherited by #675 as a broken keystone.

**Resolution:** owner decision (2026-08-05) — add
`src/lib/reviews/__tests__/import-review.integration.test.ts` (plan Task 4), a
real `describeWithDb` suite that calls `importReview` against the provisioned
test database and asserts the row's columns, the terminal agent run, the absent
`job_outbox` row, and the `ON CONFLICT` dedup. `db_touching: true` is now honest;
`verification_commands` points at the new suite. Four test titles added to
`tests_to_add`; `estimated_test_lines` 280 → 480.

**Verdict:** _(pending step 6)_

---

## D8 — AMENDMENT #2 and the abort criteria (flagged, not silently waived)

D7's fix required adding
`src/lib/reviews/__tests__/import-review.integration.test.ts` to
`allowed_edit_surface`. That is the **second** amendment, and step 5's abort
criteria nominate a 2nd surface amendment as a teardown trigger: write a
post-mortem, destroy the branch, restart at step 1.

**Not applied here, deliberately, and surfaced to the owner rather than waived
in silence.** Reasoning:

- The criteria are written for the implement→gate loop ("stop *patching*").
  This branch has **zero implementation commits** — only docs. Nothing has been
  patched.
- Both amendments are additive *documentation and test* surfaces discovered by
  adversarial plan review, which is precisely the phase whose job is to find
  them. Neither is implementation sprawl, the drift the rule exists to catch.
- The trigger's stated remedy is "the lane was wrong — re-run step 0 in the
  heavier lane." This feature is already in the heaviest lane (RISK=high, full
  pipeline, staging ride). There is no heavier lane to escalate into.
- Restarting would re-run a grilling session whose answers are all still
  correct, and would discard two rounds of review findings that are already
  fixed. The teardown would cost the learning, not capture it.

**The amendment budget is now exhausted.** Any third `allowed_edit_surface`
change during implementation is a genuine signal and MUST trigger the abort
path — no further reasoning-around.

**Verdict:** _(pending step 6)_

---

## D9 — Round 2: rejected finding

**"Spec §6.2 is materially narrower than the plan represents."** Rejected as
stated. §6.2 is an epic-level *requirement* ("a path that inserts and stops…
sentiment classification still runs at the write site"), and §2's D2 locks
"nothing is auto-drafted" — the plan cites both accurately. The naming, the
`'new'`/`'unchanged'` contract, the no-lock policy and the run completion are
**this ticket's** design decisions, made in grilling with the owner and recorded
in the intake, not claims about what the spec says.

The kernel worth keeping: a reader could confuse the two. The plan now carries a
**"Provenance of decisions"** table naming, row by row, which decisions come from
the spec and which from this ticket.

**Verdict:** _(pending step 6)_

---

## D6 — Cited-symbol correction

`ZernioBackfillWorker.processUnansweredReview` is not a module-level export — it
is a closure inside `handleZernioBackfill`
(`worker/jobs/zernio/ZernioBackfillWorker.ts:210-246`). The intake's PHI-screening
precedent reference was reworded accordingly.

**Verdict:** _(pending step 6)_
