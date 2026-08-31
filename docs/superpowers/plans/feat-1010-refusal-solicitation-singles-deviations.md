# Deviations — #1010, the three solicitation single-site lanes

Everything the plan did not anticipate, recorded here rather than decided
silently. Plan: `feat-1010-refusal-solicitation-singles-plan.md`. Intake:
`.feature/intake.json`.

## D0 — RED-TEAM P1s: two gaps this branch created and did not close

Red team round 1: 21 planted / 19 killed / 1 arbiter-reclassified equivalent /
1 non-compiling. **No P0.** Every area briefed as likely hollow measured real —
the single-statement claim dies to a loop at both the helper and the call site;
all three clock swaps die on comparisons computed inside PostgreSQL (the ask swap
failed by 9 ms, which a JS-`Date` comparison would have missed); the second
`ON CONFLICT` spelling dies to a source-text comparison against both its sibling
and migration 116; all five null-mapped reasons die by runtime ABSENCE rather
than by map assertion; every early-return guard removal died; the halt write's
position died.

Three P1s. Two are fixed here; the third is the `vocabulary.ts` header (D3),
which no swarm branch can reach.

### P1-A — the dispatch write's LAST position was unpinned

Moving `writeRefusalEvent` to the TOP of `commitWithhold` left all 33 dispatch
integration cases green, which makes the lane's rollback case vacuous under any
reorder. **The halt lane pins the identical claim and its mutant dies** — so the
branch proved the property for one lane and assumed it for another.

**Fix:** `a dispatch withhold writes its refusal_events row after the outreach
terminal, the child run and the receipt step`. It pins receiver identity (one
transaction, the ledger statement on it), the full five-write order, and
`ledgerIndex === queries.length - 1`.

**Re-proved by re-planting:** with the write hoisted,
`expected 14 to be greater than 23`; restored, 34/34. `dispatch.ts` is
byte-identical to HEAD (`git hash-object` matches `HEAD:…`).

**Cost recorded:** a third copy of the `recordingExecutor` Proxy, because the
shared helper directory is off-surface. Noted in its docblock; the right home is
`src/lib/shared/__tests__/helpers/`, which a later slice should claim.

### P1-B — a SYSTEM halt ledger failure reached no alert path

`latchSystemHalt` runs only under `SolicitationReleasePoller`. That poller is not
a BullMQ worker, so `attachJobFailureSink` never sees it, and
`runSolicitationReleaseCycle` had no catch of its own — the shared
`createGuardedPoll` harness catches and calls `logger.error` alone.

**This branch CREATED the gap.** Before it, no ledger failure could occur on that
path; `batch_halted` now writes on the `platform_halt` and `send_window_elapsed`
arms. A failed system halt would have left a batch un-halted with only a log line.

**Fix,** on the #1009 `AutonomyGovernorScheduler` precedent exactly:
`runSolicitationReleaseCycle` catches, calls `Sentry.captureException` with
`tags: { subsystem: 'solicitation_release' }`, wraps that capture in its own
`try {} catch {}` so reporting a failure can never escalate it, and **rethrows**
so the harness still writes the durable line and still releases its single-flight
flag. `guarded-poll.ts` is untouched — its catch is shared by every poller and
widening it is a different change.

**Mutant check:** reverting to the old three-line body makes the new case fail
(`captureException` called 0 times); restored, 9/9.

**Cost recorded:** surface amendment 2 of 2, owner-approved. This branch has none
left.

**Verdict:** ACCEPT both — each gap re-proved closed by re-planting its mutation.

## D6 — the reclassify trigger fired again, and the estimate was corrected again

The P1 fixes added ~160 test lines, taking the branch to 2,346 against an
`estimated_test_lines` of 1,150 — past the 2× trigger.

**Resolution:** the estimate is set to the MEASURED 2,346, exactly as the
prerequisite branch did. Recorded here so the correction cannot read as tuning a
number to silence a gate. The production bucket is unchanged and well inside its
estimate; only the test bucket moved, which is the direction that costs nothing.

**Verdict:** ACCEPT — no lane change. The branch was already `standard`/`high`,
and 2,346 test lines against 240 production lines is the shape a slice with five
live-DB suites and three lanes should have.

## D1 — three titles are one `it` PER LANE, not one `it` total

**Titles affected:** `every solicitation refusal reason writes its verbatim code
and mapped category, and every null-mapped reason writes nothing` ·
`every refusal_events row these three lanes write carries the account and
location already in the lane's scope` · `all three lanes complete their
decisions unchanged when REFUSAL_LEDGER_ENABLED is false`.

Each is written THREE times — once in `batch-builder.integration.test.ts`, once
in `dispatch.integration.test.ts`, once in `approval.integration.test.ts` —
each instance covering its own lane and saying so in a comment.

**Why.** No single suite can drive all three lanes: the ask lane needs the
contact/consent/suppression/visit chain, the dispatch lane needs the
render/token/moderation chain plus a `queued` Outreach row, and the halt lane
needs an approved batch with cancellable rows and an admin `users` row. A new
shared fixture file is not available — `allowed_edit_surface` is a closed list
and `src/lib/shared/__tests__/helpers/` is outside it.

**Why this is not the plan being overridden.** §1's tracer-to-title mapping
already says the exhaustive-reason title "spans **T3, T4 and T5** and closes
with them", which a single instance in one suite could not do. The same
reasoning carries to the other two cross-lane titles, whose wording ("these
three lanes", "all three lanes") is a claim no one suite can settle.

**The risk, stated.** A reader who opens one instance sees a case whose title
claims more than that case proves. Each instance therefore opens with a comment
naming which lane it owns and pointing at its two siblings. The alternative —
one instance covering one lane and silently claiming all three — is the
over-claim these titles exist to prevent.

**Verdict:** ACCEPT. The constraint is real and was checked rather than assumed:
the three lanes need three incompatible fixture chains, and a shared helper
directory is outside a closed edit surface. Of the two ways to be wrong here —
one case silently claiming three lanes, or three cases each honestly owning one —
this took the second, and the per-instance comments are what make it honest
rather than merely repeated.

**Cleaner shape, recorded for #1013 rather than imposed now:** three
lane-specific TITLES would have carried the same coverage without a title that
over-claims in isolation. That is a `tests_to_add` change, so it belonged at
intake time and the plan's own tracer mapping already anticipated the span.
Whoever writes #1013's cross-lane titles should prefer per-lane wording.

## D2 — `already_reviewed` is unreachable through `buildSolicitationBatch`

The ask lane's exhaustive-reason case drives five of the six `WITHHOLD_REASONS`.
The sixth, `already_reviewed`, cannot fire: `toCandidate`
(`src/lib/solicitation/batch-builder.ts`) hard-codes `matchedReview: null`, so
`evaluateAsk`'s third gate has no input that can make it true. The gate is live
code with no producer.

**What the case does instead:** it pins the map entry
(`ASK_WITHHELD_REFUSAL_CATEGORIES.already_reviewed === 'wrong_moment'`) and
asserts that the six reasons it accounts for are the WHOLE of
`WITHHOLD_REASONS`, so a seventh reason added upstream fails there rather than
going unrecorded. Nothing pretends to drive it.

Out of scope to fix here: giving `already_reviewed` a producer is a change to
which candidates a batch withholds, which the intake names as a non-goal.

**Verdict:** ACCEPT, and the restraint is right — driving it would have meant
changing which candidates a batch withholds, which the intake forbids by name.
The substitute is the correct one: pinning the map entry plus asserting the six
accounted-for reasons are the WHOLE of `WITHHOLD_REASONS` means a seventh reason
fails here rather than going unrecorded, which is what the title is actually for.

**Escalated, because it is bigger than this slice.** `evaluateAsk`'s
`already_reviewed` gate is live code with no producer: `toCandidate` hard-codes
`matchedReview: null`. That is either a gate that should be deleted or a producer
that was never wired, and neither is a Refusal-ledger question. Raised to the
owner in this run's final report rather than buried here; #1010 correctly did not
decide it.

## D3 — a stale sentence in `vocabulary.ts`, which this branch may not edit

`src/lib/refusals/vocabulary.ts`'s header says "for as long as this file is
ahead of them, five exported constants have no production caller". After this
branch, three of the five have one — `ASK_WITHHELD_REFUSAL_CATEGORIES`,
`OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES` and
`BATCH_HALTED_REFUSAL_CATEGORIES`. The remaining two
(`OUTREACH_WITHHELD_RENDER_…` and `AUTO_POST_REVOKED_…`) are #1011's and
#1012's.

`vocabulary.ts` is outside `allowed_edit_surface` and the orchestrator's brief
says explicitly not to edit it, so the sentence is left as it stands and
recorded here. Whichever of #1011/#1012 lands last should correct it — by then
the sentence is false for every one of the five.

**Verdict:** ACCEPT the restraint, CORRECT the handoff. Not editing a file the
brief and the surface both exclude is exactly right, and finding the staleness at
all is the discipline this repo's own retrospective asks for.

**But the proposed handoff does not work, and the orchestrator owns that, not
this branch.** `src/lib/refusals/vocabulary.ts` is outside the edit surface of
ALL THREE swarm branches — #1011's and #1012's intakes exclude it for the same
reason #1010's does, because keeping the three surfaces disjoint is the whole
premise of running them in parallel. So "whichever lands last" can no more fix it
than this branch can. It is carried as an owed follow-up on the orchestrator, to
land after all three merge, and it is named in the final report so it cannot
vanish with this file.

## D4 — one test-file cleanup fix outside this slice's own cases

`batch-builder.integration.test.ts`'s pre-existing case *"tenant scope: a
consent row at business A does not make the same handle eligible at business B
in the same account"* seeds a SECOND location and deletes it in its own
`finally`, before the suite-wide `afterEach` runs. Since the ask lane now writes
a `refusal_events` row for that build's `no_consent` withhold, and
`refusal_events.business_id` is a NO-ACTION foreign key, that inline delete
started failing with `refusal_events_business_id_fkey`.

Fixed inside that case's `finally` (one `DELETE FROM refusal_events WHERE
business_id = …` before the location delete), with a comment saying why the
account-scoped `afterEach` cannot cover it. No behaviour change; the case's
assertions are untouched.

**Verdict:** ACCEPT. This is the FK doing its job — #1001 chose a bare `uuid`
subject with no referential action precisely so no other table's clock can delete
a Refusal, but `business_id` IS a real FK, so a test that deletes a location out
from under a Refusal now has to say so. The fix is in the case's own `finally`,
touches no assertion, and carries the reason. Anything wider — loosening the FK,
or moving the cleanup to `afterEach` — would be changing production or shared
scaffolding to suit one fixture.

## D5 — `latchHalt`'s step list gained a step "3b" rather than being renumbered

The plan says the halt write goes after step 3 and before step 4. The docstring
enumerates five numbered steps and other comments and tests refer to those
numbers ("the audit write sits BEFORE the spine calls"), so the new step is
documented as **3b** rather than renumbering 4 and 5. Purely a documentation
choice; the execution order is exactly what §5 specifies.

**Verdict:** ACCEPT, and it is the right call for a reason worth stating: those
step numbers are referenced from OTHER comments and tests, so renumbering would
have silently falsified every one of them. `3b` keeps the existing references
true and puts the new step where the plan requires — after the audit row, before
the spine call. That preserves both `latchHalt`'s ordered contract and the
advisory-lock → batch-row → `agent_runs` lock order its header describes.
