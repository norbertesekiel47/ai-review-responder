# Run C verifier extension — independent correctness/security review

Verdict: REVISE — one actionable P2 finding (95% confidence).

Baseline: `72cc51abd5d45b10cd7abf3c993f9039c5e63f65`

Candidate: `5c3c19568dd65ca7dd672ff3d95b8540742c7d7f`

Scope: the mutation runner, its existing regression suite, and the eight matching skill/intake/evidence documents in this exact ten-file diff. Review used immutable Git object reads only. The parent supplied the green wrapper-gate result; this reviewer did not independently run or inspect that mutable gate log.

## F1 — P2: Enforce Run C startup refusal before the first authorization is journaled

Location: `.agents/skills/red-team/scripts/mutation-runner.mjs:652` (new rejection conditional); related regression: `scripts/ci/__tests__/red-team-mutation-runner.test.ts:645`.

Contract: the approved Run C pass must measure the pinned committed candidate, preserve corrected product baseline `72cc51ab`, and allow only journaled mutations as tracked changes. The new regression explicitly promises rejection of an unexpected staged or unstaged product edit before the first Run C launch.

Concrete scenario: open round 2 normally, leaving `runs: 0` and no `budgetAuthorization`. An unjournaled tracked product edit appears before its first `run`. `onlyJournaledChanges` rejects it at lines 87–95, so `authorizedRunCBudget` returns null at line 106. However, the new refusal at line 652 requires an already-recorded Run C authorization. With none yet recorded, execution falls through to the ordinary 30-run cap at line 656; zero is below that cap, so the supervisor launches the command against the dirty candidate and the journal still receives no candidate pin. The same startup fallback occurs when approval or baseline checks fail. This does not enlarge the ceiling beyond 30, but it lets the supposedly pinned second pass execute on an invalid candidate before refusing.

Evidence: `cmdRoundStart` writes `emptyJournal(round)` at line 561; its existing regression at test lines 676–682 explicitly verifies zero runs after opening round 2. The new `authorizeRunC` fixture instead seeds `runs: 30` at test lines 567–569. Consequently the dirty-tree tests at lines 645–654 pass because the default budget is already exhausted, not because the first-launch rejection works. `cmdRun` records `budgetAuthorization` only after a successful authorization at lines 685–688.

Smallest correction: for the scoped Run C round-2 pass, distinguish invalid startup preconditions from an ordinary branch that has no special budget, and refuse the former before launching even when no grant has yet been journaled. Preserve other branches' default behavior. Add startup regressions initialized through the real round-opening path (or with `runs: 0`), covering both staged and unstaged foreign edits and invalid committed approval; assert no launch, no run increment, and no candidate pin. Keep the existing post-pin drift and 1,500/1,501 checks.

## Other reviewed behavior

- The new grant requires the exact branch, round 2, corrected baseline ancestry and permitted post-baseline paths, committed sidecar, original report head, 710 ordered inventory identities and hash, and verbatim dated approval.
- Once recorded, the grant pins the candidate SHA and authorization hash and refuses further launches after drift, even below the ordinary 30-run threshold. The 1,500-launch comparison retains the existing counter and boundary semantics.
- The existing `feat/1185` round-1 exception and other branches' defaults retain their control flow. This approval text does not authorize a third round or change finding dispositions to accepted risk.
- The diff does not alter supervisor release/journaling, process-group reaping, environment construction, dotenv handling, timeout handling, or mutation restoration. The added executable fixture retains Git-environment scrubbing and tests journaled mutation restoration.
- The eight document changes consistently record a budget-only authorization and preserve the historical round-1 outcome. No additional actionable finding was identified in those changes.

## Limits

This is a static review, not an execution or mutation result. No tests, builds, remote tools, source edits, commits, or nested agents were run. No browser journey applies to this local verifier-only extension. Existing runner behavior outside the extension was read only to assess the new control flow and was not audited as a new scope. The concurrent checkout was not used as source evidence; this report is the sole output file.
