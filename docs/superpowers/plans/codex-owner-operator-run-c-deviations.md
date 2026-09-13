# Run C deviations

## D1 — Owner-approved verifier budget for the next pass

**Verdict:** ACCEPT

The first red-team round exhausted its 30 supervised launches after 15 baseline/mutant pairs. The complete inventory contains 683 in-scope cases, leaving 668 unmeasured. Finishing those cases requires at least 1,336 additional launches before rechecking the accepted review corrections. The ordinary 30-launch next round cannot complete the measured scope.

On 2026-09-13 the root asked: “May I make a Run C-only change to the verifier’s limit, allowing up to 1,500 local test runs to finish those checks?” The owner replied: “I'll finish everything from C, D, and E. I give you the approval.” The exact request and answer are recorded under `owner-run-c-budget-next-pass` in the red-team JSON authorizations array.

The approved next pass is round 2 and covers the remaining original inventory, the four accepted review corrections and their directly affected callers, and the narrowly scoped verifier change. It also measures the original inventory that remains incomplete. This is the bounded scope exception necessary to complete the explicitly approved remaining checks; it grants no third round and accepts no finding as risk.

The ceiling is 1,500 supervised local test launches for that pass. The 120-second timeout, at-most-two semantic mutations per case, complete candidate inventory, exact-one-test check, identical scrubbed baseline/mutant environment, root finalizer, and non-CLEAR blocking rules remain binding. The runner recognizes only this branch, recorded approval and inventory, and pins the corrected product baseline plus the next pass's committed HEAD. Other branches retain 30 launches per round.

Surface amendment 4 adds exactly the mutation runner, its existing test file, and both skill-document copies. The user-visible Run C contract, eight tracers, original product estimates and production flag prohibition do not change. The explicit owner decision resolves the workflow delta; it is not a fourth product plan-review round.
