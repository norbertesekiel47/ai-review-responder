# Red team — `feat/1010-refusal-solicitation-singles` · **ROUND 2**

Mode `feature` · risk `high` · round **2 of 2 (the cap)** · generated 2026-08-31.

| Pin | Value |
|---|---|
| Branch | `feat/1010-refusal-solicitation-singles` |
| Fork | `06a163f0b4b102c88687c95862999e38a1c3f517` |
| Merge base | `06a163f0b4b102c88687c95862999e38a1c3f517` |
| Head (this pass) | `426ccf77fc2b1248161e466fbf26d15bb7332f8a` — the state EXAMINED |
| Head pinned | `6f447b01fdb903820af45eb076fa0485d70f1517` — see § Round-2 closure and § Rebase |
| Round-1 head | `e9a6a50b21710d28209ebed7023704a21159a53a` |
| Round-2 scope | `git diff e9a6a50b..426ccf77` — the fix hunks and their direct callers only |
| Intake sha256 | `d8c75e211ed0bb4ab1e5334494e20522674e268c784b6b03844280e9d6174c7f` — NARROWED by the revert; the examined state was `5fdcdb49` |

> **This file REPLACES round 1's report at the same branch-derived slug.** Round 1's
> six findings are carried forward below with their disposition at this HEAD, so
> nothing is lost by the overwrite.

**Status: `OPEN_P0`.** One P0 (RT2-1). At the hard cap of two rounds there is no
round behind this one: RT2-1 goes to the owner.

---

## 1. Preconditions

| Precondition | Result |
|---|---|
| Worktree clean at a committed SHA | PASS — `git status --porcelain` empty at `426ccf77` |
| No process serving or watching this worktree | **RESOLVED, not clean.** `mutation-runner.mjs watchers` ABORTED on four processes (`pnpm dev`, `next dev`, two `next-server`). Their working directories were read with `lsof -a -p <pid> -d cwd`: PIDs 68547/69387/69738 are `…/RepWorth` (the parent checkout), PID 76253 is `…/RepWorth-worktrees/refactor-globals-css-extraction`. **None has a working directory inside this worktree**, so no hot-reload process can execute a mutation here. The runner's check is a repo-agnostic `ps` pattern with no path scoping; the skill's precondition ("no process is serving or watching **this worktree**") holds. Identical resolution to round 1. |
| Journal closed, round open | PASS — `round-start` opened **round 2** with 30 runs available and reset the counter |
| Environment isolated | PASS — `env --tmp-home $(mktemp -d) --test-db <localhost:5499/test_1010>` plus `dotenv-swap`, so `.env.local` was a scrubbed replacement for the whole mutation phase. Test database `test_1010` is this pass's alone. |

## 2. Restoration

The finalizer's **first** invocation FAILED with 7 aborts. Cause, recorded because
it is a trap for the next run: mutations of one file were CHAINED (each `mutate`
records the *current* working blob as that entry's `originalOid`), and the
operator's own "restore by mutating back to the HEAD blob" step created a journal
entry whose `originalOid` is the last MUTANT. `finalize` walks entries in array
order and dutifully restored that entry's "original" — putting the A4 and B4
mutants back — then aborted on the earlier chained entries because the working
blob matched neither their original nor their mutant.

Resolved by hand, exactly as the runner's own abort message instructs
("Resolve by hand"):

1. `git checkout -- src/lib/solicitation/dispatch.ts worker/background/pollers/SolicitationReleasePoller.ts` (named paths only).
2. The pre-repair journal was copied to the session scratchpad as
   `journal-before-hand-repair.json`, then the 7 `applied` mutation entries were
   marked `restored` with a `handRestoredAt` stamp.
3. `finalize` re-run → `restored 0 mutated file(s) and 0 dotenv file(s); journal closed`, exit 0.

Proof the tree is unmoved, taken after the repair and before any report byte:

```
git status --porcelain              -> (empty)
git diff --stat HEAD                -> (empty)
git hash-object src/lib/solicitation/dispatch.ts                        -> 3ee68e3cdd385059247ea9aab301f6b89052a5c2
git rev-parse 426ccf77:src/lib/solicitation/dispatch.ts                 -> 3ee68e3cdd385059247ea9aab301f6b89052a5c2
git hash-object worker/background/pollers/SolicitationReleasePoller.ts  -> 532ef1558e07e8a4d55b8c41bd0d2d28506e78bd
git rev-parse 426ccf77:worker/.../SolicitationReleasePoller.ts          -> 532ef1558e07e8a4d55b8c41bd0d2d28506e78bd
.env.local                                                              -> 319 lines, real header, no `.env*.red-team-backup` remains
```

**A further finalizer run is not required** — the journal is closed, the dotenv
swap is closed, and the tree is byte-identical to HEAD. Re-running it is
idempotent and harmless.

## 3. Budget

15 of 30 runs used. **The per-test cap of 2 mutations was exceeded** on both
candidates (4 mutations each), under explicit orchestrator direction naming those
specific attacks. Recorded rather than glossed; the global 30-run cap was
respected and no candidate was left `skipped-budget`.

---

## 4. Findings

### RT2-1 — **P0** — the P1-B fix cannot observe the failure it was built for, and the gap it documents never existed

`worker/background/pollers/SolicitationReleasePoller.ts:61-107` · duty 3 (docs vs
reality) · disposition **fixed** — resolved by the FULL REVERT `c4bfa647`, not by a patch

The fix's premise is a causal chain the code contradicts at three links.

**Link 1 — the failure never reaches the new catch.** `latchSystemHalt` is called
from exactly one place: `src/lib/solicitation/release.ts:791`, where
`sql.begin(tx => latchSystemHalt(tx, …))` is the BODY passed to `isolateItem`.
`isolateItem` (`src/lib/solicitation/release-phases.ts:69-81`) catches, calls
`recordItemFailure`, and `return undefined` — **it never rethrows**. A
`batch_halted` ledger abort therefore rolls its batch back, is contained one
frame below `runReleaseCycle`, and cannot propagate to
`runSolicitationReleaseCycle`'s new `catch`. Both system-halt sweeps route this
way (`release.ts:916` and `release.ts:970` both call `sweepSystemHalt`, reached
under `alertPhaseFailure('send_window_elapsed', …)` at `release.ts:317` and
`alertPhaseFailure('batch_expired', …)` at `release.ts:325`).

**Link 2 — the alert path it claims to add already existed.**
`recordItemFailure` (`release-phases.ts:89-108`) already does what the fix does,
for exactly this failure: `Sentry.captureException(cause, { level: 'warning',
tags: { subsystem: 'solicitation-release', phase }, extra: { batch_id,
account_id, business_id } })`, wrapped in its own `try {} catch {}`, with the
`logger.error` fallback deliberately OUTSIDE that guard. The docblock's assertion
that "`createGuardedPoll`'s shared catch emits `logger.error` alone" and that a
failed system halt is "left at the log line alone … repeats silently every
minute" is false at `426ccf77` and was false at `e9a6a50b`. The repo's own
existing test says so in plain words —
`src/lib/solicitation/__tests__/release.integration.test.ts:2162-2163`:
"the failed item is left exactly as it was, for the next tick **and for the
Sentry issue the catch raised**."

**Link 3 — one of the two named arms writes no Refusal at all.**
`SolicitationReleasePoller.ts:65-67` and the deviations file both say
`batch_halted` "now writes on the `platform_halt` and `send_window_elapsed`
arms". `BATCH_HALTED_REFUSAL_CATEGORIES` at `src/lib/refusals/vocabulary.ts:336`
maps `send_window_elapsed: null`, and `approval.ts:635-636` skips the write
outright on a null category. Only `platform_halt` writes.

**What the new capture actually does.** It fires on what genuinely propagates: a
phase-level throw. Those are already captured by `alertPhaseFailure`
(`release-phases.ts:134-151`), which captures *and rethrows* — so every phase
failure now raises **two** Sentry issues, and the second carries
`subsystem: 'solicitation_release'` (underscore) where the whole lane already
uses `subsystem: 'solicitation-release'` (hyphen). One condition, two issues, two
tag values, and any rule keyed on either value sees half the traffic.

**Why P0 and not P1.** The skill makes "a misleading FALSE claim" a P0. The claim
is repeated in three places that a reader will treat as authority — a production
docblock (`SolicitationReleasePoller.ts:61-72`), the deviations record
(`docs/superpowers/plans/feat-1010-refusal-solicitation-singles-deviations.md:42-63`,
which is where an approver reads the fix's justification), and the test's own
comment (`worker/background/pollers/__tests__/SolicitationReleasePoller.test.ts:217-220`).
The new test passes only because it mocks `runReleaseCycle` to reject directly,
which the named failure mode cannot do. Round 1's RT-2 was itself the
mis-diagnosis; this is its correction.

**The mutations still measure real assertions.** B1–B4 all died (§5). RT2-1 is
not "the test is hollow about what it asserts" — it is "what it asserts is not
the property the branch claims to have bought."

### RT2-2 — **P1** — the newly emitted Sentry signal has no rule row

`docs/runbooks/beta-launch-alerting.md:207-212` · duty 5 · disposition **fixed** — resolved by the RT2-1 revert; the signal no longer exists, so no rule row is owed and the runbook is correctly untouched

`subsystem: 'solicitation_release'` appears at exactly three places in the repo
(`rg -n solicitation_release`): the emitter, its test, and the deviations file.
**SUPERSEDED AT HEAD — this sentence is true at `426ccf77` only.** The revert
`c4bfa647` deleted the emitter and its test, so at HEAD the underscore spelling
survives ONLY in prose (this report, the deviations file, the arch-review row).
No production code emits it.
It has **no §1 bullet and no row in the §1a-do rule table** (rules 1-6 key on
`health_alert`, `limit_exceeded`, `stripe_reconciliation`,
`import_consent_analytics`, `solicitation_send_breaker_tripped`,
`solicitation_lane`). Duty 5: an emitted signal with no rule row is a P1.

The #1009 `AutonomyGovernorScheduler` precedent the fix names as its model added
its runbook bullet in the same change (`beta-launch-alerting.md:67-82`). The
deviations file says the fix follows that precedent "exactly"; on this half it
does not.

Round 1's RT-2 carried both halves ("no Sentry signal **and no alerting rule
row**"). The signal half was a mis-diagnosis (RT2-1); this half survives intact
and is untouched by the fix.

`docs/runbooks/beta-launch-alerting.md` is **not** in `allowed_edit_surface`, and
D0 records both surface amendments as spent — so this cannot be closed on this
branch and needs owner adjudication. If RT2-1 resolves by removing the capture,
this finding resolves with it; if the capture stays, the row is owed.

### RT2-3 — **P2** — the ordering case leaves `closeBatchIfSettled`'s position unpinned

`src/lib/solicitation/__tests__/dispatch.integration.test.ts:2569-2639` · duty 1 ·
disposition **open** — P2, recorded with the arbiter's reasoning, no action

Mutation A5 hoisted `closeBatchIfSettled` to the top of `commitWithhold` — the
settlement join then runs before the outreach is marked `withheld`, so a batch
whose last row is a withhold never closes. The new ordering case **survived**,
and so did the sibling case that most looks like it should catch it
(`batch closure closes the batch once the last Outreach row terminalizes across a
mixed sent, withheld and failed set` — that fixture's last terminalizer is not
the withhold).

**Arbiter reasoning:** A5 is neither equivalent nor on an unexecuted branch, but
it is **not semantically meaningful for the tested behaviour**, which is the
ledger write's position relative to five named writes plus last-of-all. The five
relative orders and `ledgerIndex === queries.length - 1` all still hold under A5.
Reclassified from P0-candidate to a recorded P2. It is worth recording because
the sibling rollback case's own title enumerates "outbox completion **and batch
close** together", so a reader reasonably expects the settlement join to be
pinned in position too, and it is not.

### RT2-4 — **P2** — D6's "~160 test lines" understates the measured delta

`docs/superpowers/plans/feat-1010-refusal-solicitation-singles-deviations.md:69-71`
· duty 3 · disposition **fixed** — D6 corrected to the measured 246

`git diff --numstat e9a6a50b..426ccf77` over test paths: 164 + 82 = **246** added
test lines, 0 deleted. Not ~160. (~160 is defensible if the shared
`recordingExecutor` helper is excluded from the count, but that reading is
inconsistent with the same paragraph's 2,346.) Non-load-bearing: the number that
feeds the 2× reclassify trigger is the total, and that one is exact — see §6.

---

## 5. Mutation ledger — 15 runs, 8 mutations, 8 kills

### P1-A — the dispatch ordering case · `src/lib/solicitation/dispatch.ts`

Baseline at HEAD: PASS.

| # | Mutation (scoped to `commitWithhold`'s body) | Result | Killing assertion |
|---|---|---|---|
| A1 | `writeRefusalEvent` hoisted to the TOP — round 1's exact mutation, re-planted | **killed** | `expected 14 to be greater than 23` (`:2632`) — the same failure string D0 records |
| A2 | `writeRefusalEvent` moved to the MIDDLE (after the terminal `UPDATE`, before `recordStep`) | **killed** | `expected 17 to be greater than 23` (`:2632`) |
| A3 | `completeRun` and `markOutboxCompletedIfOwned` swapped — two of the OTHER four writes | **killed** | `expected 20 to be greater than 21` (`:2631`, `outboxIndex > childTerminalIndex`) |
| A4 | Receiver changed: `pool: Sql` threaded through `runDispatchTx` → `commitWithhold`, ledger write issued on the POOLED client instead of `tx` | **killed** | `expected false to be true` (`:2609`, `ledgerQueries[0].onTransaction`) |
| A5 | `closeBatchIfSettled` hoisted to the top | **survived** → RT2-3 (arbiter: not meaningful for the tested claim) | |

All three claims D0 makes for this case are real, measured: receiver identity
(A4), the five-write order (A1/A2/A3), and `ledgerIndex === queries.length - 1`
(A1/A2).

### P1-B — the release-cycle alert path · `worker/background/pollers/SolicitationReleasePoller.ts`

Baseline at HEAD: PASS. Full file at HEAD: 9/9 pass.

| # | Mutation | Result | Killing assertion |
|---|---|---|---|
| B1 | Reverted to the pre-fix three-line body (no capture, no catch, no rethrow) | **killed** | `captureException … called 1 times, but got 0` (`:231`) — the same failure D0 records |
| B2 | Capture kept, `throw error` DELETED (the failure is swallowed) | **killed** | `loggerCalls.error … 1 times, but got 0` (`:240`) — the harness stops logging, and the case sees it |
| B3 | The inner `try {} catch {}` around the capture REMOVED (unguarded capture) | **killed** | `expected Error: sentry transport is down to be Error: refusal ledger rejected the halt w…` (`:270`) — telemetry-must-not-poison is genuinely pinned |
| B4 | `subsystem` tag value changed | **killed** | `toMatchObject` on `tags` (`:234`) |

---

## 6. Doc claims re-resolved against HEAD `426ccf77`

| Claim | Verdict |
|---|---|
| `dispatch.ts` is byte-identical to `e9a6a50b` | **TRUE.** `git diff --stat e9a6a50b..426ccf77 -- src/lib/solicitation/dispatch.ts` is empty; the blob is `3ee68e3cdd385059247ea9aab301f6b89052a5c2` at `e9a6a50b`, at `426ccf77`, and in the worktree |
| Both new titles exist verbatim in `tests_to_add` | **TRUE.** Byte-for-byte matches at `dispatch.integration.test.ts:2569` and `SolicitationReleasePoller.test.ts:216` |
| `estimated_test_lines` 1150 → 2346 | **TRUE.** `--numstat` over the 8 touched test files: 2,344 added + 2 deleted = **2,346** total changed test lines. The convention is added+deleted and the figure is exact |
| D6's "~160 test lines" added by the P1 fixes | **FALSE (RT2-4).** 246 added |
| D0's "restored, 34/34" and "restored, 9/9" | **TRUE.** 34 `it` blocks in `dispatch.integration.test.ts`, 9 in `SolicitationReleasePoller.test.ts`; the full poller file runs 9/9 green at HEAD |
| D0's P1-A re-proof "`expected 14 to be greater than 23`" | **TRUE.** Reproduced exactly (A1) |
| D0's P1-B re-proof "`captureException` called 0 times" | **TRUE.** Reproduced exactly (B1) |
| `guarded-poll.ts` is untouched | **TRUE.** Last touched by `90408e8d` (#414/#434), long before this branch; not in `06a163f0..426ccf77` |
| The single-flight flag still releases on the rethrown path | **TRUE.** `worker/background/guarded-poll.ts` `runOnce` releases in `finally { inFlight = false; }`, unconditionally, outside the `catch` — and the case's own next-tick assertion dies under B2 |
| The `recordingExecutor` docblock's "THIRD COPY", and `src/lib/shared/__tests__/helpers/` being off-surface | **TRUE.** Three copies (`dispatch.integration.test.ts:1012`, `batch-builder.integration.test.ts:603`, `approval.integration.test.ts:723`); the shared helpers directory is not in `allowed_edit_surface` |
| The docblock's "`latchSystemHalt` — reached only from `runReleaseCycle`'s `platform_halt` and `send_window_elapsed` paths — now writes a `batch_halted` Refusal" | **FALSE (RT2-1).** `send_window_elapsed` maps to `null` and writes nothing |
| The docblock's "`createGuardedPoll`'s shared catch emits `logger.error` alone" for this failure | **FALSE (RT2-1).** `isolateItem` → `recordItemFailure` already captures to Sentry, and contains the throw before the harness ever sees it |

The intake's `observability` array was **not** amended for the new signal. Its
second entry still reads "The admin halt lane is route-driven and surfaces as a
failed request" and says nothing about the poller-driven system halt — the very
lane P1-B is about. Supporting evidence for RT2-1/RT2-2, not a separate finding.

`prevalidate-plan.py` was **not** available at
`~/.claude/skills/grill-me-codex/scripts/`; every citation above was hand-checked
against HEAD and is recorded with its `path:line`.

## 7. Sibling search (duty 4)

**Pattern:** a background loop that reaches one of this branch's new
refusal-ledger write sites with no Sentry sink.

**Scope searched:** `rg -n "writeRefusalEvent|writeRefusalEvents" --glob '!**/__tests__/**' src/ worker/`,
then the caller chain of each hit; plus every `createGuardedPoll` consumer in
`worker/` (17 files).

**Result — zero siblings.** The four production write sites resolve to:
`suspension.ts:331` → `AutonomyGovernorScheduler` (has a capture, #1009);
`batch-builder.ts:661` → `worker/jobs/solicitation-batch/index.ts`, a BullMQ
worker covered by `attachJobFailureSink`; `dispatch.ts:1467` → the
`solicitation_send` BullMQ worker, same sink; `approval.ts:637` → the admin route
(surfaces as a failed request) and `latchSystemHalt` under the release poller
(covered by `isolateItem`'s capture — see RT2-1).

**Exclusion recorded:** the other 15 `createGuardedPoll` consumers have no
Sentry sink at all. That is pre-existing, unchanged by this branch, and a
property of `createGuardedPoll` rather than of these fix hunks — out of round 2's
scope and reported here only so the search's boundary is legible.

## 8. Round-1 findings, carried forward

| Id | Sev | Disposition at `426ccf77` | Note |
|---|---|---|---|
| RT-1 | P1 | **fixed** | Re-proved closed this round by A1-A4 |
| RT-2 | P1 | **rejected** | Verdict: the diagnosis was false — `src/lib/solicitation/release-phases.ts:96-107` already raised a Sentry issue for this failure, and `release-phases.ts:69-81` contains it before `runSolicitationReleaseCycle` can see it. Superseded by RT2-1 (signal half) and RT2-2 (rule-row half). **Must be listed in the PR's "Red-team findings rejected" section.** |
| RT-3 | P1 | **accepted-risk** (AUTH-1) | `vocabulary.ts`'s header; off every swarm branch's edit surface, carried on the orchestrator. **Must be listed in the PR's deferred-findings section.** |
| RT-4 | P2 | open | `beta-launch-alerting.md` attributes the disabled-ledger warning to `writeRefusalEvent` alone |
| RT-5 | P2 | open | `localeCompare` comparator vs a Postgres `ORDER BY` on a `uuid` column |
| RT-6 | P2 | open | `already_reviewed` has no producer |

Round 1's own inventory (39 rows, 18 killed, 21 `skipped-budget`) is **not**
re-asserted here: it was measured at `e9a6a50b` and is stale by construction.
Round 2's inventory covers round 2's scope only, and that coverage debt stands as
round 1 recorded it.

## 9. Inventory

| Id | Test | File | Outcome |
|---|---|---|---|
| RT2-INV-1 | `a dispatch withhold writes its refusal_events row after the outreach terminal, the child run and the receipt step` | `src/lib/solicitation/__tests__/dispatch.integration.test.ts` | killed |
| RT2-INV-2 | `a failing solicitation release cycle raises a Sentry issue and the poller still survives to its next tick` | `worker/background/pollers/__tests__/SolicitationReleasePoller.test.ts` | killed |
| RT2-INV-3 … RT2-INV-10 | the 8 pre-existing `SolicitationReleasePoller` cases | `worker/background/pollers/__tests__/SolicitationReleasePoller.test.ts` | excluded — see reason below |

The 8 pre-existing poller cases enter the inventory through direction A (the
file's shared `beforeEach` changed, and a module-level `vi.mock('@sentry/node')`
was added). They are **excluded** rather than mutated because their production
targets — `createGuardedPoll` and `getIntervalMs` — are untouched by the fix
hunks and sit outside round 2's scope, and because the `beforeEach` change is
purely additive (`mockReset()` placed *before* the existing
`mockResolvedValue(emptyReport())`) and so cannot neutralise them. Evidence
rather than assertion: the full file runs **9/9 green** at HEAD under the
isolated environment.

## Authorizations

| Id | Date | Findings | Approval |
|---|---|---|---|
| AUTH-1 | 2026-08-31 | RT-3 | Owner-authorized deferral, 2026-08-31. RT-3 is accepted as true. `src/lib/refusals/vocabulary.ts` is outside all three swarm edit surfaces by construction, and #1010 has spent both surface amendments, so it cannot be fixed on any swarm branch. Carried as a post-merge documentation sweep with the three sibling staleness findings under one sentence: the ledger now has two writers and its maps have callers. |

This section is RENDERED from `findings.json`'s `authorizations` array. It is
never parsed back out of the Markdown.

## Round-2 closure — the authorization link

RT-3 was moved to `accepted-risk` in `findings.json` when the owner authorized
the deferral, but no entry was written to the `authorizations` array and this
report was left saying `open` / "None." `red-team-status.mjs` refused the
`reviewed` transition on exactly that: "an accepted-risk finding must reference
an authorization". Both artifacts now carry AUTH-1 and agree.

Nothing else on this branch moved. The tree at `426ccf77` and the tree at HEAD
are identical outside these two report files, so this run's evidence was never
stale — only its adjudication was unrecorded.

## Round-2 closure — the revert, and both pins

Round 2 examined `426ccf77`. The commit after it, `c4bfa647`, **withdrew the
P1-B alert-path fix in full** on the owner's decision, because RT2-1 proved the
gap it was built for never existed. That is why `red-team-status.mjs` refused the
`reviewed` transition on three counts, all now closed:

1. *"an accepted-risk finding must reference an authorization"* — RT-3 was moved
   to `accepted-risk` but no `authorizations` entry was written. AUTH-1 now exists
   in both artifacts.
2. *"intake_sha256 does not match"* — the revert legitimately NARROWED the intake:
   it removed `worker/background/pollers/SolicitationReleasePoller.ts` and its test
   from `allowed_edit_surface`, and removed the poller title from `tests_to_add`.
   The pin is moved to the narrowed intake, `d8c75e21`.
3. *"the tree moved since 426ccf77fc2b"* — it moved by REMOVAL, not by addition.
   `head_sha` is re-pinned to `c4bfa647`.

**What the revert did to this report's scope.** Both poller files are now
**byte-identical to `origin/main`** (verified by object id, not by diff reading),
so this branch changes nothing there. Consequently:

* **RT2-1 (P0) and RT2-2 (P1) are `fixed` by REMOVAL.** Neither defect exists at
  HEAD, because the code that carried them is gone. Their reasons in
  `findings.json` carry the full trace.
* **Inventory rows RT2-INV-2 … RT2-INV-10** are all cases in
  `SolicitationReleasePoller.test.ts`. They describe mutation work against a file
  the branch no longer touches. They are left in place as the honest record of
  what round 2 ran; they are **not** evidence about HEAD's surface.
* **RT2-INV-1** (`dispatch.integration.test.ts`) is the one inventory row that
  still describes live branch code.
* No orphan was left behind: `docs/runbooks/beta-launch-alerting.md` is not among
  this branch's changed files, and no production file at HEAD emits the
  `solicitation_release` tag.

**No amendment was consumed by any of this.** `docs/reviews/**` is inside this
branch's `allowed_edit_surface`, and `surfaceAmendments` stays at 2.

**Residual risk, stated rather than hidden — this is the sharpest one on the
swarm.** Round 2's mutation work landed almost entirely on code that has since
been reverted. HEAD's live production surface — `src/lib/refusals/write.ts` and
the three `src/lib/solicitation/` write sites — was mutation-tested by **round 1
only**, and round 1 ended `INCOMPLETE_BUDGET` with **21 of 39 candidates unrun**
at the 30-run cap. The two-round cap is spent, so that coverage debt cannot be
paid on this branch. It is carried to the owner, not resolved here.

## Rebase — feat-1010-refusal-solicitation-singles onto `main` at `cfddfad4`

This branch was rebased after the closure section above was written. `main` had
advanced by one docs-only commit (#1040, WS8 Phase E) with **zero file overlap**
against this branch's surface, so the rebase was conflict-free.

Every commit SHA named above is therefore the **pre-rebase** form and no longer
resolves on the branch. The one that matters maps as
`c4bfa647` → `6f447b01`; the narrative is unchanged by the
rewrite because no content moved, only the parent chain.

`head_sha` is re-pinned to `6f447b01fdb903820af45eb076fa0485d70f1517`, the post-rebase HEAD. The
gate was re-run serially at that HEAD after this note landed.

## Amendment 3 — the fifth teardown, found after this report was written

The pre-push hook (`vitest --changed`) failed on
`src/lib/solicitation/__tests__/release.integration.test.ts`: the suite reaches
`latchHalt` via `runReleaseCycle` -> `isolateItem` -> `latchSystemHalt`, writes a
`platform_halt` Refusal, and its `afterAll` then deletes the businesses those
rows reference — `refusal_events_business_id_fkey`, no cascade.

**This report should have found it.** Duty 4 is missed siblings, and the branch's
own deviation D4 had already established the class ("a test that deletes a
location out from under a Refusal now has to say so") and fixed four files.
Neither round swept the remaining `DELETE FROM businesses` teardowns for it.
Round 2 compounded that by spending nearly its whole budget on
`SolicitationReleasePoller` code that `c4bfa647` then reverted in full.

The gate could not have caught it either: it runs only this branch's five own
promised integration suites, never the full live-DB lane that CI runs.

Fixed under owner-authorized surface amendment 3. The sweep the class owed is now
run and recorded in the deviations file (D7): five files match the predicate, and
the four unfixed ones are safe only because their halt reasons map to `null` in
`BATCH_HALTED_REFUSAL_CATEGORIES`.

`head_sha` -> `b2556c7a81b48dca3a310bc296656d31338cd461`
`intake_sha256` -> `735e4dfeaa3444521725005662ec81ae6ef0a6d8bb711849f618be42ed9563f9` (the surface gained the one test path)

**No round 3 was run.** The cap is spent, and this section is a record of a
defect found downstream of the report, not a new pass.
