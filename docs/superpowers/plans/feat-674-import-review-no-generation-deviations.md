# Deviations — feat-674-import-review-no-generation

Entries are things the plan did not anticipate. Each gets a triage verdict at
step 6 (ACCEPT / RE-PLAN) before review agents see this file.

## Step 6 triage — 2026-08-05

**All fifteen: ACCEPT. Zero RE-PLAN.** The gate is GREEN at `7c4f343f` with all
23 checks passing, including `promised-tests` (every one of the twelve
`tests_to_add` titles exists) and the live-DB suite actually executing.

RE-PLAN means a deviation invalidated the plan. None did, and the distribution is
the reason to believe that rather than a reason to distrust the sweep:

- **D1, D2, D3, D5, D6, D7, D9, D10** are plan-review findings — discovered in
  the phase whose entire job is to find them, and all resolved *before* any code
  existed. That is the process working, not drift.
- **D4** is a real defect deliberately left unfixed by owner decision, with a
  named owner (#675) and a ship-time action. Accepting it accepts a documented
  hazard, not an unknown one.
- **D8** is the one that flirted with teardown (2nd surface amendment). It was
  surfaced to the owner rather than waived, and the budget it exhausted was
  **never spent again**: implementation required no third `allowed_edit_surface`
  change, so the abort trigger it armed never fired.
- **D11** was closed by the owner's call substituting for `APPROVED`, which is
  exactly what the protocol prescribes when rounds are exhausted.
- **D12** is external drift (`main` took the spec), resolved by rebase.
- **D13, D14, D15** are the implementation-phase entries, and all three are
  *plan-text* defects rather than design defects — a describe block the plan
  did not name, two destructure bindings it did not account for, and two
  verification steps that were wrong about their own tools. None changed the
  shipped design; each is corrected in place so a re-run does not inherit it.

The honest summary: the shipped artefact matches the locked intake, and every
deviation was either absorbed without design change or is a documented,
owner-approved deferral.

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

**SUPERSEDED 2026-08-05 by #681 — see D12.** `main` now owns the spec file, so
this branch no longer carries a copy of it. The amendment itself stands (the
path stays in `allowed_edit_surface`, harmlessly); only its *premise* — that the
document existed nowhere in git — has expired.

**Verdict:** ACCEPT

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

**Verdict:** ACCEPT

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

**Verdict:** ACCEPT

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

**Verdict:** ACCEPT

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

**Verdict:** ACCEPT

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

**Verdict:** ACCEPT

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

**Verdict:** ACCEPT

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

**Verdict:** ACCEPT

---

## D10 — Round 3: the live-DB suite had the exact defect it was added to catch

**When:** plan review round 3 (final), same codex session.

**What:** Task 4's suite — added in D7 precisely because nothing else executes
`importReview`'s SQL — itself referenced `agent_run_steps.run_id`. The real
column is **`agent_run_id`** (migration `071_agent_run_spine.sql`; writer at
`src/lib/agents/run-spine.ts:304`). Verified independently before accepting.
The suite would have failed to run at all, and the `afterAll` cleanup would have
thrown on the same error before deleting anything else. `run_id` is the name the
run-spine writers use for the local *variable*, which is what makes it an easy
slip — and is itself an argument for the suite existing.

Three smaller round-3 findings, all accepted:

1. The suite claimed to prove every binding landed correctly but never asserted
   `sentiment_score`. A score binding that landed in the wrong column would have
   passed. Now asserts `Number(sentiment_score) === -0.5` for the 2-star fixture
   (`classifySentiment(2)` → `(2-3)/2`), with a note that postgres.js returns
   NUMERIC as a string.
2. Task 4's own `pnpm ci:live-db-suites` step was **vacuous**:
   `scripts/ci/live-db-suites-audit.ts` enumerates via `git ls-files` and cannot
   see an untracked file, so the check would have passed without inspecting the
   new suite. The step now stages the file first and requires the suite to
   appear in the output.
3. The `as MonitoredReview` cast on the fixture was unnecessary and would
   suppress future excess-property/structural checking. Removed.

**Lesson worth promoting at step 8:** plan-embedded code is not reviewed by the
gate and not executed by anything until a subagent runs it. Schema identifiers in
a plan deserve the same "look it up, don't guess" discipline as production code —
all four of these were verifiable with one `rg` against the migration.

**Verdict:** ACCEPT

---

## D11 — Plan review rounds exhausted without APPROVED

Three rounds used (`REVISE`, `REVISE`, `REVISE`). The step 3 protocol forbids a
round 4: "After round 3: STOP. Surface the remaining disagreement to me with both
positions — my call substitutes for APPROVED."

There is, however, **no disagreement to surface**. Every round-3 finding was a
verified factual defect with no counter-position, and all four are fixed above.
Round 3 also positively confirmed the two items it was asked to re-check: the
one-transaction test now passes a correct implementation (and all eight
`mockInsertWon()` calls were audited individually for the same defect class), and
the Provenance-of-decisions table is accurate row by row.

What is genuinely outstanding is that the fixes to a `REVISE` verdict have not
themselves been reviewed, and the protocol provides no further round in which to
review them. Recorded for the owner's call rather than self-certified as
APPROVED.

**Verdict:** ACCEPT

---

## D6 — Cited-symbol correction

`ZernioBackfillWorker.processUnansweredReview` is not a module-level export — it
is a closure inside `handleZernioBackfill`
(`worker/jobs/zernio/ZernioBackfillWorker.ts:210-246`). The intake's PHI-screening
precedent reference was reworded accordingly.

**Verdict:** ACCEPT

---

## D12 — `main` took ownership of the spec while this branch was parked

**When:** resume, before Task 1 (2026-08-05).

**What:** #681 (`6bd45cfe`) landed
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md` on `main`,
the same file D1 committed here because it existed nowhere in git. The two copies
had diverged: this branch carried 280 lines, `main` carries 303 — a strict
superset adding **§8a Rollout posture** (ADR 0015: no feature flag, ordering
replaces it, no existing-rows clause, backout is `git revert` with migration 100
additive-only) and reworking the counter-collapse paragraph at spec lines 133-137.

**Resolution:** owner decision (2026-08-05) — rebased the seven docs commits onto
`origin/main`, resolving the add/add conflict by taking `main`'s version verbatim
and dropping this branch's copy. The branch's diff against `main` no longer
contains the spec at all.

**Why nothing else moved:**

- **§8a does not change #674's scope.** R1 (no feature flag) is already an intake
  non-goal; R4's migration 100 belongs to #675. Nothing in §8a touches
  `importReview`'s contract, its lock policy, or its run-spine completion.
- **No citation drift.** The plan cites the spec **by section** (§6.2), never by
  line number, so the +3 line shift is inert. The round-3 review report does carry
  line numbers, but it is a historical artefact of a review already answered and
  is deliberately left as written.
- **Not an amendment.** No `allowed_edit_surface` change — the spec path stays
  listed and is simply no longer edited. The budget remains exhausted at 2 of 2
  per D8; this does not spend a third.

D1's premise is marked superseded above; the plan header now cites `main` as the
spec's owner.

**Verdict:** ACCEPT

---

## D13 — Task 1: the test file has a THIRD block the plan did not name

**When:** Task 1 execution (2026-08-05).

**What:** Task 1 step 3 says to append the new block "after the existing
`describe('processReview', …)` closes". That is not the end of the file:
`src/lib/reviews/__tests__/process-review.test.ts` also carries
`describe('generate_response producer static guard')` after it. The new
`describe('importReview')` block was appended at the true end of file, which
satisfies both readings and leaves the guard untouched.

**Why it matters to Task 2, not Task 1.** That guard is a static assertion over
the *source text* of `src/lib/reviews/process-review.ts`: it requires the file to
contain `enqueueGenerateResponse` and to NOT contain a raw
``tx`INSERT INTO job_outbox … 'generate_response'` ``. Task 2 adds `importReview`
and extracts `insertNewReviewRow` in that same file, so it must keep **both**
halves true. The guard is a pre-existing invariant, is not part of this ticket's
eight new tests, and would be an easy casualty of the extraction.

**Resolution:** no plan change needed — the append point is unambiguous in
practice. Recorded so Task 2's implementer treats the guard as a constraint
rather than discovering it as a surprise failure. (Task 2 confirmed the guard
still passes after the extraction.)

Task 1's red was verified independently of the subagent's report: 8 failed /
29 passed (37 total), every failure `TypeError: importReview is not a function`,
and the commit (`d100970e`) touches exactly one file whose only deletions are the
two extended import lines — so the `describe('processReview')` block is
mechanically confirmed byte-for-byte untouched.

**Verdict:** ACCEPT

---

## D14 — Task 2: the extraction orphaned two destructure bindings

**When:** Task 2 execution (2026-08-05).

**What:** Task 2 step 3 replaces `processReview`'s lines 63-84 — the inline
`INSERT` and its `const sentiment = classifySentiment(…)` — with a call to
`insertNewReviewRow`. It never mentions **line 45**, where `processReview`
destructures `const { review, identity, contentHash } = monitored;`. Removing the
inline INSERT was the last consumer of `review` and `contentHash` in that scope,
so the extraction left two unused bindings and `pnpm lint` failed:

```
45:11  error  'review' is assigned a value but never used.
45:29  error  'contentHash' is assigned a value but never used.
```

**Resolution:** narrowed the destructure to `const { identity } = monitored;`
with a comment recording that `review`/`contentHash` are now consumed by
`insertNewReviewRow` and `processExistingReview`, both of which take `monitored`
whole. No statement was moved and no `tx` call was added or reordered, so the
positional-mock premise of the existing tests is intact — re-verified green
after the change.

**Why this is a fix and not a behaviour change:** narrowing a destructure cannot
alter runtime behaviour when the dropped bindings have no remaining readers, and
`tsc --noEmit` passing is the proof that they have none — an unresolved
identifier is a type error, not a silent read.

**Lesson (candidate for step 8):** a plan that moves a statement out of a scope
should name every binding that statement was the last reader of. The plan's
"replace lines X-Y" framing is precise about what leaves and silent about what
that leaves behind; lint caught it, but only because the orphans were
`const` declarations rather than, say, a now-dead import.

**Verdict:** ACCEPT

---

## D15 — Task 4: both of its verification steps were wrong about their own tools

**When:** Task 4 execution (2026-08-05). The suite itself was correct — every
round-3 fix held up against the real database. What was wrong was the plan's
instructions for *checking* it.

**1. Step 3 skips as written.** `pnpm vitest run <path>` does not see
`TEST_DATABASE_POOL_URL`: nothing in `vitest.setup.ts` hydrates `.env.local`, and
the suite follows `read.integration.test.ts` in reading `process.env` directly
rather than `resolveTestDatabaseUrl()` (which does have a disk fallback). Run
verbatim, step 3 yields `4 skipped` — which the plan itself defines as a FAILURE
of the task. Confirmed not to be a defect in the new file: the precedent suite
`src/lib/agents/__tests__/read.integration.test.ts` skips identically when run
the same way.

**This does NOT compromise the gate**, which is the part that matters.
`scripts/verify-gate.sh:73-78` resolves the URL from the environment first and
falls back to reading `.env.local`, then exports it before running any
`verification_commands` — the comment at line 73 says so explicitly ("so changed
integration suites never SKIP"). So the intake's single verification command
executes for real. The defect is confined to a human following step 3 by hand.

**2. Step 4's success criterion is unsatisfiable.** It requires
`pnpm ci:live-db-suites` output to "actually mention the new suite", as the
non-vacuousness proof that round 3 asked for. But
`scripts/ci/live-db-suites-audit.ts` prints filenames **only** in its
`findings.length > 0` failure branch; a pass prints exactly one summary line.
Absence of the filename is therefore not evidence of a no-op, and no passing run
can ever satisfy the stated criterion.

The underlying concern — that the audit enumerates via `git ls-files` and is
blind to an untracked file — is real, and staging first (which round 3 added) is
the correct fix. Only the *evidence* the plan asked for was impossible. Task 4
proved enumeration positively instead: `git ls-files` lists the new suite, and
invoking the audit's own exported `listTestFiles`/`auditLiveDbSuite` shows the
file is enumerated, is recognised as a live-DB suite via its
`TEST_DATABASE_POOL_URL` + `helpers/describe-with-db` markers (so it clears the
early return and rule R1 is genuinely evaluated), and returns zero findings.

**Resolution:** no code change. Both are plan-text defects with no effect on the
shipped artefact. Corrected in the plan so a re-run does not inherit them:
step 3 now carries the export, step 4 now expects the summary line plus a
`git ls-files` confirmation.

**Lesson (candidate for step 8):** "the output must mention X" is only a
non-vacuousness proof if the tool actually prints X on success. Round 3 correctly
identified a vacuous check and prescribed a remedy whose evidence the tool cannot
emit — the fix was right, its receipt was not.

**Verdict:** ACCEPT
