# fix/1105 — deviations

Every entry needs a resolved **Verdict:** ACCEPT before the `reviewed`
transition will pass.

## D1 — the sibling worktree for #1079 reports a surface overlap

`scripts/feature-setup.sh` printed two code overlaps against
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1079-ledger-kill-switch-containment`
— `worker/jobs/response-generation/persist.ts` and `src/lib/refusals/write.ts`,
which are exactly this branch's two production files.

It is not a live collision. PR #1098 (#1079) merged at 2026-09-03T11:03:31Z, so
that branch's content is already in `main` and this branch forks from it. The
worktree is a stale leftover awaiting cleanup, not parallel work. No merge order
needs agreeing.

**Verdict:** ACCEPT.

## D2 — `tests_to_add` grew from 11 titles to 18

Plan review round 1 found seven ways every one of the original eleven tests
could pass on a wrong implementation. Each finding became one new eval case, and
each new title is tagged `[R1-n]` in the plan's T1 so the reason survives.

`estimated_test_lines` moved from 150 to 260 in the same edit — 1.7×, under the
2× re-classification trigger. `estimated_prod_lines` was unchanged at 80 AT THIS
POINT; D7 below later corrects it to the measured figure, and that entry owns the
number. Do not read 80 back out of this paragraph.
`allowed_edit_surface` is unchanged, so this is a deviations entry and not a
surface amendment.

Both intake copies were updated together and verified byte-identical.

**Verdict:** ACCEPT.

## D3 — plan decision D2 was reversed after review

The plan first said to extend `resetRefusalLedgerWarningForTests` to clear the
new latch. That rested on a claim the repository contradicts: the live-DB suite
`worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts`
does not call the reset in `beforeEach`, and one of its cases calls it MID-TEST
to open a fresh disabled episode. An extended reset would have let that mid-test
boundary silently clear an unrelated process-lifetime signal.

The plan now specifies a separate `resetUnmappedBlockReasonSignalForTests`.
Verified in the working tree before acceptance, not taken on the reviewer's word.

**Verdict:** ACCEPT.

## D5 — plan decision D1 was REVERSED during T2, by a failing test

The plan put the membership test inside `noteUnmappedBlockReasons`, so guard 4's
off-arm handed it every decision and let the helper decide. Four of the five
lane cases then failed for a reason neither plan review round caught:
`persist.test.ts` MOCKS `@/lib/refusals/write`, so its spy recorded a call for a
HEALTHY set too. The count could not tell "a hole was signalled" from "a set was
handed over", and a lane-level contract had no lane-level oracle.

The membership test now lives in `unmappedBlockReasons`, a private predicate in
`worker/jobs/response-generation/persist.ts` beside `wouldRecordRefusal`.
`noteUnmappedBlockReasons` takes already-unmapped codes and is a pure transport.

Branch review round 1 later found the SAME weakness surviving in a milder form:
the one remaining mixed-set case asserted the call COUNT and never the ARGUMENT,
so passing `autoDecision.blockReasons` unfiltered survived 59/59 (red team P0).
That case now asserts the argument. The single account of this event, since four
documents previously told it two ways: four cases FAILED, and a fifth passed
while measuring nothing.

Two arguments say the reversal is an improvement rather than a concession:

1. The predicate now sits in the file whose guard 4 docblock owns the
   cannot-throw containment rule, next to the only other predicate bound by it.
2. `src/lib/refusals/write.ts` keeps no coupling to the category map at all —
   it gained no vocabulary import in the end.

Rejected alternative: keep the helper owning the test and make the lane suite
call through to the real helper. That needs a Sentry stub in a suite that has
none today, which changes the blast radius of ~55 unrelated cases to buy an
oracle the reversal gives for free.

Two promised test titles changed with it, in both intake copies:

| Was | Now |
|---|---|
| `noteUnmappedBlockReasons ignores a set whose every member is mapped` | `noteUnmappedBlockReasons signals for the codes it is given without re-testing membership` |
| `noteUnmappedBlockReasons treats an inherited object key as unmapped` | `with the ledger off, an inherited object key is treated as an unmapped block reason` |

The first changed meaning because the helper no longer classifies; the healthy-set
coverage it used to carry is now the lane case
`a fully mapped held decision warns ledger-dark and signals no vocabulary hole`.
The second MOVED file, from the helper's suite to the lane's, because the
`Object.hasOwn`-versus-`in` distinction is now the predicate's to make.

Case count was 18 AT THIS POINT; D10 below moves it and owns the number.
`allowed_edit_surface` is unchanged, so this is a deviations entry and not a
surface amendment.

**Verdict:** ACCEPT.

## D6 — the worker logger silently drops array values

The first implementation logged `{ flag, codes: unmapped }`. The `codes` key
never appeared in the line. `createWorkerLogger` runs object args through
`sanitizeAnalyticsProperties` (`src/lib/analytics/events.ts`), which keeps
strings, numbers, booleans, `null` and nested plain objects — and drops arrays
with no warning. The durable transport would have named no code while the Sentry
message named all of them.

Fixed by joining once and giving both transports the same string. This is a
general trap, not a fact about this branch, and it is promoted to lab notes at
step 8.

**Verdict:** ACCEPT.

## D7 — the gate's re-classification trigger fired, and step 0 was re-run

`verify-gate.sh --review` reported the production diff over 2× the estimate: 245
changed lines against `estimated_prod_lines: 80`. Step 0 was re-run with the real
numbers, as the trigger requires.

**The lane did not move.** SIZE is still `small` — the breadth axis, not a line
count: two production files, one behaviour, one tight surface, no new module and
no new dependency. RISK is still `high`, for the reason the intake gave. SURFACE
is still `backend`.

**The estimate missed the documentation, not the implementation.** Of the added
production lines, roughly 38 are executable and the rest are comment — about five
to one. **This entry first called that "above this area's own two-to-three-to-one
norm" and the standards review axis refuted the comparison:** 2-3:1 is the
large-feature-commit figure, while the two nearest comparable fixes in this same
lane measure about 7.8:1 (#1080) and 5.4:1 (#1079). The branch is BELOW both.
Re-derive rather than quoting any of these; a prose fix moves them, and this
repo's architecture log has been falsified twice that way.

`estimated_prod_lines` is corrected to 245 in both intake copies. That is a
record of the measurement, not a way to silence the trigger: the trigger already
fired and the re-classification it demanded is written above.

The ratio was deliberately NOT defended here; it went to the step 7 standards
axis, which judged it acceptable against the right comparison and named three
restatement blocks as the real inflation. Those are trimmed.

**Verdict:** ACCEPT.

## D8 — surface amendment 1: `.claude/reference/arch-review-log.md`

`ci:merge-ledger` fails any PR that changes a production file and adds no line to
the architecture review log. The path was outside `allowed_edit_surface`, so the
edit-surface guard blocked the write.

Owner signed off in this session, and the counter separately recorded
`auto-approved (1st amendment)` — the script auto-approves the first amendment
without requiring a reason, so both statements are true and neither implies the
other. The path is added to both intake copies and counted:
`surfaceAmendments = 1`. A second amendment now needs a stated reason and is
itself an abort-criteria trigger.

Not scope creep: the file is mandated by a CI audit for every production change
in this repository, and the gate cannot go green without it.

**Verdict:** ACCEPT.

## D9 — the gate's live-DB lane SKIPS on this branch, and was run separately

`db_touching` is `false`, truthfully: this branch adds no migration, no schema
change and no SQL. The gate's `test` row therefore sanitizes the database URL out
of its environment, and 96 integration files skip inside it. A green gate on this
branch is NOT evidence about the live-DB lane.

That matters here, because `refusal-write.integration.test.ts` covers the very
lane this branch edits.

So the lane was run explicitly, and the whole integration project with it, at the
SHA the gate measured: **116 files, 1206 tests passed, 5 skipped**, at
`229c51ba`. The named suite alone is 32 passing cases.

`db_touching` was NOT flipped to `true` to force gate provisioning. The field
describes the change, not the evidence wanted from it, and flipping it would make
the intake say something false about the branch. CI's `test` job stands up
`postgres:16` unconditionally, so the PR run is the authoritative live-DB gate.

**Re-run after the rebase, as this entry required.** The figures above were taken
before the rebase onto `origin/main` (three #1086 commits, no overlap with these
files). Re-derived at post-rebase HEAD `01aa07f3`: the whole integration project
is **116 files / 1206 tests passed, 5 skipped**, and `refusal-write.integration.test.ts`
alone is 32/32. Red team re-derived the same figure independently rather than
accepting this entry's word for it.

**Verdict:** ACCEPT.

## D4 — round 1's correction to finding 8 was narrowed

Round 1 asked for the new reset to be called in every suite that exercises the
real helper. Only `src/lib/refusals/__tests__/write.test.ts` gets it. The
integration suite drives the real auto-approval gate, so every block reason it
can produce is a member of the compiled `AutoApprovalBlockReason` union and
therefore mapped. The vocabulary latch can never set there, and a reset call
would assert nothing.

Recorded rather than dropped silently, because it is a partial accept.

**Verdict:** ACCEPT.

## D10 — branch review round 1 changed two locked behaviours

Four axes ran in one wave. Two Codex findings attacked decisions the intake had
locked, and the owner accepted both.

**The latch is now per CODE, bounded, not one process-wide boolean.** The intake
accepted "a second distinct unmapped code is silent" on the argument that a map
hole is systemic. Codex refuted the ARGUMENT rather than the design: since #1080
the compiler rejects the systemic static hole, so the surviving threat is a value
that escaped the union at run time — which varies per decision. In a long-lived
single-replica worker the boolean let the first bad value permanently hide a
second, from a different unsafe producer. Now a bounded `Set` with one overflow
marker at `UNMAPPED_SIGNAL_CAP`; bounded because the keys are exactly the values
the type system did not vouch for.

**The Sentry message is now a constant, with the codes in `extra`.** Sentry
groups by message, so an interpolated code list opened one issue group per
distinct set, ordering and duplication — scattering one fault's history and
applying per-issue throttling per group rather than per fault.

`tests_to_add` goes 18 → 21: two retitles and three new cases (constant-message
grouping, the distinct-code cap, and the enabled-ledger latch case that plan
decision D3 had never had an oracle for). `estimated_test_lines` → 340.

**Verdict:** ACCEPT.

## D11 — surface amendment 2, and the abort trigger it fired

`docs/runbooks/beta-launch-alerting.md` still stated that an unmapped block
reason "raises nothing on this lane while the switch is off" — false at HEAD, and
the sibling of the exact sentence this branch had already corrected in `write.ts`.
It also scoped `subsystem:refusal_ledger` to three callers at `warning`, where
HEAD adds a fourth at `error` with a new tag. Red team raised it P1; the Codex
axis raised the same gap independently as "no completed operator route".

`docs/runbooks/` was outside the surface, so fixing it is amendment 2 — which the
workflow lists as an ABORT CRITERION. The trigger fired and the owner overrode it
deliberately, with the reason recorded in `.feature/state.json`.

Recorded plainly because an overridden abort trigger is exactly the thing a later
reader should be able to find. The judgement: the trigger exists to catch
sunk-cost thrash and scope creep, and this is a documentation correction two
independent axes demanded on a branch whose implementation was already green.

**Verdict:** ACCEPT.

## D12 — `codex exec` hangs on stdin, and it cost two dispatches

Plan round 1 and branch review's adversarial axis both died with no session and
no output. `codex exec` reads stdin even when the prompt is an argument, so a
backgrounded invocation blocks forever and is eventually killed. Both recovered
on a re-run with `< /dev/null`.

Not a finding about this branch. Recorded so the next run does not pay it twice,
and promoted with the other durable lessons at step 8.

**Verdict:** ACCEPT.

## D13 — red-team round 2 found three P0s in round 1's own fixes

`round-start` refused a round 3 on that pass. These fixes therefore carried no
adversarial round behind them AT THE TIME THIS ENTRY WAS WRITTEN — the owner then
chose to spend a FRESH pass on exactly that gap, and D14 below records what it
found. Do not read this paragraph as the final state.

**P0-a — the cap did not exist.** `noteUnmappedBlockReasons` tested the Set's
SIZE and then added every fresh code, so one call carrying N new codes grew the
Set to N. Four documents asserted a bound the code did not enforce, and the
correctly-bounded mutant survived 29/29 because every case fed one code at a
time. The fix computes `room` from the cap and slices; the codes it cannot carry
are never marked as reported, and the call emits the overflow marker alongside
its report. A new case drives a single call with `cap + 3` codes.

**P0-b — "the only one above `warning`" was false when written.**
`withLedgerAttribution` has raised `error`-level `subsystem:refusal_ledger`
issues since #1079, and this branch's own overflow marker adds a third. A rule
filtering on subsystem plus level would page on three different faults. The
runbook now says: rule on the `fault` tag, never on subsystem-plus-level.

**P0-c — the overflow marker's durable log line had no oracle.** Deleting it
survived the whole suite, while the module latches on a QUEUED capture on the
stated grounds that the log line is what makes that acceptable. An untested
durable transport cannot carry that argument. The cap case now asserts it.

**P1s, all fixed:** the overflow catch's cooldown had no oracle either (new
case); "a new code is always reported" was false past the cap and contradicted
the paragraph four lines above it; both new signals were missing from §1a-do's
click-path table and from its register of un-ruled signals, which is the same
class of defect that register exists to prevent.

**P2s, recorded not fixed:** `generate-draft.ts:77` interpolates a `businessId`
into a `captureMessage`, so it opens one issue group per business under a
first-seen rule — unchanged code, a separate ticket. And round 1's F-08 (the
both-transports-throw case may be redundant with the Sentry-throw case) is
carried forward open, unmeasured, because case 4's mutation budget was spent.

**Verdict:** ACCEPT.

## D14 — a fresh red-team pass, and the owner was right to spend it

Round 2's fixes had no adversarial round behind them. The owner chose a fresh
pass over accepting the risk. It found two more P0s, and the first is the
sharpest finding of the whole run.

**P0-a — an assertion that passed on the clock.** The overflow case asserted
`expect(JSON.stringify(overflowLines[0])).toContain(String(cap))`. `cap` is 8,
and the log line carries an ISO timestamp — so the digit was frequently supplied
by the current time rather than by the payload. The pass proved it rather than
argued it: the `cap: 0` mutant DIED at 07:37 and SURVIVED on a re-run at another
instant. Same assertion, same code, different second. It now parses the line and
reads `data.cap` as a number.

This is the third distinct way this branch has shipped a test that passed while
measuring nothing, after the all-unmapped fixtures (round 1) and the
one-code-at-a-time cap cases (round 2). The generalisable lesson: **a substring
assertion against a whole serialized log line is not an assertion about the
payload.** Promoted to lab notes.

**P0-b — "Rule 6 is the one still genuinely owed" was false at HEAD**, and was
contradicted by the register eleven lines below it, which the SAME COMMIT edited
to say rules 7 and 8 are owed too. The branch's signature failure, occurring
inside the paragraph that records that lesson.

**P1 — the cap counted array entries, not distinct codes.** `fresh.length > room`
compared entries against Set slots, so nine repeats of ONE code tripped the
cap-reached page, named that code eight times, and burned the once-per-process
overflow latch — after which the genuine cap-reached event could never fire.
Unreachable from today's only caller, which de-duplicates upstream. Fixed anyway:
the helper's contract must not rest on a property of one call site. Duplicates
now collapse at this seam, and only at this seam — `resolvePolicyGateRefusal`
still keeps them, because there they are evidence rather than latch keys.

**P1 — the boundedness claim had no oracle.** Marking `fresh` instead of
`reportable` survived 31/31, because every emission path reads the Set's size
through `room`, which saturates identically at and past the cap. The mutant is
emission-equivalent and NOT behaviour-preserving: the difference is unbounded
growth, which is the entire reason the cap exists. Four documents asserted a
bound nothing could observe. Fixed with a test-only
`unmappedSignalledCodeCountForTests()` — a third test-only export, justified
because an unobservable invariant is an unasserted one.

**Also fixed:** the overflow log message is matched through an exported constant
rather than a copied literal; the operator-facing paragraph now names all three
reasons a code can be absent from `extra.codes`, including the cap-boundary case
where it is named nowhere; and the "Rules 1-3 fire on a new issue" sentence is no
longer non-exhaustive.

**Recorded, NOT fixed — and this one is a live gap.** The register's "no rule in
either project" claim rests on CONFIG-1's premise about `warning`-level captures.
Rules 7 and 8 are `error`, and rule 6's own reasoning implies the unfiltered
production rule `3920752` may already catch them. **Nobody has read Sentry back
to check.** The runbook now says so explicitly instead of asserting either way.

**Verdict:** ACCEPT.

## D15 — the re-classification trigger fired a SECOND time, and step 0 was re-run again

`verify-gate.sh --review` reported 536 changed production lines against the 245
this branch had already corrected the estimate to. Step 0 was re-run.

**The lane still does not move.** SIZE stays `small` on the breadth axis: two
production files, one behaviour, one call site, no new module, no dependency, no
schema, no SQL. RISK stays `high`, SURFACE stays `backend`.

**What grew is the recorded reasoning, and it grew because the reviews found
things.** Measured at HEAD: `write.ts` 68 code / 216 comment,
`persist.ts` 8 code / 88 comment. The code half roughly doubled across three
adversarial rounds — the per-code latch, the cap, the overflow marker, the
de-duplication — and each is a defect a round found rather than a feature that
was planned.

**The honest reading is that the ESTIMATE was never the problem; the PLAN was.**
An intake written before any review predicted 80 production lines for what three
rounds turned into a bounded per-code signal with an overflow path. That is not
an estimating error to correct, it is what an adversarially-reviewed change to a
kill-switch lane costs in this repository. Recorded so the next intake in this
area starts from the right number.

Estimates corrected to 540 / 520 in both copies. As with D7, that records the
measurement; it does not silence the trigger, which fired and is answered here.

**Verdict:** ACCEPT.
