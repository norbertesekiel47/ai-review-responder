# Red team — `feat/owner-operator-run-b`, round 1 (fresh run over the two CI-fix commits)

| | |
|---|---|
| Mode | `feature` · run id `feature-feat-owner-operator-run-b-fec8cf` |
| Branch | `feat/owner-operator-run-b` |
| Fork / merge-base | `6edacd0b094e47a1f72008ce75b126a4eead87ed` |
| Head | `3512492348c43dfe4b25ed093c3e0dea374ee91b` |
| Intake sha256 | `3c4181464cbcee3e1bd57950773f877afdfac5bab231c294f1e1f643a5342c05` |
| Risk | `high` (declared in the intake) |
| Round | 1 of 2 |
| Status | **`OPEN_P0`** |
| Mutation runs | 30 of 30 (budget exhausted) |

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
| RT-B2 | **P0** | 1 | `src/lib/agents/operator/apply.ts:443` | The Receipt's `before` can be swapped for the after-state and the whole suite stays green; the only assertion that reads it is an absence-of-key proxy | open |
| RT-B1 | P1 | 1 | `src/app/api/operator/gate.ts:86` | The impersonation → uuid step of the extracted gate order is unmeasured — hoisting the id check above the whole gate survives | open |
| RT-B3 | P1 | 1 | `src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts:126` | `withPatchedProposal`, the card-repaint half of "re-render from the returned row", is executed by no test | open |
| RT-B4 | P1 | 3 | `docs/superpowers/plans/feat-owner-operator-run-b-handoff.md:27` | The handoff's gate citation is wrong in both halves — neither the SHA nor the fingerprint matches the recorded evidence | open |
| RT-B5 | P2 | 2 | `.../__tests__/useProposalWrites.test.tsx:133` | The new suite hardcodes a wording sentence the same commit un-exported, against `wording.ts`'s own stated rule | open |
| RT-B6 | P2 | 4 | `src/app/(authenticated)/dashboard/operator/OperatorClient.tsx:254` | `useTurnSubmission` returns a fresh object every render while both sibling hooks memoize | open |

Counts: 83 inventory rows — 20 killed, 1 confirmed survivor, 3 inconclusive (oracle), 34 skipped-budget,
25 excluded. 6 findings: 1 P0, 3 P1, 2 P2, all open.

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

30 of 30 runs, all through the runner: 4 green full-file baselines (route+gate suites, client suites, operator
lib suites, `apply.integration` with the local DB), 24 single-test mutant runs that classified, and 2 spent on
the two operator errors described under **Environment**. 34 in-scope candidates were therefore never executed
and carry `skipped-budget`. A second round, if the owner opens one, should spend its budget on
`turns-route.test.ts` (6 rows), the remaining `apply.test.ts` rows (6), and the remaining
`apply.integration.test.ts` rows (6) before anything else — nothing in this round touched them.

## Authorizations

Rendered from `findings.json`'s `authorizations` array.

*(none at round 1 — the run-opening authorization is recorded in the section at the end of this file; the checker admits only records that resolve finding ids.)*

## Red-team findings rejected

None this round. The closed run's rejected findings (RT-09, RT-10, RT-14) stand and belong in the PR
description's "Red-team findings rejected" section unchanged.

## Run-opening authorization (recorded here, not in `authorizations`)

The owner authorized this fresh run — the closed CLEAR run preserved as `…-fec8cf-rounds1-3/`, the journal rotated, round 1 opened over `git diff ef9b3a7ca..79f695d53 -- src` — with the verbatim answer **"Yes, do both steps and run it (Recommended)"** (2026-09-12; also in the message of commit `351249234`). The checker's `authorizations` schema admits only records that resolve at least one finding id, so the opening authorization is recorded in this prose section instead of as an `AUTH-*` row. Any owner adjudication of the high-risk open P1s below is recorded as `AUTH-1`… with the ids it resolves.
