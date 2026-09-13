# Red team — `feat/owner-operator-run-b`, round 2 (fresh run over the two CI-fix commits)

**Round 2 is the last round.** A fourth never opens and a third needs an owner authorization that does not
exist, so what is still `skipped-budget` below stays unmeasured by this run.

| | |
|---|---|
| Mode | `feature` · run id `feature-feat-owner-operator-run-b-fec8cf` |
| Branch | `feat/owner-operator-run-b` |
| Fork / merge-base | `6edacd0b094e47a1f72008ce75b126a4eead87ed` |
| Head | `77ce88f0449db0fdd1c9829e612039ae2b6bae2c` (round 1 ran at `3512492348c43dfe4b25ed093c3e0dea374ee91b`) |
| Intake sha256 | `3c4181464cbcee3e1bd57950773f877afdfac5bab231c294f1e1f643a5342c05` |
| Risk | `high` (declared in the intake) |
| Round | 2 of 2 |
| Status | **`INCOMPLETE_ORACLE`** (no open finding; one round-1 oracle row and 11 never-executed rows remain) |
| Mutation runs | round 1: 30 of 30 · round 2: 30 of 30 (both budgets exhausted) |

## Why this run exists

The previous red-team run closed `CLEAR` at `ef9b3a7cab29ee4e31f0b54f24cf5df65d512574` and is preserved,
untouched, at `docs/reviews/red-team/feat-owner-operator-run-b-fec8cf-rounds1-3/`. Two commits then changed
production files:

- `99975e2e9` — the flag → writable-owner → impersonation preamble, byte-identical in three routes, extracted
  into one `src/app/api/operator/gate.ts` (`requireOperatorWriter` / `requireOperatorProposalWriter`), plus a
  new `gate.test.ts`.
- `79f695d53` — `useTurnPoll`'s loop extracted to a module-level `startTurnPoll` factory (React Doctor
  `effect-needs-cleanup`); ten symbols un-exported; `apply.ts` revalidation and Receipt assembly extracted into
  helpers; `useProposalWrites` (with a new suite), `useTurnSubmission` and `useOperatorUrl` split out of
  `OperatorClient`; `useOperatorConversation` split; `ProposalState` extracted inside `ProposalCard`.

Scope is exactly `git diff ef9b3a7ca..79f695d53 -- src` — 14 files, +1427/−601. The closed run's rejected
findings (RT-09, RT-10, RT-14) and its accepted-risk RT-12 are not re-raised; RT-B\* are new ids.

## Environment

`mutation-runner.mjs env` allowlist with a temporary `HOME`, plus `dotenv-swap` of `.env.local` for the whole
mutation phase (the runner reported `swapped 1 file(s)`). `TEST_DATABASE_POOL_URL` validated as
`localhost:5499`, so the live-DB `apply.integration.test.ts` candidates ran for real rather than skipping. One
early run was lost to a missing `--test-db` on the runner's `run` subcommand (the integration suite
self-skipped) and one to a malformed mutant that failed to parse; both candidates were re-measured
successfully (baseline 4, M19b). Watchers: `none`. `finalize` restored 0 mutated files (each mutation was
reverted from a pristine copy immediately after its run, which `restoreMutations` then confirmed against the
journalled original blob) and 1 dotenv file, and closed the journal; `git status --porcelain` is empty apart
from this report.

## Severity table

| Id | Sev | Duty | Where | Claim | Disposition |
|---|---|---|---|---|---|
| RT-B2 | **P0** | 1 | `src/lib/agents/operator/apply.ts:443` | The Receipt's `before` can be swapped for the after-state and the whole suite stays green; the only assertion that reads it is an absence-of-key proxy | **fixed** |
| RT-B1 | P1 | 1 | `src/app/api/operator/gate.ts:86` | The impersonation → uuid step of the extracted gate order is unmeasured — hoisting the id check above the whole gate survives | **fixed** |
| RT-B3 | P1 | 1 | `src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts:126` | `withPatchedProposal`, the card-repaint half of "re-render from the returned row", is executed by no test | **fixed** |
| RT-B4 | P1 | 3 | `docs/superpowers/plans/feat-owner-operator-run-b-handoff.md:27` | The handoff's gate citation is wrong in both halves — neither the SHA nor the fingerprint matches the recorded evidence | **fixed** |
| RT-B5 | P2 | 2 | `.../__tests__/useProposalWrites.test.tsx:133` | The new suite hardcodes a wording sentence the same commit un-exported, against `wording.ts`'s own stated rule | **fixed** |
| RT-B6 | P2 | 4 | `src/app/(authenticated)/dashboard/operator/OperatorClient.tsx:254` | `useTurnSubmission` returns a fresh object every render while both sibling hooks memoize | **fixed** |
| RT-B7 | P2 | 1 | `src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts:320` | `applyLoadedView`'s `turnId` from the ref vs the render capture is unmeasured across `finishTurn` — elevated from oracle row B1-27 at the round-2 close by the root; owner decision "Round 3: measure the 11 rows, pin B1-27 (Recommended)" | **open** (round 3) |

Counts after round 2: **87 inventory rows — 49 killed, 0 confirmed survivors, 0 equivalent, 1 inconclusive
(oracle), 11 skipped-budget, 26 excluded. 6 findings: 1 P0, 3 P1, 2 P2 — all six `fixed`.** Round 1 read: 83
rows, 20 killed, 1 confirmed survivor, 3 inconclusive, 34 skipped-budget, 25 excluded, 6 open findings.

## Round 2 — what was measured at `77ce88f04`

The fix commit is `77ce88f04` (5 files, +151/−18: four test files and the one `useMemo` in
`OperatorClient.tsx`). Round 2 re-applied each round-1 mutant against the fixed tree, then spent the rest of
its 30 runs on the round-1 `skipped-budget` rows in the root's priority order. Three green full-file baselines
came first (the four `src/app/api/operator/__tests__/` suites, 22 tests; `apply.test.ts` + the live-DB
`apply.integration.test.ts`, 19 tests; the five `dashboard/operator/__tests__/` suites, 27 tests) — all green
under the scrubbed environment, so no kill below rests on an unproven baseline.

### Part A — the six fixes

| Finding | How it was verified | Result |
|---|---|---|
| RT-B2 (P0) | M22 (`before: parseVoiceState(proposal.before, …)` → `before: afterActual`, `apply.ts:443`) re-applied, live DB, two runs | **fixed** — `apply.integration.test.ts:616` fails (`expected { tone: 'warm and brief', …(4) } to deeply equal { …(5) }`) and `:286` fails (`expected 'warm and brief' to be null`). Two independent cases now read the field. |
| RT-B1 (P1) | M03 (uuid check hoisted above `await requireOperatorWriter`) re-applied, two runs against the two new `gate.test.ts` cases | **fixed** — case 1 fails on the TOKEN (`proposal_not_found` where `operator_disabled` is owed), case 2 fails `expected 404 to be 409`. |
| RT-B3 (P1) | M25 (`withPatchedProposal` reduced to `.map((p) => p)`) re-applied against the new OperatorClient case | **fixed** — fails on `expect(element).not.toBeInTheDocument()`: the Apply button survives, so the card never took the returned row. |
| RT-B4 (P1, docs) | re-resolved by reading; no mutation applies | **fixed** — the sentence now cites `3082da75f`, mode `full`, fingerprint `a2f7363f…`; all three resolve in `.feature/codex-gate-fingerprint.json`, `.feature/gate-status.json` and `.feature/state.json`, the two `src` trees really are the same object (`da32c14e…`), and `1545d93f` no longer appears anywhere outside this sidecar. |
| RT-B5 (P2) | read through, no run spent | **fixed** — `expect(...).toBe(routeErrorSentence(null))`; `wording.ts:206-209` makes that the accessor for the un-exported `ROUTE_ERROR_FALLBACK`. |
| RT-B6 (P2) | read; recorded `excluded` (row `R2-04`) because no mutation can measure it | **fixed** — `useMemo` with an exhaustive nine-value dependency array, matching both sibling hooks. No `useEffect` consumes the value, so object identity is unobservable to every assertion. |

No new finding was raised inside the fix hunks or their directly affected callers. The four new test cases are
clean on duty 2: the OperatorClient case asserts the presence of a state line and the ABSENCE of two named
buttons (a behavioural absence — the decision controls — not a tag proxy), and the two gate cases assert
tokens plus a call count, never a status code alone.

### Part B — 21 round-1 `skipped-budget` rows measured, all killed

- `apply.ts` (the file the P0 lived in): **B1-45** (the current/prepared conjunct of `versionTokensAgree`),
  **B1-47** (the contract comparison), **B1-48** (the pre-transaction `not_found`), **B1-49** and **B1-52**
  (the non-pending arm of `settledResult`, one mutant, two runs), **B1-51** and **B1-55**
  (`locationMissingResult`'s reason, one mutant, two runs), **B1-53** (the happy-path Receipt block, under
  M22), **B1-54** (the D11 sibling sweep), **B1-58** (the `repeated` flag under two concurrent applies).
- Gate + the three write routes: **B1-05**, **B1-07** (apply route), **B1-08**, **B1-09** (decline route),
  **B1-10**, **B1-11**, **B1-12**, **B1-13**, **B1-14**, **B1-15** (turns route), **B1-06** (the apply
  route's own impersonation refusal). Two gate mutants (`MR5` impersonation block deleted, `MR6` flag guard
  deleted) each measured a route row beyond the `gate.test.ts` rows round 1 already killed.
- `useProposalWrites`: **B1-34** (the posted `expectedVersionToken`), **B1-35** (the post-write
  `reloadTranscript()`).

Every one of the 21 FAILED under a semantically meaningful single mutation, and every run passed
`assert-one-test`. Two kills are crash-shaped rather than assertion-shaped (**B1-45**, **B1-49**): the mutant
carries the call past the branch the case stops at, and the stub queue — which holds only the results
production actually asks for — runs dry, so the case dies on `applied proposal vanished inside its own
transaction` / `proposal vanished while recording its outcome`. Both are recorded with that failure mode in
their rows rather than dressed up as an assertion failure. B1-52's property failure is assertion-shaped
underneath (`expect(writes()).toHaveLength(0)` — a terminal row wrote).

### Still unmeasured after round 2

`skipped-budget` (11): **B1-16, B1-19, B1-20, B1-24, B1-26** (`OperatorClient.test.tsx`), **B1-30, B1-32,
B1-33** (`ProposalCard.test.tsx`), **B1-37, B1-38** (`useProposalWrites.test.tsx`), **B1-57**
(`apply.integration.test.ts`). B1-57 additionally carries a reason no further budget would fix: its property
is the Postgres-driven rollback of a transaction poisoned by `SELECT 1 / 0`, and every single-line `apply.ts`
mutation that would swallow or reorder the throw is defeated by the aborted transaction, so it would survive as
an equivalent mutant. Resolving it needs a different instrument, not another run.

`inconclusive` (1, oracle): **B1-27** — `applyLoadedView`'s `turnId` from `loadRef.current` versus the render
capture. Re-read, not re-measured: the fix commit touches neither `applyLoadedView` nor `finishTurn`, and the
new OperatorClient case never clears `turnId`, so nothing discriminates the two spellings. No test was invented
for it, as instructed. This row is what holds the run at `INCOMPLETE_ORACLE`.

## The nine properties the handoff asked to disprove

| # | Property | Verdict |
|---|---|---|
| 1 | Gate order after the `gate.ts` extraction | **Partly measured.** flag-before-auth (M01), impersonation-after-auth (M02) and the writable-owner step (M26) are each pinned by a killing mutation. The fourth step — uuid LAST — is not: **RT-B1**. |
| 2 | 4-minute deadline, 2 s/5 s cadence, timer cleanup | **Holds.** M04 (deadline → 8 min), M05 (slow cadence → 2 s), M06 (independent deadline neutered) and M07 (effect cleanup removed) all killed. Cleanup on a halted wait is measured; cleanup on an *epoch bump* is not separately observable — the "Keep waiting" assertion (`pollCount` greater-than) would pass with two loops running. Recorded, not raised: M07 already proves the cleanup exists and runs. |
| 3 | Abort-on-POST and the `activeTurnIdRef` resume guard | **Mixed.** The epoch guard is pinned (M09 killed). The ref read itself survived (M08) and is recorded inconclusive with the exact window that would distinguish it (`finishTurn` nulls `turnId` and the ref, bumps `reloadEpoch`, but does **not** bump `loadRef.current.epoch`). Distinct from the closed run's accepted-risk RT-12, which is about the explicit `controller.abort()` calls. |
| 4 | 30 s POST deadline → byte-identical retry | **Holds.** M10 (deadline → 300 s) and M11 (retry allocates a fresh `clientTurnKey`) both killed. |
| 5 | Apply / Not now / Refresh plan re-render from the RETURNED row | **Half measured.** `useProposalWrites` hands the server's row to `patchProposal` (M12 killed) and serializes writes (M13 killed); `ProposalState` answers from the row's status (M23 killed); Refresh plan posts the stored location (M24 killed). What the transcript does with the patched row is unverified: **RT-B3**. |
| 6 | `apply.ts` lock order, in-transaction revalidation before the write, Receipt fields, repeat-Apply idempotency, `versionTokensAgree` | **Holds except one Receipt field.** M15 (lock order swapped), M17 (revalidation moved after the write), M18 (settled-applied arm deleted), M16 (`versionTokensAgree` drops the client token), M20 (`actorName` → null), M19b (`differsFromPreview` → false) and M21 (`locationMissingResult` ignores the status) all killed. `before` survived: **RT-B2**. `versionTokensAgree` still distinguishes all three tokens (M16); note there is no `'absent'` token in `version-token.ts` — the only `'absent'` in the Operator tree is a `locationRow` fixture label at `version-token.test.ts:66`, so the handoff's phrasing of this sub-item does not correspond to production code. |
| 7 | Fragile assertions introduced by the refactor | One, at P2: **RT-B5**. `gate.test.ts` is clean — its assertions are call counts and argument shapes on real seams, no SQL-text `toContain`, no absence-of-tag proxy, no ordering claim without a contract. The absence-of-key proxy that *matters* is pre-existing (`apply.integration.test.ts:606`) and is the mechanism behind RT-B2. |
| 8 | Doc claims re-resolved against HEAD | One finding: **RT-B4**. Everything else checks out — see below. |
| 9 | Missed siblings | No fourth caller, no remaining unused export worth reporting, no stale dependency array. One stability inconsistency at P2: **RT-B6**. See below. |

## Duty 3 — doc claims, re-resolved at HEAD

`~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` was not used; every claim below was hand-checked
and that is stated here as the skill requires.

| Claim | Source | Verdict |
|---|---|---|
| `gate.ts` row: "flag → `requireWritableOwner` → impersonation 409, in that order"; `requireOperatorProposalWriter` adds the id resolution, "malformed = the same 404 a foreign id gets" | `docs/directory/app-api-b.md:86` | TRUE against `gate.ts:52-90` |
| "Behaviour is unchanged — every pre-existing route test passes verbatim" | `99975e2e9` message | TRUE — the diff touches no pre-existing route test, and all 15 cases in the four route/gate suites pass (baseline 1) |
| "Cadence, deadline and abort behaviour are unchanged" | `79f695d53` message | TRUE — `git show ef9b3a7ca:…/useTurnPoll.ts` carries identical `POLL_FAST_MS`/`POLL_SLOW_MS`/`POLL_BACKOFF_AFTER_MS`/`POLL_DEADLINE_MS`, the same standalone deadline `setTimeout`, the same `clearTimeout(tick)` in `stop`, and the same `clearTimeout(deadline)` + `controller.abort()` in the stopper |
| "dropped `export` from ten symbols" | `79f695d53` message | TRUE — 5 in `wording.ts`, 3 in `schema.ts`, `CONVERSATION_PATH`, and the `TurnView` type = 10, each verified unexported at HEAD |
| The eight extracted markup components (`EmptyPrompt` … `LocationChooser`) | `79f695d53` message | TRUE — all eight exist in `OperatorClient.tsx` |
| "the apply/reads integration suites (21)" | `79f695d53` message | TRUE — `apply.integration` 8 + `reads.integration` 13 = 21 |
| "the operator unit suites (109 tests)" | `79f695d53` message | NOT FALSIFIED — the Operator test tree itself holds 87 `it(` cases; 109 is reachable once the nav/route suites Run B also touched are included, and the sentence does not enumerate them. No finding. |
| "`pnpm ci:fallow:coverage` reports dead code 0 · complexity 0 · duplication 0" / "React Doctor exit 0" / "CI on #1273 fully green, mergeable CLEAN" | `79f695d53` message, handoff:27 | TRUE — `gh pr checks 1273`: `fallow` pass, `react-doctor` pass (score 86, 0 errors, 18 warnings), `lint`/`test`/`build`/`e2e` pass; `gh pr view 1273`: `mergeable MERGEABLE`, `mergeStateStatus CLEAN`, not a draft. A local `fallow audit --gate new-only` without `--coverage` reports 7 complexity findings, which is the estimated-CRAP path, not the command the claim cites. |
| `docs/directory/app-authenticated.md` row for `useProposalWrites.ts`; the rewritten `useTurnPoll`/`ProposalCard` rows | `79f695d53` | TRUE, and `ci:directory-map` passes in the recorded gate |
| Surface: `gate.ts` named explicitly (amendment #4); `useProposalWrites.ts` and its suite covered by the existing `dashboard/operator/*.ts` and `__tests__/*.tsx` globs | `.feature/intake.json`, `.feature/state.json` | TRUE — no unrecorded surface amendment |
| "Review gate GREEN at `79f695d53` (fingerprint `1545d93f…`)" | handoff:27 | **FALSE in both halves → RT-B4** |

## Duty 4 — sibling search, recorded

**Patterns searched** (scope `src/`, exclusions noted):

1. `rg -n "ownerOperatorEnabled" src` — 5 call sites besides `flags.ts`. Two are the consolidated gate's
   (`gate.ts:52`) upstream surfaces (`(authenticated)/layout.tsx:181` nav visibility,
   `dashboard/operator/page.tsx:26` `notFound()`); two are the Operator **read** routes
   (`conversation/route.ts:23`, `turns/[id]/route.ts:21`), which never carried the write preamble — they have
   no owner-writability or impersonation step to share. **Zero fourth caller of the old preamble.**
2. `rg -n "hasImpersonationCookie" src` — `gate.ts:59` and `settings/auto-approval/route.ts:30,:43`. The
   auto-approval route is the documented precedent the gate's docblock cites, is outside this diff, and was
   already adjudicated in the closed run (RT-09, rejected). Not re-raised.
3. New exports of the two new files (`OperatorWriter`, `OperatorWriterResult`,
   `OperatorProposalWriterResult`, `ProposalWrites`, `TurnPoll`): the three `gate.ts` types are referenced
   nowhere outside `gate.ts`, but each is part of the public signature of an exported function
   (`requireOperatorWriter` / `requireOperatorProposalWriter` return them), which is the normal reason to
   export a result type; `fallow`'s own metric line reports `dead exports 0.0%`. **Not reported as a
   finding** — inventing one here would be thoroughness theatre.
4. Dependency arrays of every hook the decomposition produced or moved: `useTurnPoll`'s effect
   (`[turnId, halted, pollEpoch, onDisabled, onTerminal]`), `useOperatorConversation`'s load effect
   (`[disabled, fresh, conversationId, scopedLocationId, reloadEpoch, writeUrl, onDisabled, onNotice]`, with
   `turnId` deliberately excluded and read through the ref — documented in place), `useProposalWrites.write`
   (`[busyId, onDisabled, patchProposal, reloadTranscript]`), and `useTurnSubmission`'s
   `post`/`send`/`retry`/`refreshPlan`/`clear`. **No stale array.** The one inconsistency found is identity
   stability, not dependencies: **RT-B6**.

## Duty 5 — operational completeness

Neither commit adds an operator-actionable terminal or swallowed failure path. `gate.ts` returns refusal
responses only; the `reportCaughtError` calls in the three routes are unchanged in identity and payload; the
two `throw new Error(...)` sites in `apply.ts` pre-date the diff and were moved by no hunk; the `console.error`
calls in `getJson`/`postJson` are unchanged. No row in `docs/runbooks/beta-launch-alerting.md` is added,
removed or contradicted by either commit. **Zero findings, and this is a recorded zero rather than a skipped
duty.** (Rule 11's NOT-BUILT status is owed by the feature as a whole and is adjudicated in the closed run's
RT-01; it is unchanged by these two commits.)

## Budget

**Round 2: 30 of 30 runs, all through the runner** — 3 green full-file baselines, 6 fix-verification mutant
runs (M22 ×2, M03 ×2, M25, plus M22's second case), and 21 single-test mutant runs on round-1
`skipped-budget` rows. Every run passed `assert-one-test`; every mutation was reverted from the pristine blob
immediately after its run, and `finalize` reported `restored 0 mutated file(s) and 1 dotenv file(s); journal
closed` with `git status --porcelain` empty. 11 in-scope candidates remain `skipped-budget` and 1 remains
`inconclusive`, which is why this round is `INCOMPLETE_ORACLE` rather than `CLEAR`. **There is no round 3**:
the cap is two, and the third needs an owner authorization this sidecar does not carry.

Round 1 (historical): 30 of 30 runs, all through the runner: 4 green full-file baselines (route+gate suites, client suites, operator
lib suites, `apply.integration` with the local DB), 24 single-test mutant runs that classified, and 2 spent on
the two operator errors described under **Environment**. 34 in-scope candidates were therefore never executed
and carry `skipped-budget`. A second round, if the owner opens one, should spend its budget on
`turns-route.test.ts` (6 rows), the remaining `apply.test.ts` rows (6), and the remaining
`apply.integration.test.ts` rows (6) before anything else — nothing in this round touched them.
*(Round 2 did exactly that: all 6 `turns-route.test.ts` rows, all 6 remaining `apply.test.ts` rows and 4 of
the 6 remaining `apply.integration.test.ts` rows were measured and killed.)*

## Authorizations

Rendered from `findings.json`'s `authorizations` array.

- **AUTH-1** (2026-09-12), finding ids: RT-B7 — "I authorize a third round scoped to the 11 skipped rows and RT-B7 (B1-27)."

> Recorded at the round-2 close. The owner's first answer to "how do you want to close the run" was, verbatim,
> **"Round 3: measure the 11 rows, pin B1-27 (Recommended)"**; the runner and the checker open a third round only on
> an authorization whose text names the *third round* (`mutation-runner.mjs:444`, `red-team-status.mjs:284`), so the
> owner re-issued it in the sentence above. RT-B7 is oracle row B1-27 elevated to a P2 finding so the authorization has
> a finding id to resolve. Round 3 is scoped to: the 11 `skipped-budget` rows (B1-16, B1-19, B1-20, B1-24, B1-26,
> B1-30, B1-32, B1-33, B1-37, B1-38, B1-57) and the RT-B7 case.

## Red-team findings rejected

None in either round. The closed run's rejected findings (RT-09, RT-10, RT-14) stand and belong in the PR
description's "Red-team findings rejected" section unchanged.

## Run-opening authorization (recorded here, not in `authorizations`)

The owner authorized this fresh run — the closed CLEAR run preserved as `…-fec8cf-rounds1-3/`, the journal rotated, round 1 opened over `git diff ef9b3a7ca..79f695d53 -- src` — with the verbatim answer **"Yes, do both steps and run it (Recommended)"** (2026-09-12; also in the message of commit `351249234`). The checker's `authorizations` schema admits only records that resolve at least one finding id, so the opening authorization is recorded in this prose section instead of as an `AUTH-*` row. Any owner adjudication of the high-risk open P1s below is recorded as `AUTH-1`… with the ids it resolves.
