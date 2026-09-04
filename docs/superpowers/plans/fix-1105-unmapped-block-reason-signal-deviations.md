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

## D4 — round 1's correction to finding 8 was narrowed

Round 1 asked for the new reset to be called in every suite that exercises the
real helper. Only `src/lib/refusals/__tests__/write.test.ts` gets it. The
integration suite drives the real auto-approval gate, so every block reason it
can produce is a member of the compiled `AutoApprovalBlockReason` union and
therefore mapped. The vocabulary latch can never set there, and a reset call
would assert nothing.

Recorded rather than dropped silently, because it is a partial accept.

**Verdict:** ACCEPT.
