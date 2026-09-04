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
2× re-classification trigger. `estimated_prod_lines` is unchanged at 80.
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

Case count is unchanged at 18. `allowed_edit_surface` is unchanged, so this is a
deviations entry and not a surface amendment.

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

## D4 — round 1's correction to finding 8 was narrowed

Round 1 asked for the new reset to be called in every suite that exercises the
real helper. Only `src/lib/refusals/__tests__/write.test.ts` gets it. The
integration suite drives the real auto-approval gate, so every block reason it
can produce is a member of the compiled `AutoApprovalBlockReason` union and
therefore mapped. The vocabulary latch can never set there, and a reset call
would assert nothing.

Recorded rather than dropped silently, because it is a partial accept.

**Verdict:** ACCEPT.
