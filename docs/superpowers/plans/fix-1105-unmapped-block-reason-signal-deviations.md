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
